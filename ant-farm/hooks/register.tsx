import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, Approval, Deployment, Ev, Feed, Fleet, Job, Plan } from '../types'
import { ago, findAgent, money, parseLines, parsePlan, span, toAgent, toDeployment, toEv, toSession } from './ant'
import { farmCells, farmStep, seedFarm } from './farm'
import type { Farm } from './farm'
import { C, agentView, approvalBand, askCard, bakeoffView, boardView, fleetView, jobsBand, planView, replayView, totals, tvView } from './views'

const fleet = atom({ plugin: 'ant-farm', key: 'fleet' } as const, null)
const now = atom({ plugin: 'ant-farm', key: 'now' } as const, 0)
const nav = atom({ plugin: 'ant-farm', key: 'nav' } as const, { view: 'fleet', agentId: '' })
const feeds = atom({ plugin: 'ant-farm', key: 'feeds' } as const, {})
const tv = atom({ plugin: 'ant-farm', key: 'tv' } as const, '')
const approvals = atom({ plugin: 'ant-farm', key: 'approvals' } as const, [])
const jobs = atom({ plugin: 'ant-farm', key: 'jobs' } as const, [])
const plan = atom({ plugin: 'ant-farm', key: 'plan' } as const, null)
const replay = atom({ plugin: 'ant-farm', key: 'replay' } as const, null)
const bakeoff = atom({ plugin: 'ant-farm', key: 'bakeoff' } as const, null)
const farmTick = atom({ plugin: 'ant-farm', key: 'farm' } as const, 0)
const asks = atom({ plugin: 'ant-farm', key: 'asks' } as const, {})

const PANE = { fleet: 'fleet', tv: 'tv', board: 'board', replay: 'replay', bakeoff: 'bakeoff', farm: 'farm' } as const
const DISPATCH = 'mcp__ant-farm__dispatch'
const ROSTER = 'mcp__ant-farm__agents'
// Files `ant apply` reads: an edit to one is worth a plan.
const CONFIG_FILE = /(^|\/)(agents|environments|deployments|memory_stores)\/[^/]+\.(md|ya?ml)$/
const PERSON = new Set(['composer', 'sdk', 'bridge'])
const FEED_CAP = 400

type Stream = { return: () => unknown }

const mem = {
  ant: 'ant',
  pollMs: 30_000,
  // The environment a new session runs in when its agent has never run.
  environment: '',
  // Cents a session started from here may spend before it pauses.
  budget: 100,
  isFetching: false,
  streams: new Map<string, Stream>(),
  // Sessions `/ask` keeps going, by agent id: a second ask continues the first.
  threads: new Map<string, string>(),
  nextJob: 1,
  replayTimer: null as { cancel: () => void } | null,
  farmTimer: null as { cancel: () => void } | null,
  farm: null as Farm | null,
}

async function ant($: EngineInterface, args: string[], timeoutMs = 45_000) {
  const ran = await $.process
    .run([mem.ant, ...args], { timeoutMs })
    .catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  const said = `${ran.stderr}\n${ran.stdout}`.trim()
  return { isOk: ran.exitCode === 0, rows: parseLines(ran.stdout), text: ran.stdout, error: ran.exitCode === 0 ? '' : said.split('\n').find(Boolean) ?? 'ant failed' }
}

// The whole fleet in three calls: agents, sessions, deployments.
async function refresh($: EngineInterface) {
  if (mem.isFetching) return
  mem.isFetching = true
  try {
    const [agents, sessions, deployments, runs, who] = await Promise.all([
      ant($, ['beta:agents', 'list', '--format', 'jsonl', '--max-items', '200']),
      ant($, ['beta:sessions', 'list', '--format', 'jsonl', '--max-items', '200']),
      ant($, ['beta:deployments', 'list', '--format', 'jsonl', '--max-items', '100']),
      ant($, ['beta:deployment-runs', 'list', '--format', 'jsonl', '--max-items', '100']),
      ant($, ['auth', 'status']),
    ])
    const at = await $.clock.now()
    const prev = await read($, fleet)
    const org = /Logged in to (\S+)/.exec(who.text)?.[1] ?? prev?.org ?? ''
    const next: Fleet = agents.isOk
      ? {
          org,
          agents: agents.rows.map(toAgent),
          sessions: sessions.rows.map(toSession),
          // A run started by hand never moves the schedule's own last run.
          deployments: deployments.rows.map(toDeployment).map(d => {
            const last = runs.rows.find(run => run.deployment_id === d.id)
            if (!last) return d
            const session = sessions.rows.find(row => row.id === last.session_id)
            const cost = session ? ` · ${money(Number(session.usage?.list_cost?.amount ?? 0))}` : ''
            return { ...d, lastRunAt: Date.parse(String(last.created_at)) || d.lastRunAt, lastRunNote: `${last.trigger_context?.type ?? 'run'}${last.error ? ' · failed' : cost}` }
          }),
          fetchedAt: at,
          error: null,
        }
      : { ...(prev ?? { org, agents: [], sessions: [], deployments: [] }), fetchedAt: at, error: agents.error }
    await update($, fleet, () => next)
  } finally {
    mem.isFetching = false
  }
}

const blankFeed = (sessionId: string, agentName: string, title: string, at: number): Feed => ({
  sessionId,
  agentName,
  title,
  status: 'connecting',
  events: [],
  draft: '',
  startedAt: at,
  outputTokens: 0,
  cost: 0,
  note: '',
})

// Folds a batch of raw events into a session's feed: its rows, its status,
// the text being typed, and any tool call waiting on a person.
async function ingest($: EngineInterface, sessionId: string, rows: Record<string, any>[]) {
  if (rows.length === 0) return
  // The text being typed: deltas add to it, and the message they were
  // building (or the end of its request) clears it.
  let typed = ''
  let isDraftOver = false
  const fresh: Ev[] = []
  for (const row of rows) {
    if (row.type === 'event_delta') typed += String(row.delta?.content?.text ?? '')
    else if (row.type === 'event_start') continue
    else {
      if (row.type === 'agent.message' || row.type === 'span.model_request_end') {
        isDraftOver = true
        typed = ''
      }
      fresh.push(toEv(row))
    }
  }

  let waiting: Ev[] = []
  await update($, feeds, all => {
    const feed = all[sessionId]
    if (!feed) return all
    const known = new Set(feed.events.map(ev => ev.id))
    const added = fresh.filter(ev => !known.has(ev.id))
    const events = [...feed.events, ...added].sort((a, b) => a.at - b.at).slice(-FEED_CAP)
    const answered = new Set(events.filter(ev => ev.type.endsWith('tool_result') || ev.type === 'user.tool_confirmation').map(ev => ev.toolUseId))
    waiting = events.filter(ev => ev.permission === 'ask' && !answered.has(ev.id))

    let status = feed.status
    for (const ev of added) {
      if (ev.type === 'session.status_running') status = 'running'
      else if (ev.type === 'session.status_idle') status = ev.name === 'requires_action' ? 'waiting' : 'idle'
      else if (ev.type === 'session.error') status = 'error'
      else if (ev.type === 'session.status_terminated' || ev.type === 'session.deleted') status = 'ended'
    }
    if (status === 'connecting' && events.length > 0) status = events.some(ev => ev.type === 'session.status_idle') ? 'idle' : 'running'
    if (status === 'waiting' && waiting.length === 0) status = 'running'

    const usage = events.filter(ev => ev.cost >= 0).at(-1)
    return {
      ...all,
      [sessionId]: {
        ...feed,
        events,
        status,
        draft: isDraftOver ? typed : feed.draft + typed,
        outputTokens: events.filter(ev => ev.type === 'span.model_request_end').reduce((sum, ev) => sum + ev.outputTokens, 0),
        cost: usage ? usage.cost : feed.cost,
      },
    }
  })

  const feed = (await read($, feeds))[sessionId]
  if (!feed) return
  await update($, approvals, list => {
    const others = list.filter(a => a.sessionId !== sessionId)
    const mine = waiting.map(
      (ev): Approval => ({ sessionId, eventId: ev.id, agentName: feed.agentName, title: feed.title, tool: ev.name, input: ev.text, at: ev.at }),
    )
    return mine.length === 0 && others.length === list.length ? list : [...others, ...mine]
  })
  if (fresh.some(ev => ev.type === 'session.status_idle' && ev.name !== 'requires_action')) await settle($, sessionId)
}

// Follows a session live: the stream first, so nothing sent after it opens
// is missed, then the history behind it.
async function follow($: EngineInterface, sessionId: string, agentName: string, title: string) {
  if (mem.streams.has(sessionId)) return
  const at = await $.clock.now()
  await update($, feeds, all => (all[sessionId] ? all : { ...all, [sessionId]: blankFeed(sessionId, agentName, title, at) }))

  const child = $.process.spawn({
    argv: [mem.ant, 'beta:sessions:events', 'stream', '--session-id', sessionId, '--format', 'jsonl', '--event-delta', 'agent.message'],
  })
  mem.streams.set(sessionId, child)
  void (async () => {
    let buffer = ''
    try {
      for await (const piece of child) {
        if (piece.stream !== 'stdout') continue
        buffer += piece.text
        const cut = buffer.lastIndexOf('\n')
        if (cut < 0) continue
        const rows = parseLines(buffer.slice(0, cut))
        buffer = buffer.slice(cut + 1)
        await ingest($, sessionId, rows)
      }
    } catch (err) {
      $.ui.log(`ant-farm: stream ${sessionId} ended (${String(err)})`, { to: 'debug' })
    }
    mem.streams.delete(sessionId)
  })()

  const past = await ant($, ['beta:sessions:events', 'list', '--session-id', sessionId, '--format', 'jsonl', '--max-items', String(FEED_CAP)])
  if (past.isOk) await ingest($, sessionId, past.rows)
  else await update($, feeds, all => (all[sessionId] ? { ...all, [sessionId]: { ...all[sessionId]!, status: 'error', note: past.error } } : all))
}

async function unfollow($: EngineInterface, sessionId: string) {
  mem.streams.get(sessionId)?.return()
  mem.streams.delete(sessionId)
}

const message = (text: string) => JSON.stringify({ type: 'user.message', content: [{ type: 'text', text }] })

async function send($: EngineInterface, sessionId: string, event: string) {
  const sent = await ant($, ['beta:sessions:events', 'send', '--session-id', sessionId, '--event', event, '--format', 'jsonl'])
  if (!sent.isOk) $.ui.toast(`ant-farm: ${sent.error}`)
  return sent.isOk
}

// A new cloud session for `agent`, followed from before its first message.
async function start($: EngineInterface, agent: Agent, text: string, title: string) {
  const all = await read($, fleet)
  const environment = all?.sessions.find(s => s.agentId === agent.id)?.environmentId || mem.environment
  if (!environment) return { error: `no environment known for ${agent.name}: set defaultEnvironment in /config` }
  const made = await ant($, [
    'beta:sessions', 'create',
    '--agent', agent.id,
    '--environment-id', environment,
    '--title', title.slice(0, 80),
    '--budget', JSON.stringify({ type: 'limit', max_list_cost: { amount: String(mem.budget), currency: 'USD' } }),
    '--format', 'jsonl',
  ])
  const sessionId = String(made.rows[0]?.id ?? '')
  if (!made.isOk || !sessionId) return { error: made.error || 'the session was not created' }
  await follow($, sessionId, agent.name, title)
  await send($, sessionId, message(text))
  return { sessionId }
}

// A followed session went idle: a dispatched job hands its answer back to
// Claude, and an `/ask` leaves its reply where Claude can read it.
async function settle($: EngineInterface, sessionId: string) {
  const feed = (await read($, feeds))[sessionId]
  if (!feed) return
  const lastUser = feed.events.map(ev => ev.type).lastIndexOf('user.message')
  const answer = feed.events
    .slice(lastUser + 1)
    .filter(ev => ev.type === 'agent.message')
    .map(ev => ev.text)
    .join('\n\n')
    .trim()
  const at = await $.clock.now()
  const all = await read($, jobs)
  const job = all.find(j => j.sessionId === sessionId && j.endedAt === null)
  if (job) {
    await update($, jobs, list => list.map(j => (j.id === job.id ? { ...j, endedAt: at, result: answer } : j)))
    $.ui.toast(`ж ${job.agentName} finished in ${span(at - job.startedAt)} (${money(feed.cost)})`)
    await $.prompt.submit({
      text: `The cloud agent "${job.agentName}" finished the job you dispatched (session ${sessionId}, ${span(at - job.startedAt)}, ${money(feed.cost)}). Its report:\n\n${answer || '(it sent no message)'}`,
    })
    return
  }
  // An ask's reply: Claude reads it too, as a row the person does not see.
  if ([...mem.threads.values()].includes(sessionId) && answer) {
    await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text: `The person asked their cloud agent "${feed.agentName}" a question with /ask. Its reply, for your reference:\n\n${answer}` }] } })
      .catch(() => undefined)
  }
}

// Puts a question to a cloud agent: the session `/ask` already has open with
// it, or a new one.
async function askAgent($: EngineInterface, agent: Agent, question: string) {
  const open = mem.threads.get(agent.id)
  if (open && (await read($, feeds))[open]) {
    await send($, open, message(question))
    return { sessionId: open }
  }
  const started = await start($, agent, question, `ask: ${question}`)
  if ('sessionId' in started) mem.threads.set(agent.id, started.sessionId)
  return started
}

async function watch($: EngineInterface, sessionId: string, agentName: string, title: string) {
  await follow($, sessionId, agentName, title)
  await update($, tv, () => sessionId)
  await $.ui.open({ id: PANE.tv, title: 'Session TV', columns: 72, focus: true })
}

async function confirm($: EngineInterface, approval: Approval, result: 'allow' | 'deny') {
  const event: Record<string, string> = { type: 'user.tool_confirmation', tool_use_id: approval.eventId, result }
  if (result === 'deny') event.deny_message = 'Denied from Claude Code.'
  const isSent = await send($, approval.sessionId, JSON.stringify(event))
  if (isSent) await update($, approvals, list => list.filter(a => a.eventId !== approval.eventId))
}

// `ant apply --dry-run`: what the files on disk would change in the cloud.
async function makePlan($: EngineInterface, paths: string[]) {
  const at = await $.clock.now()
  await update($, plan, (): Plan => ({ paths, rows: [], raw: '', ranAt: at, status: 'planning', note: '' }))
  // The short plan words an update as a diff; the long one lists every field
  // of a resource it would create.
  const [ran, full] = await Promise.all([ant($, ['apply', '--dry-run', ...paths], 60_000), ant($, ['apply', '--dry-run', '-v', ...paths], 60_000)])
  const raw = ran.text
  const fields = parsePlan(full.text)
  const rows = parsePlan(raw).map(row => (row.action === 'create' ? (fields.find(one => one.name === row.name) ?? row) : row))
  await update($, plan, (): Plan =>
    ran.isOk ? { paths, rows, raw, ranAt: at, status: 'ready', note: '' } : { paths, rows: [], raw, ranAt: at, status: 'error', note: ran.error },
  )
}

async function applyPlan($: EngineInterface) {
  const current = await read($, plan)
  if (!current || current.status !== 'ready') return
  await update($, plan, p => (p ? { ...p, status: 'applying' } : p))
  const ran = await ant($, ['apply', '--yes', ...current.paths], 120_000)
  const summary = ran.text.trim().split('\n').filter(Boolean).at(-1) ?? ''
  await update($, plan, p => (p ? { ...p, status: ran.isOk ? 'applied' : 'error', note: ran.isOk ? summary : ran.error } : p))
  if (ran.isOk) {
    $.ui.toast(`ж applied: ${summary}`)
    void refresh($)
  }
}

async function openReplay($: EngineInterface, sessionId: string, agentName: string, title: string, cost: number) {
  await update($, replay, () => ({ sessionId, title, agentName, events: [], cursor: 0, isPlaying: false, cost }))
  await $.ui.open({ id: PANE.replay, title: 'Flight recorder', columns: 100, focus: true })
  const past = await ant($, ['beta:sessions:events', 'list', '--session-id', sessionId, '--format', 'jsonl', '--max-items', '2000'], 60_000)
  const events = past.rows.map(toEv)
  const usage = events.filter(ev => ev.cost >= 0).at(-1)
  await update($, replay, r => (r?.sessionId === sessionId ? { ...r, events, cursor: Math.max(0, events.length - 1), cost: usage?.cost ?? r.cost } : r))
}

async function stepReplay($: EngineInterface, by: number) {
  await update($, replay, r => {
    if (!r) return r
    // Step between the events a row is drawn for, not the spans around them.
    let cursor = r.cursor
    const isRow = (ev: Ev | undefined) => !!ev && !ev.type.startsWith('span.') && !ev.type.endsWith('tool_result') && !ev.type.startsWith('session.thread_status')
    do cursor += by
    while (cursor > 0 && cursor < r.events.length - 1 && !isRow(r.events[cursor]))
    return { ...r, cursor: Math.max(0, Math.min(r.events.length - 1, cursor)) }
  })
}

async function playReplay($: EngineInterface) {
  const r = await read($, replay)
  if (!r) return
  mem.replayTimer?.cancel()
  mem.replayTimer = null
  if (r.isPlaying) {
    await update($, replay, prev => (prev ? { ...prev, isPlaying: false } : prev))
    return
  }
  await update($, replay, prev => (prev ? { ...prev, isPlaying: true, cursor: prev.cursor >= prev.events.length - 1 ? 0 : prev.cursor } : prev))
  mem.replayTimer = $.clock.every(220, async () => {
    await stepReplay($, 1)
    const at = await read($, replay)
    if (!at || at.cursor >= at.events.length - 1) {
      mem.replayTimer?.cancel()
      mem.replayTimer = null
      await update($, replay, prev => (prev ? { ...prev, isPlaying: false } : prev))
    }
  })
}

// Hands the flight record to Claude as a prompt of its own.
async function debugReplay($: EngineInterface) {
  const r = await read($, replay)
  if (!r) return
  const first = r.events[0]?.at ?? 0
  const record = r.events
    .filter(ev => !ev.type.startsWith('span.') || ev.isError)
    .map(ev => `+${span(ev.at - first)} ${ev.type}${ev.name ? ` ${ev.name}` : ''}${ev.isError ? ' ERROR' : ''} ${ev.text.replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n')
    .slice(0, 60_000)
  await $.prompt.submit({
    text: `Here is the flight record of the Managed Agents session ${r.sessionId} ("${r.title}", agent ${r.agentName}, ${money(r.cost)}). Read it and tell me where it wasted time or went wrong, and what you would change in the agent's system prompt or tools.\n\n${record}`,
  })
}

async function openFarm($: EngineInterface) {
  const all = await read($, fleet)
  if (!all) return
  const at = await $.clock.now()
  mem.farm = seedFarm(all, at)
  await $.ui.open({ id: PANE.farm, title: 'The farm', columns: 84 })
  mem.farmTimer?.cancel()
  mem.farmTimer = $.clock.every(140, async () => {
    if (!mem.farm) return
    const live = await read($, feeds)
    farmStep(mem.farm, Object.values(live))
    await update($, farmTick, n => (n + 1) % 1_000_000)
  })
}

export const register: Register = (on, options) => {
  // Off in /config: hook nothing at all.
  if (options.enabled === false) return

  mem.ant = String(options.antPath || 'ant')
  mem.pollMs = Math.max(5, Number(options.pollSeconds ?? 30)) * 1000
  mem.environment = String(options.defaultEnvironment ?? '')
  mem.budget = Math.max(1, Math.round(Number(options.sessionBudget ?? 1) * 100))

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'fleet', description: 'Mission control for your Claude Managed Agents', argumentHint: '[agent]' })
    await $.command.register({ name: 'tail', description: 'Watch a cloud session live and talk to it', argumentHint: '[session id or agent]' })
    await $.command.register({ name: 'ask', description: 'Ask one of your cloud agents; its reply lands in the transcript', argumentHint: '<agent> <question>' })
    await $.command.register({ name: 'antplan', description: 'Plan what `ant apply` would change', argumentHint: '[paths]' })
    await $.command.register({ name: 'board', description: 'Your scheduled deployments: what runs when' })
    await $.command.register({ name: 'replay', description: "A finished session's flight record", argumentHint: '<session id or agent>' })
    await $.command.register({ name: 'bakeoff', description: 'The same prompt to two agents, side by side', argumentHint: '<agent> <agent> <prompt>' })
    await $.command.register({ name: 'farm', description: 'Watch the colony at work' })

    await $.tool.register({
      name: 'agents',
      description: "Lists the person's Claude Managed Agents (cloud agents): name, model, what each is for, and how recently it ran.",
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'dispatch',
      description:
        "Hands a self-contained task to one of the person's Claude Managed Agents, which works on it in its own cloud sandbox while you carry on. Returns at once with a session id; the agent's report arrives later as a new message. The agent sees none of this conversation or the local files: put everything it needs in `task`.",
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'The agent, by name or id' },
          task: { type: 'string', description: 'The whole task, self-contained' },
        },
        required: ['agent', 'task'],
      },
    })

    await update($, now, () => Date.now())
    // A reload keeps the panes but drops the farm's timer: start it again.
    void refresh($).then(async () => {
      if ((await $.ui.panes()).some(pane => pane.id === PANE.farm)) await openFarm($)
    })
    $.clock.every(1000, async () => {
      const at = await $.clock.now()
      await update($, now, () => at)
      const all = await read($, fleet)
      if (!all || at - all.fetchedAt >= mem.pollMs) void refresh($)
    })
    return result
  })

  // The bar under the prompt: the colony at a glance.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const all = await read($, fleet)
    if (all === null) return next(e)
    const at = (await read($, now)) || Date.now()
    const sum = totals(all, at)
    const waiting = (await read($, approvals)).length
    const parts = [
      `ж ${all.agents.length} agents`,
      sum.live > 0 ? `● ${sum.live} live` : null,
      waiting > 0 ? `▲ ${waiting} waiting` : null,
      sum.today > 0 ? `${money(sum.today)} today` : null,
      sum.next ? `◷ ${sum.next.name.split(' ').slice(0, 2).join(' ')} in ${span(sum.next.at - at)}` : null,
    ].filter(Boolean)
    const tail = parts.join(' · ')
    return next({ ...e, props: { ...e.props, tail: e.props.tail ? `${e.props.tail} · ${tail}` : tail } })
  })

  on('command.run', { command: 'fleet' }, async ($, e) => {
    const all = await read($, fleet)
    const agent = e.args.trim() && all ? findAgent(all.agents, e.args.trim()) : null
    await update($, nav, () => (agent ? { view: 'agent', agentId: agent.id } : { view: 'fleet', agentId: '' }))
    await $.ui.open({ id: PANE.fleet, title: 'Fleet', columns: 92 })
    return { text: agent ? `Opened ${agent.name}.` : 'Mission control opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: 'fleet' }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const all = await read($, fleet)
    if (all === null) return <ui.Text dimColor>Asking ant for your agents…</ui.Text>
    const at = (await read($, now)) || Date.now()
    const where = await read($, nav)
    const width = e.props.bodyColumns
    if (where.view === 'agent') {
      return agentView(ui, all, where, at, width, {
        back: () => update($, nav, () => ({ view: 'fleet', agentId: '' })),
        tail: sessionId => {
          const s = all.sessions.find(one => one.id === sessionId)
          void watch($, sessionId, s?.agentName ?? '', s?.title ?? '')
        },
        replay: sessionId => {
          const s = all.sessions.find(one => one.id === sessionId)
          void openReplay($, sessionId, s?.agentName ?? '', s?.title ?? '', s?.cost ?? 0)
        },
      })
    }
    return fleetView(ui, all, at, width, e.viewport?.rows ?? 30, {
      open: agentId => update($, nav, () => ({ view: 'agent', agentId })),
      refresh: () => void refresh($),
    })
  })

  on('command.run', { command: 'tail' }, async ($, e) => {
    const all = await read($, fleet)
    const typed = e.args.trim()
    const agent = all && typed && !typed.startsWith('sesn_') ? findAgent(all.agents, typed) : null
    const session = typed.startsWith('sesn_')
      ? all?.sessions.find(s => s.id === typed)
      : all?.sessions.find(s => (agent ? s.agentId === agent.id : s.status === 'running')) ?? all?.sessions[0]
    const sessionId = session?.id ?? (typed.startsWith('sesn_') ? typed : '')
    if (!sessionId) return { text: 'No session to watch: give a session id or an agent name.' }
    await watch($, sessionId, session?.agentName ?? 'agent', session?.title ?? '')
    return { text: `Watching ${session?.agentName ?? sessionId}${session?.title ? `: ${session.title}` : ''}.` }
  })

  on('ui.render', { component: 'Pane', requestId: 'tv' }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const sessionId = await read($, tv)
    const feed = (await read($, feeds))[sessionId]
    if (!feed) return <ui.Text dimColor>Nothing on. /tail a session to watch it.</ui.Text>
    const at = (await read($, now)) || Date.now()
    return tvView(ui, feed, at, e.props.bodyColumns, e.viewport?.rows ?? 30, {
      say: text => {
        if (text.trim()) void send($, sessionId, message(text.trim()))
      },
      interrupt: () => void send($, sessionId, JSON.stringify({ type: 'user.interrupt' })),
      stop: () => {
        void unfollow($, sessionId)
        void $.ui.close({ id: PANE.tv })
      },
    })
  })

  // `/ask reviewer is this safe?`: a cloud agent answers in the transcript.
  on('command.run', { command: 'ask' }, async ($, e) => {
    const all = await read($, fleet)
    const [name = '', ...rest] = e.args.trim().split(/\s+/)
    const question = rest.join(' ')
    const agent = all ? findAgent(all.agents, name) : null
    if (!agent || !question) return { text: `Usage: /ask <agent> <question>. Agents: ${(all?.agents ?? []).slice(0, 8).map(a => a.slug).join(', ')}…` }

    const asked = await askAgent($, agent, question)
    if ('error' in asked) return { text: `ant-farm: ${asked.error}` }
    await update($, asks, all => ({ ...all, [e.args.trim()]: asked.sessionId }))
    return { text: `ask ${asked.sessionId} ${agent.name}: ${question}` }
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'ask' } }, async ($, e, next) => {
    const sessionId = /\bask (sesn_\w+) /.exec(e.props.text)?.[1] ?? (await read($, asks))[e.props.args.trim()]
    const feed = sessionId ? (await read($, feeds))[sessionId] : undefined
    if (!feed) return next(e)
    const question = e.props.args.trim().split(/\s+/).slice(1).join(' ')
    return askCard($.ui.resolve(e), feed, question, e.viewport?.columns ?? 100)
  })

  // `@reviewer is this safe?` typed as a prompt is the same ask.
  on('prompt.submit', async ($, e, next) => {
    const mention = /^@([\w-]+)\s+(\S[\s\S]*)$/.exec(e.text.trim())
    if (!mention || !PERSON.has(e.origin.kind)) return next(e)
    const all = await read($, fleet)
    const agent = all ? findAgent(all.agents, mention[1] ?? '') : null
    if (!agent) return next(e)
    const question = (mention[2] ?? '').trim().replace(/\s+/g, ' ')
    const args = `${agent.slug} ${question}`
    // A command cannot be run from inside the hook a prompt waits on, and the
    // engine skips this plugin's own command.run hook on a run it starts: so
    // the ask is made here, and the run only leaves the row its card draws in.
    $.clock.after(0, async () => {
      const asked = await askAgent($, agent, question)
      if ('error' in asked) return $.ui.toast(`ant-farm: ${asked.error}`)
      await update($, asks, all => ({ ...all, [args]: asked.sessionId }))
      await $.command.run({ command: 'ask', args }).catch(() => undefined)
    })
    return { drop: `ж sent to ${agent.name} in the cloud` }
  })

  on('tool.call', { tool: ROSTER }, async $ => {
    const all = await read($, fleet)
    const at = await $.clock.now()
    const roster = (all?.agents ?? []).map(a => {
      const last = all?.sessions.find(s => s.agentId === a.id)
      return `- ${a.name} (${a.model}${a.mcp.length ? `; mcp: ${a.mcp.join(', ')}` : ''}): ${a.description || a.system.split('\n')[0]} ${last ? `[last ran ${ago(at - last.updatedAt)} ago]` : '[never ran]'}`
    })
    return { result: roster.join('\n') || 'No agents.' }
  })

  on('tool.call', { tool: DISPATCH }, async ($, e) => {
    const all = await read($, fleet)
    const agent = all ? findAgent(all.agents, String(e.agent ?? '')) : null
    if (!agent) return { deny: `No cloud agent matches "${String(e.agent)}". Call the agents tool for the roster.` }
    const task = String(e.task ?? '')
    const started = await start($, agent, task, `dispatch: ${task}`)
    if ('error' in started) return { deny: started.error }
    const at = await $.clock.now()
    const job: Job = { id: mem.nextJob++, sessionId: started.sessionId, agentName: agent.name, task, startedAt: at, endedAt: null, result: '' }
    await update($, jobs, list => [...list, job].slice(-20))
    return {
      result: `Dispatched to ${agent.name} (session ${started.sessionId}). It is working in its cloud sandbox now; its report will arrive as a new message when it finishes. Carry on with other work, and do not wait or poll for it.`,
    }
  })

  // An edit to a file `ant apply` reads: plan it right away.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if ((e.tool === 'Edit' || e.tool === 'Write') && result.deny === undefined && !result.isError) {
      const path = String((e as Record<string, unknown>).file_path ?? '')
      const found = CONFIG_FILE.exec(path)
      if (found) void makePlan($, [path.slice(found.index + (found[1]?.length ?? 0))])
    }
    return result
  })

  on('command.run', { command: 'antplan' }, async ($, e) => {
    const paths = e.args.trim() ? e.args.trim().split(/\s+/) : []
    if (paths.length === 0) {
      const here = await $.fs.list('.').catch(() => [])
      for (const dir of ['agents', 'environments', 'deployments', 'memory_stores', 'skills']) {
        if (here.some(entry => entry.name === dir)) paths.push(dir)
      }
    }
    if (paths.length === 0) return { text: 'Nothing to plan: no agents/, environments/ or deployments/ folder here.' }
    void makePlan($, paths)
    return { text: `Planning ${paths.join(' ')}…` }
  })

  // Above the prompt: a cloud tool call waiting on you, a plan to apply, and
  // the jobs Claude has out in the cloud.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const ui = $.ui.resolve(e)
    const at = (await read($, now)) || Date.now()
    const width = e.props.bodyColumns
    const waiting = await read($, approvals)
    const current = await read($, plan)
    const running = await read($, jobs)
    const live = await read($, feeds)

    const parts = [
      approvalBand(ui, waiting, at, width, {
        allow: approval => void confirm($, approval, 'allow'),
        deny: approval => void confirm($, approval, 'deny'),
        watch: approval => void watch($, approval.sessionId, approval.agentName, approval.title),
      }),
      current && waiting.length === 0
        ? planView(ui, current, width, { apply: () => void applyPlan($), dismiss: () => update($, plan, () => null) })
        : null,
      jobsBand(ui, running, live, at, width),
    ].filter(Boolean)

    if (parts.length === 0) return below
    return (
      <ui.Box flexDirection="column">
        {below}
        {parts}
      </ui.Box>
    )
  })

  on('command.run', { command: 'board' }, async $ => {
    await $.ui.open({ id: PANE.board, title: 'Schedule', columns: 92 })
    return { text: 'Schedule board opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: 'board' }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const all = await read($, fleet)
    if (all === null) return <ui.Text dimColor>Asking ant for your deployments…</ui.Text>
    const at = (await read($, now)) || Date.now()
    const act = async (d: Deployment, verb: 'run' | 'pause' | 'unpause', question: string) => {
      const answer = await $.ui.ask(question, { header: 'Schedule', options: ['Yes', 'No'] }).catch(() => 'No')
      if (answer !== 'Yes') return
      const ran = await ant($, ['beta:deployments', verb, '--deployment-id', d.id, '--format', 'jsonl'])
      $.ui.toast(ran.isOk ? `ж ${d.name}: ${verb} done` : `ant-farm: ${ran.error}`)
      void refresh($)
    }
    return boardView(ui, all, at, e.props.bodyColumns, {
      run: d => void act(d, 'run', `Run “${d.name}” now? It starts a real session.`),
      toggle: d =>
        void act(d, d.status === 'active' ? 'pause' : 'unpause', d.status === 'active' ? `Pause “${d.name}”?` : `Unpause “${d.name}”? It will run on its schedule again.`),
    })
  })

  on('command.run', { command: 'replay' }, async ($, e) => {
    const all = await read($, fleet)
    const typed = e.args.trim()
    const agent = all && typed && !typed.startsWith('sesn_') ? findAgent(all.agents, typed) : null
    const session = typed.startsWith('sesn_')
      ? all?.sessions.find(s => s.id === typed)
      : all?.sessions.filter(s => (agent ? s.agentId === agent.id : true)).sort((a, b) => b.outputTokens - a.outputTokens)[0]
    const sessionId = session?.id ?? (typed.startsWith('sesn_') ? typed : '')
    if (!sessionId) return { text: 'No session to replay: give a session id or an agent name.' }
    void openReplay($, sessionId, session?.agentName ?? 'agent', session?.title ?? '', session?.cost ?? 0)
    return { text: `Flight record of ${session?.agentName ?? sessionId}${session?.title ? `: ${session.title}` : ''}.` }
  })

  on('ui.render', { component: 'Pane', requestId: 'replay' }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const r = await read($, replay)
    if (!r) return <ui.Text dimColor>Nothing loaded. /replay a session.</ui.Text>
    return replayView(ui, r, e.props.bodyColumns, e.viewport?.rows ?? 30, {
      step: by => void stepReplay($, by),
      play: () => void playReplay($),
      debug: () => void debugReplay($),
    })
  })

  on('command.run', { command: 'bakeoff' }, async ($, e) => {
    const all = await read($, fleet)
    const [first = '', second = '', ...rest] = e.args.trim().split(/\s+/)
    const prompt = rest.join(' ')
    const a = all ? findAgent(all.agents, first) : null
    const b = all ? findAgent(all.agents, second) : null
    if (!a || !b || !prompt) return { text: 'Usage: /bakeoff <agent> <agent> <prompt>' }
    await update($, bakeoff, () => ({ prompt, sessionIds: [], picked: '' }))
    await $.ui.open({ id: PANE.bakeoff, title: 'Bake-off', columns: 120, focus: true })
    const started = await Promise.all([a, b].map(agent => start($, agent, prompt, `bake-off: ${prompt}`)))
    const failed = started.find(one => 'error' in one)
    if (failed && 'error' in failed) return { text: `ant-farm: ${failed.error}` }
    await update($, bakeoff, prev => (prev ? { ...prev, sessionIds: started.flatMap(one => ('sessionId' in one ? [one.sessionId] : [])) } : prev))
    return { text: `Bake-off: ${a.name} vs ${b.name}.` }
  })

  on('ui.render', { component: 'Pane', requestId: 'bakeoff' }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const current = await read($, bakeoff)
    if (!current) return <ui.Text dimColor>No bake-off yet. /bakeoff two agents and a prompt.</ui.Text>
    const at = (await read($, now)) || Date.now()
    return bakeoffView(ui, current, await read($, feeds), at, e.props.bodyColumns, e.viewport?.rows ?? 30, {
      pick: sessionId => update($, bakeoff, prev => (prev ? { ...prev, picked: sessionId } : prev)),
    })
  })

  on('command.run', { command: 'farm' }, async $ => {
    await openFarm($)
    return { text: 'The farm is open.' }
  })

  on('ui.render', { component: 'Pane', requestId: 'farm' }, async ($, e) => {
    const ui = $.ui.resolve(e)
    await read($, farmTick)
    if (e.surface !== 'terminal' || !mem.farm) return <ui.Text dimColor>The farm draws in the terminal. Run /farm.</ui.Text>
    const { Box, Text, Raster } = $.ui.resolve(e)
    const columns = Math.max(40, Math.min(120, e.props.bodyColumns))
    const rows = Math.max(12, Math.min(40, (e.viewport?.rows ?? 30) - 8))
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={C.ant} bold>{'ж the farm'}</Text>
          <Text dimColor>{`   ${mem.farm.chambers.length} chambers · ${mem.farm.ants.length} ants out · every ant is a tool call`}</Text>
        </Box>
        <Raster key="soil" columns={columns} rows={rows} cells={farmCells(mem.farm, columns, rows)} />
      </Box>
    )
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE.farm) {
      mem.farmTimer?.cancel()
      mem.farmTimer = null
    }
    return next(e)
  })
}
