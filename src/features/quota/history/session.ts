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
    const targetPages = Math.max(1, this.state.pages);
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
      capped: page.nextCursor !== null && pages >= HISTORY_MAX_PAGES,
    };
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
