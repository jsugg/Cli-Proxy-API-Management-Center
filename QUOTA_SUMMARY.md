# Quota summaries

The quota page summarizes Claude and Codex observations already fetched by the existing adapters. No new endpoint, polling, account, routing rule or dependency is introduced. Provider subscription counts are unchanged.

Each row is an **unweighted mean of remaining percentages**, grouped by provider, limit ID and actual window duration. It is not pooled tokens or spendable capacity. Short, weekly, monthly and model-specific limits remain independent. Plans have no invented multipliers. Different accounts can have different reset times; the next reset is the earliest future reset among contributing observations, not the entire pool's reset.

Coverage is contributing credential observations divided by all enabled credentials for that provider, across every page and tab. Aliases for the same provider account cannot reliably be deduplicated with the current identity contract; this is a credential summary, not a unique-person count. Duplicate cache identities count once. Disabled credentials do not count. Unloaded, failed, refreshing, explicitly stale, future-dated, older-than-15-minute, invalid percentage, missing-duration and missing/expired-reset observations contribute no value. Zero contributors display Unknown, never zero or full. The minute clock expires old samples without extra provider calls. Refresh remains the existing explicit per-card/current-page action.

Codex now carries a browser receipt timestamp, like Claude. Neither is provider-certified observation time. Summaries require the current connection's successfully loaded credential list. Cache invalidation and request-generation guards are unchanged.

Emails embedded in quota card and timeline identities, tooltips, accessible labels and confirmation labels are masked by default. Show emails is explicit and stays in page memory only. It does not redact network payloads or secure browser storage, nor does it change credential names or mutation targets. Arbitrary filenames that contain personal information other than an email address are not anonymized.

## History and forecasts need backend work

The inspected v8 Management API provides credential listing and `/requests/api-call` for the existing provider probes, plus usage queues and logs. Its route contract does not provide durable quota observations. The existing timeline projects reset **schedules**, not recorded quota history or consumption forecasts. Token usage logs alone cannot reconstruct subscription utilization percentages.

Before adding recorded quota charts or a burn-rate forecast:

- Sample provider quota centrally with bounded concurrency, deadlines and backoff. Record server observation time, provider, stable account ID, limit/model ID, actual duration, reset instant, used percentage, plan metadata, source, stale/error state and schema version. Do not store credentials or email addresses as metric labels.
- Persist samples with explicit retention and bounded storage, isolate connections/accounts and deduplicate aliases. Serve a capability-gated, authenticated, time-range/pagination-bounded history API. Define this contract before frontend implementation; no speculative endpoint is called here.
- Split series at resets, plan/limit/duration changes, manual resets and missing-data gaps. A percentage decrease is not negative consumption. Unknown data is not interpolation or zero.
- Require at least three distinct successful samples over a meaningful declared lookback and minimum coverage before estimating slope. Report sample range, age, coverage and confidence. A constant-rate forecast must state that assumption, stay within a bounded horizon and incorporate independently scheduled resets without treating different plan quotas as fungible tokens.
- Keep recorded observations visually separate from projected values. Report exhaustion as unknown when samples, capacity calibration or stable window identity are insufficient. Browser-local samples must be labelled session-local, never hub-wide history.

## Verification fixture

The existing development-only `/#/__preview/quota-tiers` route renders real summary and quota-card components with synthetic data, including an email masking toggle. It requires no management key or backend. Production builds remove that route. Browser checks against this fixture do not validate live provider responses.
