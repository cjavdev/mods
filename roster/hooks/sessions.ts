import type { AgentSession, SessionEvent, SessionStatus } from '../types'

// Applied to the list envelope (`--format raw` skips auto-pagination, so one
// page of the newest sessions): keeps each session to the fields the pane draws
// instead of its whole agent snapshot, system prompt and all.
export const TRANSFORM =
  'data.#.{id,title,status,created_at,updated_at,deployment_id,' +
  '"agent_name":agent.name,"agent_version":agent.version,' +
  '"cost":usage.list_cost.amount,"cap":budget.max_list_cost.amount}'

export const listArgs = (limit: number, withTransform: boolean): string[] => [
  'beta:sessions',
  'list',
  '--limit',
  String(limit),
  '--format',
  'raw',
  ...(withTransform ? ['--transform', TRANSFORM] : []),
]

const STATUSES = new Set<SessionStatus>(['running', 'rescheduling', 'idle', 'terminated'])

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const time = (v: unknown): number => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : 0
}
const field = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((at, k) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[k] : undefined), o)

// One session from either the transformed shape or the API's full object.
export function toSession(raw: unknown): AgentSession | null {
  const id = str(field(raw, 'id'))
  const status = field(raw, 'status') as SessionStatus
  if (!id || !STATUSES.has(status)) return null
  return {
    id,
    title: str(field(raw, 'title')),
    status,
    agent: str(field(raw, 'agent_name')) ?? str(field(raw, 'agent', 'name')),
    agentVersion: num(field(raw, 'agent_version')) ?? num(field(raw, 'agent', 'version')),
    costCents: num(field(raw, 'cost')) ?? num(field(raw, 'usage', 'list_cost', 'amount')),
    capCents: num(field(raw, 'cap')) ?? num(field(raw, 'budget', 'max_list_cost', 'amount')),
    deploymentId: str(field(raw, 'deployment_id')),
    createdAt: time(field(raw, 'created_at')),
    updatedAt: time(field(raw, 'updated_at')),
  }
}

// `ant ... --format raw` prints the envelope, or the array the transform made
// of it; jsonl (one session per line) is read too.
export function parseSessions(stdout: string): AgentSession[] {
  const text = stdout.trim()
  if (text === '') return []
  let items: unknown[]
  try {
    const parsed: unknown = JSON.parse(text)
    items = Array.isArray(parsed) ? parsed : ((field(parsed, 'data') as unknown[] | undefined) ?? [parsed])
  } catch {
    items = text.split('\n').flatMap(line => {
      try {
        return [JSON.parse(line) as unknown]
      } catch {
        return []
      }
    })
  }
  return items.map(toSession).filter((s): s is AgentSession => s !== null)
}

export const isActive = (s: AgentSession) => s.status === 'running' || s.status === 'rescheduling'

// Running first, newest activity first within each group, as the agents view lists.
export function split(sessions: AgentSession[]) {
  const byRecent = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  return { active: byRecent.filter(isActive), recent: byRecent.filter(s => !isActive(s)) }
}

export const GLYPH: Record<SessionStatus, string> = {
  running: '●',
  rescheduling: '↻',
  idle: '○',
  terminated: '✕',
}

export const LABEL: Record<SessionStatus, string> = {
  running: 'running',
  rescheduling: 'retrying',
  idle: 'idle',
  terminated: 'ended',
}

export const fmtAge = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export const fmtCents = (c: number | null): string => (c === null ? '' : `$${(c / 100).toFixed(2)}`)

export const fit = (text: string, width: number): string => {
  if (width <= 0) return ''
  const chars = [...text]
  if (chars.length <= width) return text + ' '.repeat(width - chars.length)
  return chars.slice(0, Math.max(0, width - 1)).join('') + '…'
}

// Session ids go into a shell command line for the watch, so only plain ids pass.
export const isSessionId = (id: string) => /^[A-Za-z0-9_]{6,128}$/.test(id)

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// The background task's command: the session's event stream, cut down to the
// status changes worth a notification (each stdout line is one).
export const watchCommand = (ant: string, id: string): string =>
  [
    shellQuote(ant),
    'beta:sessions:events stream',
    '--session-id',
    id,
    '--format jsonl',
    '--transform',
    shellQuote('{type,"why":stop_reason.type}'),
    '| grep --line-buffered -E',
    shellQuote('"session\\.status_(idle|terminated|rescheduled)"'),
  ].join(' ')

export const EVENTS_TRANSFORM =
  'data.#.{id,type,processed_at,"text":content.0.text,name,input,' +
  '"why":stop_reason.type,result,"ids":stop_reason.event_ids,is_error}'

export const eventsArgs = (id: string, limit: number, withTransform: boolean): string[] => [
  'beta:sessions:events',
  'list',
  '--session-id',
  id,
  '--order',
  'desc',
  '--limit',
  String(limit),
  '--format',
  'raw',
  ...(withTransform ? ['--transform', EVENTS_TRANSFORM] : []),
]

export const sendArgs = (id: string, event: Record<string, unknown>): string[] => [
  'beta:sessions:events',
  'send',
  '--session-id',
  id,
  '--event',
  JSON.stringify(event),
]

const oneLine = (v: unknown): string | null => {
  if (v === undefined || v === null) return null
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim()
  const o = v as Record<string, unknown>
  for (const k of ['command', 'file_path', 'path', 'url', 'query', 'pattern']) {
    if (typeof o[k] === 'string') return oneLine(o[k])
  }
  return JSON.stringify(v)
}

const confirmation = (result: unknown) => (result === 'allow' ? 'allowed it' : result === 'deny' ? 'denied it' : null)

export function toEvent(raw: unknown): SessionEvent | null {
  const id = str(field(raw, 'id'))
  const type = str(field(raw, 'type'))
  if (!id || !type) return null
  const content = field(raw, 'content')
  const text = str(field(raw, 'text')) ?? str(field(content, '0', 'text')) ?? (Array.isArray(content) ? null : str(content))
  const ids = field(raw, 'ids') ?? field(raw, 'stop_reason', 'event_ids')
  return {
    id,
    type,
    at: time(field(raw, 'processed_at')),
    text: text ?? confirmation(field(raw, 'result')),
    name: str(field(raw, 'name')),
    input: oneLine(field(raw, 'input')),
    why: str(field(raw, 'why')) ?? str(field(raw, 'stop_reason', 'type')),
    ids: Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [],
    isError: field(raw, 'is_error') === true,
  }
}

// Listed newest first (`--order desc`); returned oldest first, as a transcript
// reads. Events in the same instant keep their listed order, reversed.
export function parseEvents(stdout: string): SessionEvent[] {
  const text = stdout.trim()
  if (text === '') return []
  let items: unknown[]
  try {
    const parsed: unknown = JSON.parse(text)
    items = Array.isArray(parsed) ? parsed : ((field(parsed, 'data') as unknown[] | undefined) ?? [])
  } catch {
    items = text.split('\n').flatMap(line => {
      try {
        return [JSON.parse(line) as unknown]
      } catch {
        return []
      }
    })
  }
  return items
    .reverse()
    .map(toEvent)
    .filter((e): e is SessionEvent => e !== null)
    .sort((a, b) => a.at - b.at)
}

// The tool calls the session waits on: the ids its last idle named, when it
// went idle for an approval.
export function pendingApprovals(events: SessionEvent[]): SessionEvent[] {
  const idle = [...events].reverse().find(e => e.type === 'session.status_idle' || e.type === 'session.status_running')
  if (!idle || idle.type !== 'session.status_idle' || idle.why !== 'requires_action') return []
  return idle.ids.map(
    id =>
      events.find(e => e.id === id) ?? { id, type: 'agent.tool_use', at: 0, text: null, name: 'tool', input: null, why: null, ids: [], isError: false },
  )
}

// The status a transcript ends in, for a session the roster has not listed.
export function lastStatus(events: SessionEvent[]): SessionStatus | null {
  const s = [...events].reverse().find(e => e.type.startsWith('session.status_'))
  const map: Record<string, SessionStatus> = {
    'session.status_running': 'running',
    'session.status_idle': 'idle',
    'session.status_rescheduled': 'rescheduling',
    'session.status_terminated': 'terminated',
  }
  return s ? (map[s.type] ?? null) : null
}

