import type { Mention } from '../types'

export type Kind = 'artifact' | 'pr'

// One link found in a message. `named` says the label came from the
// message's own markdown (`[UX picks](https://claude.ai/artifact/…)`).
export type Found = Mention & { kind: Kind; named: boolean }

const PR = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/
const ARTIFACT = /^https:\/\/claude\.ai\/(?:code\/artifact|artifact|public\/artifacts)\/([\w-]+)/
const URL_RE = /https:\/\/[^\s<>()[\]{}"'`|\\]+/g
const MD_LINK = /\[([^\]\n]{1,200})\]\((https:\/\/[^)\s]+)\)/g

const LABEL_MAX = 24

// Shortens a markdown label to fit the bar.
export const cut = (s: string, max = LABEL_MAX) => {
  const t = s.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

// What a URL is, its canonical form and the label drawn when the message
// gave it none: `mods#12` for a pull request, `artifact DhK2K2` for an artifact.
export const classify = (url: string): { kind: Kind; url: string; label: string } | null => {
  const pr = PR.exec(url)
  if (pr) return { kind: 'pr', url: pr[0], label: `${pr[2]}#${pr[3]}` }
  const art = ARTIFACT.exec(url)
  if (art) return { kind: 'artifact', url: art[0], label: `artifact ${(art[1] ?? '').slice(0, 6)}` }
  return null
}

// Every artifact and pull request link in a message, in the order written.
export const findMentions = (text: string): Found[] => {
  const labels = new Map<string, string>()
  for (const m of text.matchAll(MD_LINK)) {
    const c = classify(m[2] ?? '')
    const label = cut(m[1] ?? '')
    // A label that is just the URL again says nothing.
    if (c && c.kind === 'artifact' && label && !/^https?:/.test(label)) labels.set(c.url, label)
  }

  const out: Found[] = []
  for (const m of text.matchAll(URL_RE)) {
    const c = classify(m[0])
    if (!c) continue
    const named = labels.get(c.url)
    out.push({ kind: c.kind, url: c.url, label: named ?? c.label, named: named !== undefined })
  }
  return out
}

// Moves each found link to the front, the last one written ending up first,
// and keeps `max`. A link mentioned again without a label keeps the one it had.
export const remember = (list: readonly Mention[], found: readonly Found[], max: number): Mention[] => {
  let next = [...list]
  for (const f of found) {
    const prev = next.find(m => m.url === f.url)
    const label = !f.named && prev ? prev.label : f.label
    next = [{ url: f.url, label }, ...next.filter(m => m.url !== f.url)]
  }
  return next.slice(0, Math.max(0, max))
}

// The text a transcript row carries: a string, or its text blocks.
export const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('\n')
}

// The person's prompts and the model's replies in a transcript file's JSONL,
// oldest first; meta rows, tool results and subagent rows are left out.
export const transcriptTexts = (jsonl: string): string[] => {
  const out: string[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.startsWith('{')) continue
    let row: { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if ((row.type !== 'user' && row.type !== 'assistant') || row.isMeta || row.isSidechain) continue
    const text = textOf(row.message?.content)
    if (text) out.push(text)
  }
  return out
}
