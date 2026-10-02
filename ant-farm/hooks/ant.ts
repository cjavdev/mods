// Pure helpers: no `$`, so tests can call them directly.

import type { Agent, Deployment, Ev, PlanRow, Session } from '../types'

type Json = Record<string, any>

// `ant ... --format jsonl` prints one object per line.
export const parseLines = (stdout: string): Json[] => {
  const rows: Json[] = []
  for (const line of stdout.split('\n')) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try {
      rows.push(JSON.parse(text))
    } catch {
      // A line cut mid-write: the next read has it whole.
    }
  }
  return rows
}

const ms = (iso: unknown): number => (typeof iso === 'string' ? Date.parse(iso) || 0 : 0)

export const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

// claude-opus-5 reads opus-5.
export const shortModel = (id: string): string => id.replace(/^claude-/, '')

const asksForApproval = (tools: Json[]): boolean =>
  tools.some(
    tool =>
      tool.default_config?.permission_policy?.type === 'always_ask' ||
      (tool.type === 'mcp_toolset' && tool.default_config?.permission_policy?.type !== 'always_allow') ||
      (tool.configs ?? []).some((config: Json) => config.permission_policy?.type === 'always_ask'),
  )

export const toAgent = (raw: Json): Agent => ({
  id: String(raw.id),
  name: String(raw.name ?? ''),
  slug: slug(String(raw.name ?? '')),
  model: shortModel(String(raw.model?.id ?? raw.model ?? '')),
  version: Number(raw.version ?? 1),
  description: String(raw.description ?? ''),
  system: String(raw.system ?? '').slice(0, 600),
  tools: (raw.tools ?? []).length,
  mcp: (raw.mcp_servers ?? []).map((server: Json) => String(server.name)),
  skills: (raw.skills ?? []).length,
  isCoordinator: raw.multiagent != null,
  asks: asksForApproval(raw.tools ?? []),
  createdAt: ms(raw.created_at),
})

export const toSession = (raw: Json): Session => ({
  id: String(raw.id),
  title: String(raw.title ?? ''),
  status: String(raw.status ?? ''),
  agentId: String(raw.agent?.id ?? ''),
  agentName: String(raw.agent?.name ?? ''),
  environmentId: String(raw.environment_id ?? ''),
  createdAt: ms(raw.created_at),
  updatedAt: ms(raw.updated_at),
  activeSeconds: Number(raw.stats?.active_seconds ?? 0),
  outputTokens: Number(raw.usage?.output_tokens ?? 0),
  cost: Number(raw.usage?.list_cost?.amount ?? 0),
})

export const toDeployment = (raw: Json): Deployment => ({
  id: String(raw.id),
  name: String(raw.name ?? ''),
  status: String(raw.status ?? ''),
  pausedReason: raw.paused_reason?.type ?? null,
  agentId: String(raw.agent?.id ?? ''),
  environmentId: String(raw.environment_id ?? ''),
  cron: String(raw.schedule?.expression ?? ''),
  timezone: String(raw.schedule?.timezone ?? 'UTC'),
  lastRunAt: raw.schedule?.last_run_at ? ms(raw.schedule.last_run_at) : null,
  lastRunNote: '',
  upcoming: (raw.schedule?.upcoming_runs_at ?? []).map(ms),
  prompt: textOf(raw.initial_events?.[0]?.content).slice(0, 400),
})

// The text blocks of an event's content, joined.
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: Json) => (block?.type === 'text' ? String(block.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

// What a tool call is doing, in one line: the command, the path, the query.
export const inputLine = (input: unknown): string => {
  if (input == null || typeof input !== 'object') return ''
  const one = input as Json
  const lead = one.command ?? one.file_path ?? one.path ?? one.query ?? one.url ?? one.pattern
  const text = typeof lead === 'string' ? lead : JSON.stringify(input)
  return text.replace(/\s+/g, ' ').trim()
}

export const toEv = (raw: Json): Ev => {
  const type = String(raw.type ?? '')
  const usage = raw.model_usage ?? raw.usage ?? {}
  let text = ''
  if (type === 'agent.tool_use' || type === 'agent.mcp_tool_use' || type === 'agent.custom_tool_use') text = inputLine(raw.input)
  else if (type === 'agent.tool_result' || type === 'agent.mcp_tool_result') text = textOf(raw.content).slice(0, 400)
  else if (type === 'session.error') text = String(raw.error?.message ?? '')
  else text = textOf(raw.content)

  return {
    id: String(raw.id ?? ''),
    at: ms(raw.processed_at),
    type,
    thread: String(raw.session_thread_id ?? ''),
    agent: String(raw.agent_name ?? ''),
    name: String(raw.name ?? raw.stop_reason?.type ?? ''),
    text,
    permission: String(raw.evaluated_permission ?? ''),
    toolUseId: String(raw.tool_use_id ?? ''),
    isError: raw.is_error === true,
    outputTokens: Number(usage.output_tokens ?? 0),
    inputTokens:
      Number(usage.input_tokens ?? 0) +
      Number(usage.cache_read_input_tokens ?? 0) +
      Number(usage.cache_creation_input_tokens ?? 0),
    cost: usage.list_cost?.amount != null ? Number(usage.list_cost.amount) : -1,
  }
}

// "now", "42s", "12m", "5h", "3d", "6w".
export const ago = (span: number): string => {
  const s = Math.max(0, Math.floor(span / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  const d = Math.floor(h / 24)
  return d < 28 ? `${d}d` : `${Math.floor(d / 7)}w`
}

// "45s", "6m 15s", "2h 05m", "3d 4h": a countdown or a run's length.
export const span = (length: number): string => {
  const s = Math.max(0, Math.round(length / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

// Cents as dollars: $0.05, $12.40.
export const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`

export const compact = (tokens: number): string =>
  tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${+(tokens / 1000).toFixed(1)}k` : `${tokens}`

export const fit = (text: string, width: number): string =>
  text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`

const BLOCKS = ' ▁▂▃▄▅▆▇█'

// One block per value, scaled to the tallest.
export const spark = (values: number[]): string => {
  const top = Math.max(1, ...values)
  return values.map(v => (v <= 0 ? '·' : BLOCKS[Math.max(1, Math.round((v / top) * 8))])).join('')
}

// How many of `times` fall in each of `buckets` equal spans ending at `end`.
export const histogram = (times: number[], end: number, bucketMs: number, buckets: number): number[] => {
  const counts = new Array<number>(buckets).fill(0)
  for (const t of times) {
    const back = Math.floor((end - t) / bucketMs)
    if (back >= 0 && back < buckets) counts[buckets - 1 - back] = (counts[buckets - 1 - back] ?? 0) + 1
  }
  return counts
}

// A Raster's cells: little-endian u32 triplets, base64.
export type Cell = [glyph: string, fg: number, bg: number]
export const DEFAULT_COLOR = 0x01000000

export const pack = (cells: Cell[]): string => {
  const words = new Uint32Array(cells.length * 3)
  cells.forEach(([glyph, fg, bg], i) => {
    words[i * 3] = glyph.codePointAt(0) ?? 32
    words[i * 3 + 1] = fg
    words[i * 3 + 2] = bg
  })
  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

// The agent a typed name means: its slug, then a prefix, then any part of it.
export const findAgent = (agents: Agent[], typed: string): Agent | null => {
  const want = slug(typed)
  if (!want) return null
  return (
    agents.find(a => a.id === typed || a.slug === want) ??
    agents.find(a => a.slug.startsWith(want)) ??
    agents.find(a => a.slug.includes(want)) ??
    null
  )
}

// `ant apply --dry-run -v` prints one line per resource (`+ ./agents/x.md  create`)
// with the fields it would send indented beneath.
export const parsePlan = (text: string): PlanRow[] => {
  const rows: PlanRow[] = []
  const actions: Record<string, PlanRow['action']> = { create: 'create', update: 'update', delete: 'delete', archive: 'delete', unchanged: 'unchanged' }
  for (const line of text.split('\n')) {
    const head = /^(\S)\s(\S+)\s{2,}(\w+)(.*)$/.exec(line)
    if (head && head[2] !== 'Name') {
      const path = head[2] ?? ''
      rows.push({
        action: actions[head[3] ?? ''] ?? 'other',
        kind: /(\w+?)s?\/[^/]+$/.exec(path)?.[1] ?? '',
        name: path.replace(/^\.\//, ''),
        detail: (head[4] ?? '').trim() ? [(head[4] ?? '').trim()] : [],
      })
    } else if (rows.length > 0 && /^\s{4,}\S/.test(line)) {
      rows[rows.length - 1]?.detail.push(line.trim())
    }
  }
  return rows
}
