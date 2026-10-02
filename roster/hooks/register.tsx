import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { AgentSession, SessionEvent, SessionView } from '../types'
import {
  GLYPH,
  LABEL,
  eventsArgs,
  fit,
  fmtAge,
  fmtCents,
  isSessionId,
  lastStatus,
  listArgs,
  parseEvents,
  parseSessions,
  pendingApprovals,
  sendArgs,
  split,
  watchCommand,
} from './sessions'

const list = atom({ plugin: 'roster', key: 'list' } as const, {
  sessions: [],
  loadedAt: 0,
  isLoading: false,
  error: null,
})
const selected = atom({ plugin: 'roster', key: 'selected' } as const, null)
const watching = atom({ plugin: 'roster', key: 'watching' } as const, {})
const now = atom({ plugin: 'roster', key: 'now' } as const, 0)
const views = atom({ plugin: 'roster', key: 'views' } as const, {})
// The session the pane shows instead of the list, if any.
const viewing = atom({ plugin: 'roster', key: 'viewing' } as const, null)

const EMPTY_VIEW: SessionView = { events: [], loadedAt: 0, isLoading: false, error: null, sent: null }
const EVENT_LIMIT = 60

const PANE = 'roster'
const TITLE = 'Roster'

const STATUS_COLOR = { running: 'green', rescheduling: 'yellow', idle: undefined, terminated: 'red' } as const

const mem = {
  ant: 'ant',
  limit: 50,
  refreshMs: 15_000,
  watchMs: 30 * 60_000,
  isOpen: false,
  tick: null as unknown,
  // What's typed in each view's message box, so a redraw keeps it and a send clears it.
  drafts: {} as Record<string, string>,
}

const antError = (out: { exitCode: number; stderr: string }) =>
  out.stderr.trim().split('\n').at(-1) || `ant exited with ${out.exitCode}`
const CANT_RUN = () => `Couldn't run \`${mem.ant}\`. Install the ant CLI and run \`ant auth login\`, or set its path in /config.`

async function load($: EngineInterface) {
  await update($, list, f => ({ ...f, isLoading: true }))
  const run = (withTransform: boolean) =>
    $.process.run([mem.ant, ...listArgs(mem.limit, withTransform)], { timeoutMs: 30_000 })

  let error: string | null = null
  let sessions: AgentSession[] | null = null
  try {
    let out = await run(true)
    // An ant too old for this transform still lists; the pane reads the full objects.
    if (out.exitCode !== 0 && /transform|gjson/i.test(out.stderr)) out = await run(false)
    if (out.exitCode === 0) sessions = parseSessions(out.stdout)
    else error = antError(out)
  } catch {
    error = CANT_RUN()
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await update($, list, f => ({
    sessions: sessions ?? f.sessions,
    loadedAt: sessions ? at : f.loadedAt,
    isLoading: false,
    error,
  }))
  if (sessions && mem.isOpen && !(await read($, viewing))) {
    void $.ui.open({ id: PANE, title: TITLE, closeOnEscape: true, rows: sessions.length + 11, columns: 84 }).catch(() => undefined)
  }
  await update($, selected, id => (sessions && !sessions.some(s => s.id === id) ? (split(sessions).active[0] ?? sessions[0])?.id ?? null : id))
}

async function openPane($: EngineInterface) {
  await update($, viewing, () => null)
  mem.isOpen = true
  await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true, rows: 14, columns: 84 })
  void load($)
  startTick($)
}

function startTick($: EngineInterface) {
  if (mem.tick || mem.refreshMs <= 0) return
  mem.tick = $.clock.every(mem.refreshMs, () => {
    if (!mem.isOpen) return
    void read($, viewing).then(id => (id ? loadView($, id) : load($)))
  })
}

async function setView($: EngineInterface, id: string, fn: (v: SessionView) => SessionView) {
  await update($, views, all => ({ ...all, [id]: fn(all[id] ?? EMPTY_VIEW) }))
}

async function loadView($: EngineInterface, id: string) {
  await setView($, id, v => ({ ...v, isLoading: true }))
  const run = (withTransform: boolean) =>
    $.process.run([mem.ant, ...eventsArgs(id, EVENT_LIMIT, withTransform)], { timeoutMs: 30_000 })
  let events: SessionEvent[] | null = null
  let error: string | null = null
  try {
    let out = await run(true)
    if (out.exitCode !== 0 && /transform|gjson/i.test(out.stderr)) out = await run(false)
    if (out.exitCode === 0) events = parseEvents(out.stdout)
    else error = antError(out)
  } catch {
    error = CANT_RUN()
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await setView($, id, v => ({ ...v, events: events ?? v.events, loadedAt: events ? at : v.loadedAt, isLoading: false, error }))
}

// Shows one session in the roster's pane: its transcript, a box to message
// it, and its approvals. The same pane, so it keeps the keyboard the person
// gave the roster (a second pane can't take it from them).
async function openView($: EngineInterface, id: string) {
  if (!isSessionId(id)) return
  await update($, selected, () => id)
  await update($, viewing, () => id)
  if ((await read($, list)).loadedAt === 0) await load($)
  const s = (await read($, list)).sessions.find(one => one.id === id)
  const title = `${TITLE} › ${fit(s?.title ?? s?.agent ?? id, 40).trimEnd()}`
  mem.isOpen = true
  await $.ui.open({ id: PANE, title, focus: true, closeOnEscape: true, rows: 24, columns: 84 })
  startTick($)
  await loadView($, id)
  // The row the person pressed is gone from the drawing: put the ring on what
  // the session needs from them, an approval, else the message box.
  const v = (await read($, views))[id]
  const ended = (v && lastStatus(v.events)) === 'terminated' || s?.status === 'terminated'
  const key = v && pendingApprovals(v.events).length > 0 ? 'allow' : ended ? 'back' : 'message'
  void $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

async function backToList($: EngineInterface) {
  const id = await read($, viewing)
  await update($, viewing, () => null)
  const f = await read($, list)
  await $.ui.open({ id: PANE, title: TITLE, closeOnEscape: true, rows: f.sessions.length + 11, columns: 84 })
  if (id) void $.ui.focus({ requestId: PANE, key: `row:${id}` }).catch(() => undefined)
  void load($)
}

// Sends one event to the session (a message, an interrupt, an approval), then reloads it.
async function send($: EngineInterface, id: string, event: Record<string, unknown>, done: string) {
  let sent: string
  try {
    const out = await $.process.run([mem.ant, ...sendArgs(id, event)], { timeoutMs: 30_000 })
    sent = out.exitCode === 0 ? done : antError(out)
  } catch {
    sent = CANT_RUN()
  }
  await setView($, id, v => ({ ...v, sent }))
  await loadView($, id)
  // An answered approval takes its buttons away and the ring lands on
  // whatever slid into their place. Once that drawing is up, put the ring
  // back on the message box.
  if (event.type === 'user.tool_confirmation') {
    await $.clock.sleep(150).catch(() => undefined)
    await $.ui.focus({ requestId: PANE, key: 'message' }).catch(() => undefined)
  }
}

// Option two: the session as a background task of this session, a Monitor on
// its event stream. It sits in the tasks list, and each status change it
// prints arrives as a notification.
async function watch($: EngineInterface, id: string): Promise<string> {
  if (!isSessionId(id)) return `Not a session id: ${id}`
  const s = (await read($, list)).sessions.find(one => one.id === id)
  const name = s ? `${s.agent ?? 'session'}: ${s.title ?? id}` : id
  const ran = await $.tool.call({
    tool: 'Monitor',
    description: `Managed Agents ${name}`,
    timeout_ms: mem.watchMs,
    command: watchCommand(mem.ant, id),
  })
  if (ran.deny !== undefined) return `Not watching ${id}: ${ran.deny}`
  if (ran.isError) return `Couldn't watch ${id}${ran.text ? `: ${ran.text}` : ''}`
  const until = (await $.clock.now()) + mem.watchMs
  await update($, watching, w => ({ ...w, [id]: until }))
  return `Watching ${name} as a background task.`
}

function row(s: AgentSession, at: number, width: number, isWatched: boolean) {
  const age = fmtAge(at - (s.updatedAt || s.createdAt))
  const cost = fmtCents(s.costCents)
  const agent = s.agent ? (s.agentVersion ? `${s.agent} v${s.agentVersion}` : s.agent) : '—'
  const fixed = 11 + 4 + 8 + 2
  const flex = Math.max(10, width - 4 - fixed)
  // A narrow dock keeps the title and drops the agent's name.
  const agentW = flex < 34 ? 0 : Math.min(22, Math.max(8, Math.floor(flex * 0.38)))
  const titleW = Math.min(44, Math.max(4, flex - agentW - (agentW ? 1 : 0)))
  return (
    `${agentW ? `${fit(agent, agentW)} ` : ''}${fit(s.title ?? s.id, titleW)} ` +
    `${fit(LABEL[s.status] + (isWatched ? ' ◉' : ''), 11)}${age.padStart(4)} ${cost.padStart(7)}`
  )
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return

  mem.ant = String(options.antPath ?? 'ant').trim() || 'ant'
  mem.limit = Math.min(1000, Math.max(1, Number(options.limit ?? 50)))
  mem.refreshMs = Math.max(0, Number(options.refreshSeconds ?? 15)) * 1000
  mem.watchMs = Math.min(30, Math.max(1, Number(options.watchMinutes ?? 30))) * 60_000

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'roster',
      description: 'Show your Managed Agents sessions, running and recent',
    })
    await $.command.register({
      name: 'roster-open',
      description: 'Open a Managed Agents session: its transcript, messages and approvals',
      argumentHint: '<session id>',
    })
    await $.command.register({
      name: 'roster-watch',
      description: 'Follow a Managed Agents session as a background task',
      argumentHint: '<session id>',
    })
    return started
  })

  on('command.run', { command: 'roster' }, async $ => {
    await openPane($)
    return { text: 'Roster opened in a pane.' }
  })

  on('command.run', { command: 'roster-open' }, async ($, e) => {
    const id = e.args.trim() || (await read($, selected)) || ''
    if (!isSessionId(id)) return { text: 'Usage: /roster-open <session id>' }
    await openView($, id)
    return { text: `Opened ${id}.` }
  })

  on('command.run', { command: 'roster-watch' }, async ($, e) => {
    const id = e.args.trim() || (await read($, selected)) || ''
    if (id === '') return { text: 'Usage: /roster-watch <session id>' }
    return { text: await watch($, id) }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE) return next(e)
    // Esc in a session goes back to the list; Esc there closes the pane.
    if (e.origin.kind === 'person' && (await read($, viewing))) {
      await backToList($)
      return { value: undefined }
    }
    mem.isOpen = false
    await update($, viewing, () => null)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const id = await read($, viewing)
    if (id) return drawSession($, e, id)
    const { Box, Text, Button } = $.ui.resolve(e)
    const f = await read($, list)
    const sel = await read($, selected)
    const watched = await read($, watching)
    const at = Math.max(await read($, now), f.loadedAt)
    const width = Math.max(30, e.props.bodyColumns)
    const { active, recent } = split(f.sessions)
    const cost = f.sessions.reduce((sum, s) => sum + (s.costCents ?? 0), 0)

    const open = (id: string) => () => void openView($, id)
    const rows = [...active, ...recent]
    const move = (by: number) => () => {
      const at = Math.max(0, rows.findIndex(r => r.id === sel))
      const to = rows[Math.min(rows.length - 1, Math.max(0, at + by))]
      if (!to) return
      void update($, selected, () => to.id)
      void $.ui.focus({ requestId: PANE, key: `row:${to.id}` }).catch(() => undefined)
    }
    const group = (label: string, list: AgentSession[], empty: string) => (
      <Box flexDirection="column">
        <Text bold dimColor>
          {label}
        </Text>
        {list.length === 0 && <Text dimColor>  {empty}</Text>}
        {list.map(s => (
          <Box flexDirection="row" key={`r-${s.id}`}>
            <Text>{s.id === sel ? '›' : ' '}</Text>
            <Text color={STATUS_COLOR[s.status]}>{GLYPH[s.status]} </Text>
            <Button
              plain
              key={`row:${s.id}`}
              label={row(s, at, width, (watched[s.id] ?? 0) > at)}
              dimColor={s.status === 'terminated'}
              onPress={open(s.id)}
            />
          </Box>
        ))}
      </Box>
    )

    const pick = sel ? f.sessions.find(s => s.id === sel) : undefined
    const status = f.isLoading
      ? 'loading…'
      : f.loadedAt
        ? `updated ${fmtAge(at - f.loadedAt)} ago`
        : ''

    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          <Text bold>{active.length} in play</Text>
          <Text dimColor>
            {' '}
            · {recent.length} on the bench · {fmtCents(cost)} list{status ? ` · ${status}` : ''}
          </Text>
        </Text>
        {f.error && <Text color="red">{f.error}</Text>}
        {group('IN PLAY', active, f.loadedAt ? 'Nobody running.' : '')}
        {group('BENCH', recent, f.loadedAt ? 'Nobody on the bench.' : '')}
        {pick && (
          <Text dimColor wrap="truncate-end">
            {pick.id}
            {pick.deploymentId ? ` · deployment ${pick.deploymentId}` : ''}
            {pick.capCents !== null ? ` · cap ${fmtCents(pick.capCents)}` : ''}
          </Text>
        )}
        <Box flexDirection="row" gap={2}>
          <Button key="open" hotkey="o" variant="primary" label="Open (o)" onPress={() => pick && void openView($, pick.id)} />
          <Button
            key="watch"
            hotkey="w"
            label="Watch (w)"
            onPress={() => {
              if (!pick) return
              void watch($, pick.id).then(text => $.ui.toast(text))
            }}
          />
          <Button
            key="copy"
            hotkey="c"
            label="Copy connect (c)"
            onPress={press => {
              if (!pick) return
              void $.ui
                .copy({ text: `ant beta:sessions connect ${pick.id}`, surface: press.surface })
                .then(r => $.ui.toast(r.isCopied ? 'Copied: ant beta:sessions connect' : "Couldn't copy here"))
            }}
          />
          <Button key="refresh" hotkey="r" label="Refresh (r)" onPress={() => void load($)} />
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button plain key="down" hotkey="j" label="next" dimColor onPress={move(1)} />
          <Button plain key="up" hotkey="k" label="previous" dimColor onPress={move(-1)} />
          <Text dimColor>· Enter or a click opens a session · {e.props.isFocused ? 'Esc closes' : 'ctrl+x tab to use the keys'}</Text>
        </Box>
      </Box>
    )
  })

}

type PaneRender = Extract<RenderInput, { component: 'Pane' }>

async function drawSession($: EngineInterface, e: PaneRender, id: string) {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  // The mobile app draws no text field yet.
  const Input = 'Input' in els ? els.Input : null
  const v = (await read($, views))[id] ?? EMPTY_VIEW
  const s = (await read($, list)).sessions.find(one => one.id === id)
  const at = Math.max(await read($, now), v.loadedAt)
  const width = Math.max(30, e.props.bodyColumns)
  const status = lastStatus(v.events) ?? s?.status ?? null
  const pending = pendingApprovals(v.events)
  const room = Math.max(4, (e.viewport?.rows ?? 30) - (pending.length ? 14 : 11))
  const lines = v.events.flatMap(ev => line(ev, width)).slice(-room)

  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        {status && <Text color={STATUS_COLOR[status]}>{GLYPH[status]} {LABEL[status]} </Text>}
        <Text bold>{s?.agent ?? 'session'}</Text>
        <Text dimColor>
          {' '}
          · {s?.title ?? id}
          {s?.costCents != null ? ` · ${fmtCents(s.costCents)}` : ''}
          {v.isLoading ? ' · loading…' : v.loadedAt ? ` · updated ${fmtAge(at - v.loadedAt)} ago` : ''}
        </Text>
      </Text>
      {v.error && <Text color="red">{v.error}</Text>}
      <Box flexDirection="column">
        {v.loadedAt > 0 && lines.length === 0 && <Text dimColor>No events yet.</Text>}
        {lines.map(l => (
          <Text color={l.color} dimColor={l.dim} bold={l.bold} wrap="truncate-end">
            {l.text}
          </Text>
        ))}
      </Box>
      {pending.length > 0 && (
        <Box flexDirection="column">
          <Text color="yellow">
            Waiting for you: {pending[0]?.name ?? 'tool'} {pending[0]?.input ? fit(pending[0].input, Math.max(10, width - 30)).trimEnd() : ''}
          </Text>
          <Box flexDirection="row" gap={2}>
            <Button
              key="allow"
              hotkey="y"
              variant="primary"
              label="Allow (y)"
              onPress={() =>
                pending[0] && void send($, id, { type: 'user.tool_confirmation', result: 'allow', tool_use_id: pending[0].id }, 'Allowed.')
              }
            />
            <Button
              key="deny"
              hotkey="n"
              label="Deny (n)"
              onPress={() =>
                pending[0] && void send($, id, { type: 'user.tool_confirmation', result: 'deny', tool_use_id: pending[0].id }, 'Denied.')
              }
            />
          </Box>
        </Box>
      )}
      {status === 'terminated' && <Text dimColor>This session has ended.</Text>}
      {Input && status !== 'terminated' && (
        <Input
          key="message"
          placeholder="Message the agent"
          value={mem.drafts[id] ?? ''}
          submitLabel="send"
          autoFocus
          onInput={(text: string) => {
            mem.drafts[id] = text
          }}
          onSubmit={(text: string) => {
            const body = text.trim()
            if (body === '') return
            mem.drafts[id] = ''
            void send($, id, { type: 'user.message', content: [{ type: 'text', text: body }] }, 'Sent.')
          }}
        />
      )}
      <Box flexDirection="row" gap={2}>
        {(status === 'running' || status === 'rescheduling') && (
          <Button key="interrupt" hotkey="i" label="Interrupt (i)" onPress={() => void send($, id, { type: 'user.interrupt' }, 'Interrupted.')} />
        )}
        <Button key="watch" hotkey="w" label="Watch (w)" onPress={() => void watch($, id).then(text => $.ui.toast(text))} />
        <Button
          key="copy"
          hotkey="c"
          label="Copy connect (c)"
          onPress={press =>
            void $.ui
              .copy({ text: `ant beta:sessions connect ${id}`, surface: press.surface })
              .then(r => $.ui.toast(r.isCopied ? 'Copied: ant beta:sessions connect' : "Couldn't copy here"))
          }
        />
        <Button key="refresh" hotkey="r" label="Refresh (r)" onPress={() => void loadView($, id)} />
        <Button key="back" hotkey="b" label="Roster (b)" onPress={() => void backToList($)} />
        {v.sent && <Text dimColor>{v.sent}</Text>}
      </Box>
      <Text dimColor>
        Tab moves between the box and the buttons · Esc goes back to the roster
      </Text>
    </Box>
  )
}

function wrap(text: string, width: number, most: number): string[] {
  const rows: string[] = []
  let row = ''
  for (const word of text.split(' ')) {
    if (row && row.length + 1 + word.length > width) {
      rows.push(row)
      row = ''
    }
    row = row ? `${row} ${word}` : word
  }
  if (row) rows.push(row)
  if (rows.length <= most) return rows
  return [...rows.slice(0, most - 1), fit(rows.slice(most - 1).join(' '), width).trimEnd()]
}

type Line = { text: string; color?: string; dim?: boolean; bold?: boolean }

// One transcript event as the rows the view draws, or none for the noise
// (thinking, spans, thread bookkeeping).
function line(ev: SessionEvent, width: number): Line[] {
  const text = (ev.text ?? '').replace(/\s+/g, ' ').trim()
  const cut = (t: string, w = width) => fit(t, w).trimEnd()
  // A message wraps under its speaker, up to four rows.
  const said = (who: string, bold?: boolean): Line[] =>
    wrap(text, width - 7, 4).map((row, i) => ({ text: `${i === 0 ? who.padEnd(7) : '       '}${row}`, bold }))
  switch (ev.type) {
    case 'user.message':
      return said('you', true)
    case 'agent.message':
      return said('agent')
    case 'agent.tool_use':
    case 'agent.mcp_tool_use':
    case 'agent.custom_tool_use':
      return [{ text: cut(`  ⏺ ${ev.name ?? 'tool'}  ${ev.input ?? ''}`), dim: true }]
    case 'agent.tool_result':
    case 'agent.mcp_tool_result':
      return ev.isError ? [{ text: cut(`    ✕ ${text || 'error'}`), color: 'red' }] : []
    case 'user.interrupt':
      return [{ text: 'you    interrupted', dim: true }]
    case 'user.tool_confirmation':
      return [{ text: cut(`you    ${text || 'answered an approval'}`), dim: true }]
    case 'session.error':
      return [{ text: cut(`  ! ${text || 'error'}`), color: 'red' }]
    case 'session.status_idle':
      return [{ text: cut(`  ── idle${ev.why ? ` (${ev.why.replace(/_/g, ' ')})` : ''}`), dim: true }]
    case 'session.status_terminated':
      return [{ text: '  ── ended', color: 'red' }]
    case 'session.status_rescheduled':
      return [{ text: '  ── retrying', color: 'yellow' }]
    default:
      return []
  }
}
