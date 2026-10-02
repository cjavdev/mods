// Pure helpers: no `$`, so tests can call them directly.

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export const bar = (percent: number, width: number): { filled: string; empty: string } => {
  const n = Math.round((clamp(percent, 0, 100) / 100) * width)
  return { filled: '█'.repeat(n), empty: '░'.repeat(width - n) }
}

export const compact = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${+(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}k`
      : `${tokens}`
