export type Ttl = '5m' | '1h'

// Where the TTL came from: the transcript's cache_creation buckets, the
// setting, a model switch, a cache hit after a gap only 1h survives, or the
// 5m guess before any of those.
export type TtlSource = 'transcript' | 'setting' | 'model-switch' | 'observed' | 'assumed'

export type Clock = {
  // When the main thread's last request touched the cache (ms since epoch).
  lastAt: number
  // Tokens the next request re-sends: what a cold cache writes afresh.
  prefixTokens: number
  ttl: Ttl
  ttlSource: TtlSource
}

declare module 'claude-code' {
  interface PluginState {
    'cache-shot-clock': { clock: Clock | null; now: number }
  }
}
