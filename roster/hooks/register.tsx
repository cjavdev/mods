import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentSession } from '../types'
import {
  GLYPH,
  LABEL,
  fit,
  fmtAge,
  fmtCents,
  isSessionId,
  listArgs,
  parseSessions,
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

const PANE = 'roster'
const TITLE = 'Roster'

const STATUS_COLOR = { running: 'green', rescheduling: 'yellow', idle: undefined, terminated: 'red' } as const

const mem = {
  ant: 'ant',
  limit: 50,
  refreshMs: 15_000,
  watchMs: 30 * 60_000,
  isOpen: false,
  tick: null as { cancel: () => void } | null,
}

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
    else error = out.stderr.trim().split('\n').at(-1) || `ant exited with ${out.exitCode}`
  } catch {
    error = `Couldn't run \`${mem.ant}\`. Install the ant CLI and run \`ant auth login\`, or set its path in /config.`
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await update($, list, f => ({
    sessions: sessions ?? f.sessions,
    loadedAt: sessions ? at : f.loadedAt,
    isLoading: false,
    error,
  }))
  if (sessions && mem.isOpen) {
    void $.ui.open({ id: PANE, title: TITLE, closeOnEscape: true, rows: sessions.length + 11, columns: 84 }).catch(() => undefined)
  }
  await update($, selected, id => (sessions && !sessions.some(s => s.id === id) ? (split(sessions).active[0] ?? sessions[0])?.id ?? null : id))
}

async function openPane($: EngineInterface) {
  mem.isOpen = true
  await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true, rows: 14, columns: 84 })
  void load($)
  if (!mem.tick && mem.refreshMs > 0) {
    mem.tick = $.clock.every(mem.refreshMs, () => {
      if (mem.isOpen) void load($)
    })
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

  on('command.run', { command: 'roster-watch' }, async ($, e) => {
    const id = e.args.trim() || (await read($, selected)) || ''
    if (id === '') return { text: 'Usage: /roster-watch <session id>' }
    return { text: await watch($, id) }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) mem.isOpen = false
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const f = await read($, list)
    const sel = await read($, selected)
    const watched = await read($, watching)
    const at = Math.max(await read($, now), f.loadedAt)
    const width = Math.max(30, e.props.bodyColumns)
    const { active, recent } = split(f.sessions)
    const cost = f.sessions.reduce((sum, s) => sum + (s.costCents ?? 0), 0)

    const select = (id: string) => () => void update($, selected, () => id)
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
              onPress={select(s.id)}
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
          <Button
            key="watch"
            hotkey="w"
            variant="primary"
            label="Watch"
            onPress={() => {
              if (!pick) return
              void watch($, pick.id).then(text => $.ui.toast(text))
            }}
          />
          <Button
            key="copy"
            hotkey="c"
            label="Copy connect"
            onPress={press => {
              if (!pick) return
              void $.ui
                .copy({ text: `ant beta:sessions connect ${pick.id}`, surface: press.surface })
                .then(r => $.ui.toast(r.isCopied ? 'Copied: ant beta:sessions connect' : "Couldn't copy here"))
            }}
          />
          <Button key="refresh" hotkey="r" label="Refresh" onPress={() => void load($)} />
        </Box>
      </Box>
    )
  })
}
