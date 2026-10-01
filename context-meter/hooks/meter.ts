// Pure helpers: no `$`, so tests can call them directly.

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export const hslToHex = (h: number, s: number, l: number): string => {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * c).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

// Hue 120 (green) at 0% down to 0 (red) at 100%: yellow at half full,
// orange at three quarters. Auto-compact usually fires before 100%, so the
// last stretch is already near red.
export const colorFor = (percent: number): string =>
  hslToHex(120 * (1 - clamp(percent, 0, 100) / 100), 0.85, 0.5)

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
