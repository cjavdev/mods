// Pure helpers: no `$`, so tests can call them directly.

import type { Ttl } from '../types'

export const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// What the next request re-sends: everything this one was answered over plus
// what it generated. On a cold cache all of it is written afresh.
export const prefixOf = (u: Usage): number =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens

// The TTL the newest cache write used, from the tail of a session transcript
// (JSONL). Each assistant row's usage carries
// "cache_creation":{"ephemeral_1h_input_tokens":N,"ephemeral_5m_input_tokens":M};
// a row that wrote nothing says nothing, so the last row that wrote decides.
export const ttlFromTranscript = (tail: string): Ttl | null => {
  let found: Ttl | null = null
  for (const m of tail.matchAll(/"cache_creation":\{([^}]*)\}/g)) {
    const body = m[1] ?? ''
    const oneHour = Number(/"ephemeral_1h_input_tokens":(\d+)/.exec(body)?.[1] ?? 0)
    const fiveMin = Number(/"ephemeral_5m_input_tokens":(\d+)/.exec(body)?.[1] ?? 0)
    if (oneHour > 0) found = '1h'
    else if (fiveMin > 0) found = '5m'
  }
  return found
}

// m:ss (a full hour reads 60:00), or h:mm:ss past it.
export const fmtClock = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = total > 3600 ? Math.floor(total / 3600) : 0
  const m = Math.floor((total - h * 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

// "45s", "3m", "1h 5m": how long the cache has been cold.
export const fmtAgo = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export const compact = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${+(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}k`
      : `${tokens}`

// What the shot clock reads, as an arena clock would: m:ss above a minute,
// whole seconds below it, tenths in the last ten, 0.0 at the buzzer.
export const fmtShot = (ms: number): string => {
  if (ms <= 0) return '0.0'
  if (ms <= 10_000) return (Math.ceil(ms / 100) / 10).toFixed(1)
  const total = Math.ceil(ms / 1000)
  return total >= 60 ? fmtClock(ms) : String(total)
}

// A three-row seven-segment font in half blocks.
const FONT: Record<string, readonly [string, string, string]> = {
  '0': ['█▀█', '█ █', '▀▀▀'],
  '1': ['  █', '  █', '  ▀'],
  '2': ['▀▀█', '█▀▀', '▀▀▀'],
  '3': ['▀▀█', ' ▀█', '▀▀▀'],
  '4': ['█ █', '▀▀█', '  ▀'],
  '5': ['█▀▀', '▀▀█', '▀▀▀'],
  '6': ['█▀▀', '█▀█', '▀▀▀'],
  '7': ['▀▀█', '  █', '  ▀'],
  '8': ['█▀█', '█▀█', '▀▀▀'],
  '9': ['█▀█', '▀▀█', '▀▀▀'],
  ':': [' ', '▀', '▀'],
  '.': [' ', ' ', '▀'],
}

// `text` drawn three rows tall, one column between glyphs.
export const bigDigits = (text: string): [string, string, string] => {
  const glyphs = [...text].map(ch => FONT[ch] ?? FONT['0']!)
  return [0, 1, 2].map(row => glyphs.map(g => g[row]).join(' ')) as [string, string, string]
}
