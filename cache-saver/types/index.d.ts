export type Ttl = '5m' | '1h'

// The main thread's cache as last seen.
export type Cache = {
  // When the main prefix was last read or written (ms since epoch).
  lastAt: number
  // Tokens the next request re-sends: what a cold cache writes afresh.
  prefixTokens: number
  ttl: Ttl
  // Counts main-thread responses, so one idle stretch gets one summary.
  step: number
}

// The A/B choice: built while the cache is warm, offered once it is cold.
export type Offer = {
  // armed: B was picked and `/compact` waits in the prompt box for Enter.
  status: 'preparing' | 'ready' | 'armed' | 'compacting'
  // The `Cache.step` it summarizes; a newer response makes it stale.
  step: number
  summary: string
  summaryTokens: number
  fullTokens: number
  // A prompt typed before choosing, sent once the choice is made.
  held: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'cache-saver': { cache: Cache | null; offer: Offer | null; now: number }
  }
}
