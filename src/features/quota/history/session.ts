import { UnsupportedQuotaHistory } from '@/services/api/quotaHistory';
import type {
  HistoryProvider,
  QuotaHistoryCapabilities,
  QuotaHistoryClient,
  QuotaHistoryQuery,
  QuotaHistorySample,
} from './types';

export const HISTORY_MAX_PAGES = 12;
/** Floor for automatic refreshes; the collector's own poll interval is used when longer. */
export const HISTORY_REFRESH_MS = 60_000;
export const HISTORY_MAX_RANGE_MS = 7 * 86_400_000;
/**
 * Incremental refreshes re-read this much of the previous range: a collector cycle can
 * persist observations stamped slightly before the last read finished.
 */
export const HISTORY_REFRESH_OVERLAP_MS = 15 * 60_000;

export interface QuotaHistoryState {
  status: 'loading' | 'ready' | 'unsupported' | 'error';
  busy: boolean;
  capabilities: QuotaHistoryCapabilities | null;
  samples: QuotaHistorySample[];
  from: number;
  to: number;
  pages: number;
  nextCursor: string | null;
  complete: boolean;
  capped: boolean;
  /** The latest refresh failed; the samples shown are from the previous success. */
  refreshFailed: boolean;
}

interface HistorySessionOptions {
  client: QuotaHistoryClient;
  provider?: HistoryProvider;
  rangeMs: number;
  isCurrent: () => boolean;
  now?: () => number;
  /** Page budget per load; defaults to HISTORY_MAX_PAGES. */
  maxPages?: number;
  /** Follow every cursor up to `maxPages` instead of waiting for Load more. */
  loadAll?: boolean;
  /** Refresh a complete snapshot by reading only the newest observations. */
  incremental?: boolean;
}

const sampleKey = (sample: QuotaHistorySample): string =>
  JSON.stringify([
    sample.provider,
    sample.accountId,
    sample.authIndex,
    sample.limitId,
    sample.periodSeconds,
    sample.seriesId,
    sample.observedAt,
    sample.state,
    sample.usedPercent,
    sample.resetAt,
  ]);

/** Merge overlapping reads; identical observations collapse, order stays chronological. */
export function mergeHistorySamples(
  previous: readonly QuotaHistorySample[],
  next: readonly QuotaHistorySample[],
  from: number
): QuotaHistorySample[] {
  const merged = new Map<string, QuotaHistorySample>();
  for (const sample of [...previous, ...next]) {
    if (sample.observedAt >= from) merged.set(sampleKey(sample), sample);
  }
  return [...merged.values()].sort((a, b) => a.observedAt - b.observedAt);
}

export const initialHistoryState = (): QuotaHistoryState => ({
  status: 'loading',
  busy: false,
  capabilities: null,
  samples: [],
  from: 0,
  to: 0,
  pages: 0,
  nextCursor: null,
  complete: false,
  capped: false,
  refreshFailed: false,
});

/** Own one connection/filter range. All pages share filters; disposal invalidates every response. */
export class QuotaHistorySession {
  private state = initialHistoryState();
  private listeners = new Set<() => void>();
  private disposed = false;
  private pending = false;
  private abort: AbortController | null = null;
  private query: QuotaHistoryQuery | null = null;
  private cursors = new Set<string>();

  constructor(private readonly options: HistorySessionOptions) {
    if (
      !Number.isFinite(options.rangeMs) ||
      options.rangeMs <= 0 ||
      options.rangeMs > HISTORY_MAX_RANGE_MS
    ) {
      throw new Error('Invalid quota history range');
    }
  }

  getSnapshot = (): QuotaHistoryState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private current(): boolean {
    return !this.disposed && this.options.isCurrent();
  }
  private publish(state: QuotaHistoryState): void {
    if (!this.current()) return;
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }

  async refresh(): Promise<void> {
    if (this.pending || !this.current()) return;
    this.pending = true;
    this.abort = new AbortController();
    const targetPages = this.options.loadAll ? this.maxPages : Math.max(1, this.state.pages);
    const previous = this.state.status === 'ready' ? this.state : null;
    const previousQuery = this.query;
    const previousCursors = new Set(this.cursors);
    // Keep the last chart on screen while revalidating instead of flashing a loading state.
    this.publish(previous ? { ...previous, busy: true } : { ...initialHistoryState(), busy: true });
    try {
      const capabilities = await this.options.client.capabilities(this.abort.signal);
      if (!this.current()) return;
      if (this.options.provider && !capabilities.providers.includes(this.options.provider)) {
        throw new UnsupportedQuotaHistory();
      }
      const to = (this.options.now ?? Date.now)();
      this.query = {
        from: to - Math.min(this.options.rangeMs, capabilities.maxQueryDays * 86400000),
        to,
        provider: this.options.provider,
        limit: Math.min(capabilities.maxPageSize, 2000),
      };
      this.cursors.clear();
      if (
        this.options.incremental &&
        previous?.complete &&
        this.query.from >= previous.from &&
        previous.to > this.query.from
      ) {
        const delta = await this.readDelta(this.query, previous.to, capabilities);
        if (!this.current()) return;
        if (delta) {
          this.publish(delta);
          return;
        }
        this.cursors.clear();
      }
      let state: QuotaHistoryState = {
        ...initialHistoryState(),
        ...this.query,
        capabilities,
        busy: true,
      };
      for (let page = 0; page < targetPages; page++) {
        state = await this.readPage(state);
        if (!this.current()) return;
        if (state.nextCursor === null) break;
      }
      this.publish({ ...state, status: 'ready', busy: false });
    } catch (error) {
      if (previous && !(error instanceof UnsupportedQuotaHistory)) {
        this.query = previousQuery;
        this.cursors = previousCursors;
        this.publish({ ...previous, busy: false, refreshFailed: true });
      } else {
        this.fail(error);
      }
    } finally {
      this.pending = false;
    }
  }

  async loadMore(): Promise<void> {
    if (
      this.pending ||
      !this.current() ||
      this.state.status !== 'ready' ||
      !this.state.nextCursor ||
      this.state.capped
    )
      return;
    this.pending = true;
    this.abort = new AbortController();
    this.publish({ ...this.state, busy: true });
    try {
      const state = await this.readPage(this.state);
      this.publish({ ...state, busy: false });
    } catch (error) {
      this.fail(error);
    } finally {
      this.pending = false;
    }
  }

  private async readPage(state: QuotaHistoryState): Promise<QuotaHistoryState> {
    if (!this.current() || !this.query)
      throw new DOMException('Stale history request', 'AbortError');
    const page = await this.options.client.page(
      { ...this.query, ...(state.nextCursor ? { cursor: state.nextCursor } : {}) },
      this.abort?.signal
    );
    if (page.nextCursor !== null) {
      if (this.cursors.has(page.nextCursor)) throw new Error('Repeated quota history cursor');
      this.cursors.add(page.nextCursor);
    }
    const pages = state.pages + 1;
    return {
      ...state,
      pages,
      samples: [...state.samples, ...page.samples],
      nextCursor: page.nextCursor,
      complete: page.nextCursor === null,
      capped: page.nextCursor !== null && pages >= this.maxPages,
    };
  }

  private get maxPages(): number {
    return this.options.maxPages ?? HISTORY_MAX_PAGES;
  }

  /** Read only observations newer than the previous snapshot; null asks for a full reload. */
  private async readDelta(
    range: QuotaHistoryQuery,
    previousTo: number,
    capabilities: QuotaHistoryCapabilities
  ): Promise<QuotaHistoryState | null> {
    const full = this.query;
    this.query = { ...range, from: Math.max(range.from, previousTo - HISTORY_REFRESH_OVERLAP_MS) };
    try {
      let delta: QuotaHistoryState = { ...initialHistoryState(), capabilities, busy: true };
      do {
        delta = await this.readPage(delta);
        if (!this.current()) return null;
      } while (delta.nextCursor !== null && !delta.capped);
      if (!delta.complete) return null;
      const samples = mergeHistorySamples(this.state.samples, delta.samples, range.from);
      // Rolling snapshots must keep the same memory bound as a full load.
      if (samples.length > this.maxPages * Math.min(capabilities.maxPageSize, 2000)) return null;
      return {
        ...this.state,
        capabilities,
        samples,
        from: range.from,
        to: range.to,
        status: 'ready',
        busy: false,
        refreshFailed: false,
      };
    } finally {
      this.query = full;
    }
  }

  private fail(error: unknown): void {
    this.publish({
      ...initialHistoryState(),
      status: error instanceof UnsupportedQuotaHistory ? 'unsupported' : 'error',
    });
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    this.listeners.clear();
  }
}
