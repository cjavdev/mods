// What the panes and bands draw. No `$` here: each view takes the surface's
// element table, plain data, and the closures its buttons run.

import type { Agent, Approval, Bakeoff, Deployment, Ev, Feed, Fleet, Job, Nav, Plan, Replay } from '../types'
import { DEFAULT_COLOR, ago, compact, fit, histogram, money, pack, span, spark } from './ant'
import type { Cell } from './ant'

// The surface's element table; Raster is the terminal's alone.
type Ui = Record<string, any>

export const C = {
  ant: '#e8a33d',
  live: '#3fb950',
  wait: '#f0c000',
  bad: '#ff5c57',
  tool: '#58a6ff',
  think: '#bc8cff',
  say: '#e6edf3',
  dim: '#6e7681',
}

const WEEK = 7 * 24 * 3600_000
const DAY = 24 * 3600_000

const rule = (ui: Ui, width: number) => <ui.Text dimColor>{'─'.repeat(Math.max(4, width))}</ui.Text>

export type AgentStats = { agent: Agent; runs: number; live: number; cost: number; lastAt: number; weeks: number[] }

export const statsOf = (fleet: Fleet, now: number): AgentStats[] => {
  const rows = fleet.agents.map(agent => {
    const mine = fleet.sessions.filter(s => s.agentId === agent.id)
    return {
      agent,
      runs: mine.length,
      live: mine.filter(s => s.status === 'running').length,
      cost: mine.reduce((sum, s) => sum + s.cost, 0),
      lastAt: Math.max(0, ...mine.map(s => s.updatedAt)),
      weeks: histogram(mine.map(s => s.createdAt), now, WEEK, 26),
    }
  })
  return rows.sort((a, b) => b.live - a.live || b.lastAt - a.lastAt || b.agent.createdAt - a.agent.createdAt)
}

export const totals = (fleet: Fleet, now: number) => {
  const startOfDay = now - (now % DAY)
  return {
    live: fleet.sessions.filter(s => s.status === 'running').length,
    cost: fleet.sessions.reduce((sum, s) => sum + s.cost, 0),
    today: fleet.sessions.filter(s => s.updatedAt >= startOfDay).reduce((sum, s) => sum + s.cost, 0),
    next: fleet.deployments
      .filter(d => d.status === 'active')
      .flatMap(d => d.upcoming.map(at => ({ at, name: d.name })))
      .filter(run => run.at > now)
      .sort((a, b) => a.at - b.at)[0],
  }
}

type FleetActs = { open: (agentId: string) => void; refresh: () => void }

export const fleetView = (ui: Ui, fleet: Fleet, now: number, width: number, rows: number, act: FleetActs) => {
  const { Box, Text, Button } = ui
  const stats = statsOf(fleet, now)
  const sum = totals(fleet, now)
  const room = Math.max(3, rows - 9)
  // Agents that never ran fold into one line, so the ones doing work lead.
  const ran = stats.filter(row => row.runs > 0)
  const idle = stats.length - ran.length
  const names = new Map<string, number>()
  for (const row of stats) names.set(row.agent.name, (names.get(row.agent.name) ?? 0) + 1)
  const twins = stats.filter(row => (names.get(row.agent.name) ?? 0) > 1).length
  const shown = ran.slice(0, room)
  const nameWidth = Math.max(16, Math.min(28, width - 58))

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={C.ant} bold>{`ж ant farm`}</Text>
        <Text bold>{`  ${fleet.org}`}</Text>
        <Text dimColor>{`   refreshed ${ago(now - fleet.fetchedAt)} ago`}</Text>
      </Box>
      <Text>
        <Text>{`${fleet.agents.length} agents · ${fleet.sessions.length} sessions · `}</Text>
        <Text color={sum.live > 0 ? C.live : undefined}>{`${sum.live} live`}</Text>
        <Text>{` · ${money(sum.cost)} list cost · ${fleet.deployments.length} schedules`}</Text>
      </Text>
      {fleet.error !== null && <Text color={C.bad}>{fleet.error}</Text>}
      <Text> </Text>
      <Text dimColor>{`   ${fit('AGENT', nameWidth)} ${fit('MODEL', 13)} RUNS  ${fit('LAST 26 WEEKS', 26)}    COST  LAST`}</Text>
      {shown.map((row, i) => {
        const hotkey = i < 9 ? String(i + 1) : undefined
        const mark = row.live > 0 ? '●' : row.runs > 0 ? '○' : '·'
        return (
          <Box>
            <Text color={row.live > 0 ? C.live : C.dim}>{`${mark} `}</Text>
            <Button
              key={`agent-${row.agent.id}`}
              plain
              hotkey={hotkey}
              dimColor={row.runs === 0}
              label={fit(row.agent.name, nameWidth - (hotkey ? 3 : 0))}
              onPress={() => act.open(row.agent.id)}
            />
            <Text dimColor>{` ${fit(`${row.agent.model} v${row.agent.version}`, 13)} `}</Text>
            <Text>{String(row.runs).padStart(4)}</Text>
            <Text color={C.ant}>{`  ${spark(row.weeks)}`}</Text>
            <Text>{money(row.cost).padStart(8)}</Text>
            <Text dimColor>{(row.lastAt ? ago(now - row.lastAt) : '').padStart(6)}</Text>
          </Box>
        )
      })}
      {ran.length > shown.length && <Text dimColor>{`   + ${ran.length - shown.length} more agents`}</Text>}
      {idle > 0 && <Text dimColor>{`·  ${idle} agents have never run${twins > 0 ? ` · ${twins} share a name with another` : ''}`}</Text>}
      <Text> </Text>
      <Box>
        <Button key="refresh" hotkey="r" plain dimColor label="refresh" onPress={() => act.refresh()} />
        <Text dimColor>{'  ·  press a number to open an agent'}</Text>
      </Box>
    </Box>
  )
}

type AgentActs = { back: () => void; tail: (sessionId: string) => void; replay: (sessionId: string) => void }

export const agentView = (ui: Ui, fleet: Fleet, nav: Nav, now: number, width: number, act: AgentActs) => {
  const { Box, Text, Button } = ui
  const agent = fleet.agents.find(a => a.id === nav.agentId)
  if (!agent) return <Text dimColor>That agent is gone.</Text>
  const sessions = fleet.sessions.filter(s => s.agentId === agent.id).slice(0, 8)
  const schedules = fleet.deployments.filter(d => d.agentId === agent.id)
  const facts = [
    `claude-${agent.model}`,
    agent.isCoordinator ? 'coordinator' : null,
    `${agent.tools} toolset${agent.tools === 1 ? '' : 's'}`,
    agent.mcp.length > 0 ? `mcp: ${agent.mcp.join(', ')}` : null,
    agent.skills > 0 ? `${agent.skills} skills` : null,
    agent.asks ? 'asks before some tools' : null,
  ].filter(Boolean)
  const prompt = agent.system.split('\n').filter(line => line.trim() !== '').slice(0, 5)

  return (
    <Box flexDirection="column">
      <Box>
        <Button key="back" hotkey="b" plain dimColor label="‹ fleet" onPress={() => act.back()} />
      </Box>
      <Box>
        <Text color={C.ant} bold>{agent.name}</Text>
        <Text dimColor>{`   v${agent.version} · ${agent.id}`}</Text>
      </Box>
      <Text>{facts.join(' · ')}</Text>
      {agent.description !== '' && <Text dimColor wrap="wrap">{agent.description}</Text>}
      <Text> </Text>
      <Text bold>SYSTEM PROMPT</Text>
      {prompt.map(line => (
        <Text dimColor>{`  ${fit(line, width - 4).trimEnd()}`}</Text>
      ))}
      <Text> </Text>
      <Text bold>{`SESSIONS (${fleet.sessions.filter(s => s.agentId === agent.id).length})`}</Text>
      {sessions.length === 0 && <Text dimColor>  none yet</Text>}
      {sessions.map((s, i) => (
        <Box>
          <Text color={s.status === 'running' ? C.live : C.dim}>{s.status === 'running' ? '● ' : '○ '}</Text>
          <Button
            key={`session-${s.id}`}
            plain
            hotkey={String(i + 1)}
            label={fit(s.title || s.id, Math.max(14, width - 44))}
            onPress={() => (s.status === 'running' ? act.tail(s.id) : act.replay(s.id))}
          />
          <Text dimColor>{` ${span(s.activeSeconds * 1000).padStart(7)} ${compact(s.outputTokens).padStart(6)} out`}</Text>
          <Text>{money(s.cost).padStart(7)}</Text>
          <Text dimColor>{ago(now - s.updatedAt).padStart(5)}</Text>
        </Box>
      ))}
      {schedules.length > 0 && <Text> </Text>}
      {schedules.map(d => (
        <Text>
          <Text color={d.status === 'active' ? C.live : C.wait}>{d.status === 'active' ? '◷ ' : '‖ '}</Text>
          <Text>{d.name}</Text>
          <Text dimColor>{`  ${d.cron} ${d.timezone}`}</Text>
        </Text>
      ))}
      <Text> </Text>
      <Text dimColor>a number replays a session (or tails it while it runs)</Text>
    </Box>
  )
}

// One feed row per event worth a line; a tool's result folds into its call.
export const feedLines = (ui: Ui, events: Ev[], width: number, isCompact = false) => {
  const { Box, Text } = ui
  const results = new Map<string, Ev>()
  for (const ev of events) if (ev.type.endsWith('tool_result')) results.set(ev.toolUseId, ev)
  const lines = []

  for (const ev of events) {
    if (ev.type === 'user.message') {
      lines.push(
        <Text wrap={isCompact ? 'truncate-end' : 'wrap'}>
          <Text color={C.ant} bold>{'❯ '}</Text>
          <Text bold>{isCompact ? ev.text.replace(/\s+/g, ' ').slice(0, Math.max(10, width - 3)) : ev.text}</Text>
        </Text>,
      )
    } else if (ev.type === 'agent.thinking') {
      lines.push(<Text color={C.think}>{'✻ thinking'}</Text>)
    } else if (ev.type === 'agent.message' && ev.text.trim() !== '') {
      lines.push(
        <Text wrap={isCompact ? 'truncate-end' : 'wrap'}>
          <Text color={C.live}>{'● '}</Text>
          <Text>{isCompact ? ev.text.trim().replace(/\s+/g, ' ').slice(0, Math.max(10, width - 3)) : ev.text.trim()}</Text>
        </Text>,
      )
    } else if (ev.type === 'agent.tool_use' || ev.type === 'agent.mcp_tool_use' || ev.type === 'agent.custom_tool_use') {
      const result = results.get(ev.id)
      const mark = result ? (result.isError ? ' ✗' : ' ✓') : ev.permission === 'ask' ? ' ▲ needs approval' : ' …'
      const room = Math.max(8, width - ev.name.length - mark.length - 4)
      lines.push(
        <Box>
          <Text color={C.tool}>{`◆ ${ev.name} `}</Text>
          <Text dimColor>{ev.text.length > room ? `${ev.text.slice(0, room - 1)}…` : ev.text}</Text>
          <Text color={result?.isError ? C.bad : ev.permission === 'ask' && !result ? C.wait : C.live}>{mark}</Text>
        </Box>,
      )
    } else if (ev.type === 'session.thread_created') {
      lines.push(<Text color={C.think}>{`↳ handed work to ${ev.agent}`}</Text>)
    } else if (ev.type === 'session.status_idle') {
      lines.push(<Text dimColor>{`◼ idle (${ev.name || 'end_turn'})`}</Text>)
    } else if (ev.type === 'session.error') {
      lines.push(<Text color={C.bad}>{`✗ ${ev.text}`}</Text>)
    } else if (ev.type === 'user.interrupt') {
      lines.push(<Text color={C.wait}>{'■ interrupted'}</Text>)
    }
  }
  return lines
}

const STATUS: Record<Feed['status'], [string, string]> = {
  connecting: ['◌ connecting', C.dim],
  running: ['● running', C.live],
  idle: ['○ idle', C.dim],
  waiting: ['▲ needs you', C.wait],
  ended: ['◼ ended', C.dim],
  error: ['✗ error', C.bad],
}

export const feedHeader = (ui: Ui, feed: Feed, now: number) => {
  const { Box, Text } = ui
  const [label, color] = STATUS[feed.status]
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={C.ant} bold>{feed.agentName}</Text>
        <Text dimColor>{feed.title ? `  “${feed.title.replace(/\s+/g, ' ')}”` : ''}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={color}>{label}</Text>
        <Text dimColor>{`  ${compact(feed.outputTokens)} tokens out · ${money(feed.cost)} · ${feed.sessionId}`}</Text>
      </Text>
    </Box>
  )
}

type TvActs = { say: (text: string) => void; interrupt: () => void; stop: () => void }

export const tvView = (ui: Ui, feed: Feed, now: number, width: number, rows: number, act: TvActs) => {
  const { Box, Text, Button, Input } = ui
  const lines = feedLines(ui, feed.events, width)
  if (feed.draft.trim() !== '') {
    lines.push(
      <Text wrap="wrap">
        <Text color={C.live}>{'● '}</Text>
        <Text>{feed.draft.trim()}</Text>
        <Text color={C.ant}>{' ▌'}</Text>
      </Text>,
    )
  }
  const room = Math.max(4, rows - 10)

  return (
    <Box flexDirection="column">
      {feedHeader(ui, feed, now)}
      {rule(ui, width)}
      {lines.length === 0 && <Text dimColor>{feed.note || 'waiting for the first event…'}</Text>}
      {lines.slice(-room)}
      {rule(ui, width)}
      {Input ? (
        <Input key="say" autoFocus label="you ❯" placeholder={`message ${feed.agentName}`} submitLabel="send" onSubmit={(value: string) => act.say(value)} />
      ) : null}
      <Box>
        <Button key="interrupt" hotkey="i" plain dimColor label="interrupt" onPress={() => act.interrupt()} />
        <Text dimColor>{'   '}</Text>
        <Button key="stop" hotkey="x" plain dimColor label="stop watching" onPress={() => act.stop()} />
      </Box>
    </Box>
  )
}

type ApprovalActs = { allow: (a: Approval) => void; deny: (a: Approval) => void; watch: (a: Approval) => void }

export const approvalBand = (ui: Ui, approvals: Approval[], now: number, width: number, act: ApprovalActs) => {
  const { Box, Text, Button } = ui
  const first = approvals[0]
  if (!first) return null
  const more = approvals.length - 1
  return (
    <Box key="ant-farm-approval" flexDirection="column" borderStyle="round" borderColor={C.wait} paddingX={1}>
      <Text>
        <Text color={C.wait} bold>{'▲ '}</Text>
        <Text bold>{first.agentName}</Text>
        <Text>{` wants to run `}</Text>
        <Text color={C.tool} bold>{first.tool}</Text>
        <Text dimColor>{`   waiting ${ago(now - first.at)}${more > 0 ? ` · ${more} more behind it` : ''}`}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text color={C.tool}>{`  ${first.tool} `}</Text>
        <Text>{first.input.slice(0, Math.max(20, width - 12 - first.tool.length))}</Text>
      </Text>
      <Box>
        <Button key="allow" hotkey="1" variant="primary" label="Allow" onPress={() => act.allow(first)} />
        <Text> </Text>
        <Button key="deny" hotkey="2" variant="secondary" label="Deny" onPress={() => act.deny(first)} />
        <Text> </Text>
        <Button key="watch" hotkey="3" plain dimColor label="watch the session" onPress={() => act.watch(first)} />
      </Box>
    </Box>
  )
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export const jobsBand = (ui: Ui, jobs: Job[], feeds: Record<string, Feed>, now: number, width: number) => {
  const { Box, Text } = ui
  const running = jobs.filter(job => job.endedAt === null)
  if (running.length === 0) return null
  return (
    <Box key="ant-farm-jobs" flexDirection="column">
      {running.map(job => {
        const feed = feeds[job.sessionId]
        const last = feed?.events.filter(ev => ev.type.endsWith('tool_use') || ev.type === 'agent.thinking').at(-1)
        const doing = !last ? 'starting' : last.type === 'agent.thinking' ? 'thinking' : `${last.name} ${last.text}`
        return (
          <Text wrap="truncate-end">
            <Text color={C.ant}>{`${SPIN[Math.floor(now / 120) % SPIN.length]} ж `}</Text>
            <Text bold>{job.agentName}</Text>
            <Text dimColor>{` in the cloud · ${span(now - job.startedAt)} · ${money(feed?.cost ?? 0)} · `}</Text>
            <Text color={C.tool}>{doing.slice(0, Math.max(10, width - job.agentName.length - 40))}</Text>
          </Text>
        )
      })}
    </Box>
  )
}

type PlanActs = { apply: () => void; dismiss: () => void }

const PLAN_MARK: Record<string, [string, string]> = {
  create: ['+', C.live],
  update: ['~', C.wait],
  delete: ['-', C.bad],
  unchanged: ['=', C.dim],
  other: ['?', C.dim],
}

// One plan line. ant words a changed field as a diff: {+added+}, [-removed-].
const diffLine = (ui: Ui, line: string, width: number) => {
  const { Text } = ui
  if (!/\{\+|\[-/.test(line)) return <Text dimColor wrap="truncate-end">{`    ${line.slice(0, width)}`}</Text>
  const parts = line.split(/(\{\+[\s\S]*?\+\}|\[-[\s\S]*?-\])/).filter(part => part !== '')
  return (
    <Text wrap="wrap">
      <Text>{'    '}</Text>
      {parts.map(part =>
        part.startsWith('{+') ? (
          <Text color={C.live} bold>{part.slice(2, -2)}</Text>
        ) : part.startsWith('[-') ? (
          <Text color={C.bad} strikethrough>{part.slice(2, -2)}</Text>
        ) : (
          <Text dimColor>{part}</Text>
        ),
      )}
    </Text>
  )
}

export const planView = (ui: Ui, plan: Plan, width: number, act: PlanActs) => {
  const { Box, Text, Button } = ui
  const changes = plan.rows.filter(row => row.action !== 'unchanged')
  const counts = ['create', 'update', 'delete']
    .map(action => [action, plan.rows.filter(row => row.action === action).length] as const)
    .filter(([, n]) => n > 0)
    .map(([action, n]) => `${n} to ${action}`)
  return (
    <Box key="ant-farm-plan" flexDirection="column" borderStyle="round" borderColor={plan.status === 'error' ? C.bad : C.ant} paddingX={1}>
      <Text>
        <Text color={C.ant} bold>{'ж ant apply'}</Text>
        <Text bold>{plan.status === 'planning' ? '  planning…' : plan.status === 'applying' ? '  applying…' : plan.status === 'applied' ? '  applied' : `  ${counts.join(', ') || 'nothing to change'}`}</Text>
        <Text dimColor>{`   ${plan.paths.join(' ')}`}</Text>
      </Text>
      {changes.map(row => {
        const [mark, color] = PLAN_MARK[row.action] ?? ['?', C.dim]
        return (
          <Box flexDirection="column">
            <Text>
              <Text color={color} bold>{`${mark} `}</Text>
              <Text bold>{row.name}</Text>
              <Text color={color}>{`  ${row.action}`}</Text>
              <Text dimColor>{/^\w+_01\w+$/.test(row.detail[0] ?? '') ? `  ${row.detail[0]}` : ''}</Text>
            </Text>
            {row.detail.filter(line => !/^\w+_01\w+$/.test(line)).slice(0, 6).map(line => diffLine(ui, line, Math.max(20, width - 10)))}
            {row.detail.length > 6 && <Text dimColor>{`    … ${row.detail.length - 6} more fields`}</Text>}
          </Box>
        )
      })}
      {plan.note !== '' && <Text color={plan.status === 'error' ? C.bad : C.live} wrap="wrap">{plan.note}</Text>}
      {plan.status === 'ready' && (
        <Box>
          {changes.length > 0 && <Button key="apply" hotkey="1" variant="primary" label="Apply" onPress={() => act.apply()} />}
          {changes.length > 0 && <Text> </Text>}
          <Button key="dismiss" hotkey="2" variant="secondary" label="Dismiss" onPress={() => act.dismiss()} />
        </Box>
      )}
      {(plan.status === 'applied' || plan.status === 'error') && (
        <Box>
          <Button key="dismiss" hotkey="1" plain dimColor label="dismiss" onPress={() => act.dismiss()} />
        </Box>
      )}
    </Box>
  )
}

type BoardActs = { run: (d: Deployment) => void; toggle: (d: Deployment) => void }

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const clock = (at: number) => {
  const d = new Date(at)
  const h = d.getHours()
  return `${WEEKDAY[d.getDay()]} ${MONTH[d.getMonth()]} ${d.getDate()} · ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

// Fourteen days in one strip: a tick per day, a mark where a run lands.
const strip = (deployment: Deployment, now: number, columns: number): Cell[] => {
  const horizon = 14 * DAY
  const cells: Cell[] = []
  const color = deployment.status === 'active' ? 0x3fb950 : 0xf0c000
  for (let x = 0; x < columns; x++) {
    const from = now + (x / columns) * horizon
    const to = now + ((x + 1) / columns) * horizon
    const hasRun = deployment.upcoming.some(at => at >= from && at < to)
    const isDayEdge = Math.floor(from / DAY) !== Math.floor(to / DAY)
    cells.push(hasRun ? ['▼', color, 0x161b22] : [isDayEdge ? '┊' : '·', 0x484f58, 0x161b22])
  }
  return cells
}

export const boardView = (ui: Ui, fleet: Fleet, now: number, width: number, act: BoardActs) => {
  const { Box, Text, Button, Raster } = ui
  const columns = Math.max(20, Math.min(84, width - 4))
  const active = fleet.deployments.filter(d => d.status === 'active').length
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={C.ant} bold>{'◷ schedule board'}</Text>
        <Text dimColor>{`   ${fleet.deployments.length} deployments · ${active} active · ${fleet.deployments.length - active} paused`}</Text>
      </Box>
      <Text> </Text>
      {fleet.deployments.length === 0 && <Text dimColor>No deployments yet.</Text>}
      {fleet.deployments.map((d, i) => {
        const agent = fleet.agents.find(a => a.id === d.agentId)
        const next = d.upcoming.find(at => at > now)
        const isActive = d.status === 'active'
        return (
          <Box flexDirection="column" marginBottom={1}>
            <Text>
              <Text color={isActive ? C.live : C.wait}>{isActive ? '● ' : '‖ '}</Text>
              <Text bold>{d.name}</Text>
              <Text color={isActive ? C.live : C.wait}>{`   ${d.status}${d.pausedReason ? ` (${d.pausedReason})` : ''}`}</Text>
            </Text>
            <Text dimColor>{`  ${agent ? `${agent.name} · ${agent.model}` : d.agentId} · cron ${d.cron} · ${d.timezone}`}</Text>
            <Text>
              <Text dimColor>{'  next  '}</Text>
              <Text>{next ? clock(next) : 'none'}</Text>
              <Text color={C.ant}>{next ? `   in ${span(next - now)}` : ''}</Text>
              <Text dimColor>{`${isActive ? '' : ' if unpaused'}   last  ${d.lastRunAt ? `${ago(now - d.lastRunAt)} ago${d.lastRunNote ? ` (${d.lastRunNote})` : ''}` : 'never'}`}</Text>
            </Text>
            {Raster ? (
              <Box>
                <Text dimColor>{'  '}</Text>
                <Raster key={`strip-${d.id}`} columns={columns} rows={1} cells={pack(strip(d, now, columns))} />
              </Box>
            ) : null}
            <Text dimColor wrap="truncate-end">{`  “${d.prompt.replace(/\s+/g, ' ').slice(0, Math.max(20, width - 8))}”`}</Text>
            <Box>
              <Text>{'  '}</Text>
              <Button key={`run-${d.id}`} hotkey={String(i * 2 + 1)} plain label="run now" onPress={() => act.run(d)} />
              <Text>{'   '}</Text>
              <Button key={`toggle-${d.id}`} hotkey={String(i * 2 + 2)} plain label={isActive ? 'pause' : 'unpause'} onPress={() => act.toggle(d)} />
            </Box>
          </Box>
        )
      })}
      <Text dimColor>{`  each strip is the next 14 days · ┊ midnight · ▼ a run`}</Text>
    </Box>
  )
}

// The lanes of a session's flight record: one per agent thread, a column per
// slice of time, colored by what was happening in it.
const LANE = { model: 0xbc8cff, tool: 0x58a6ff, error: 0xff5c57, run: 0x2ea043, idle: 0x21262d }

export const lanesOf = (events: Ev[], columns: number) => {
  const first = events[0]?.at ?? 0
  const last = events.at(-1)?.at ?? first
  const length = Math.max(1, last - first)
  const column = (at: number) => Math.min(columns - 1, Math.max(0, Math.floor(((at - first) / length) * columns)))
  const paint = (row: number[], from: number, to: number, color: number) => {
    for (let x = column(from); x <= column(to); x++) row[x] = color
  }

  const primary = new Array<number>(columns).fill(LANE.idle)
  const toolStart = new Map<string, number>()
  let modelFrom = 0
  for (const ev of events) {
    if (ev.type === 'span.model_request_start') modelFrom = ev.at
    else if (ev.type === 'span.model_request_end' && modelFrom) {
      paint(primary, modelFrom, ev.at, ev.isError ? LANE.error : LANE.model)
      modelFrom = 0
    } else if (ev.type.endsWith('tool_use')) toolStart.set(ev.id, ev.at)
    else if (ev.type.endsWith('tool_result')) {
      const from = toolStart.get(ev.toolUseId)
      if (from) paint(primary, from, ev.at, ev.isError ? LANE.error : LANE.tool)
    }
  }

  // Other agents' threads: when each was running.
  const threads = new Map<string, { name: string; row: number[]; from: number }>()
  const main = events.find(ev => ev.type === 'session.thread_status_running')?.thread ?? ''
  for (const ev of events) {
    if (!ev.thread || ev.thread === main) continue
    let lane = threads.get(ev.thread)
    if (!lane) {
      lane = { name: ev.agent || ev.thread, row: new Array<number>(columns).fill(LANE.idle), from: 0 }
      threads.set(ev.thread, lane)
    }
    if (ev.type === 'session.thread_status_running') lane.from = ev.at
    else if (ev.type === 'session.thread_status_idle' && lane.from) {
      paint(lane.row, lane.from, ev.at, LANE.run)
      lane.from = 0
    }
  }
  const mainName = events.find(ev => ev.thread === main && ev.agent)?.agent ?? 'agent'
  return { first, length, column, lanes: [{ name: mainName, row: primary }, ...[...threads.values()].map(l => ({ name: l.name, row: l.row }))] }
}

type ReplayActs = { step: (by: number) => void; play: () => void; debug: () => void }

export const replayView = (ui: Ui, replay: Replay, width: number, rows: number, act: ReplayActs) => {
  const { Box, Text, Button, Raster } = ui
  const events = replay.events
  if (events.length === 0) return <Text dimColor>Loading the flight record…</Text>
  const probe = lanesOf(events, 20).lanes
  const label = Math.min(30, Math.max(...probe.map(lane => lane.name.length)) + 2)
  const columns = Math.max(20, Math.min(160, width - label - 2))
  const { first, length, column, lanes } = lanesOf(events, columns)
  const cursor = events[Math.min(replay.cursor, events.length - 1)]
  const cursorColumn = cursor ? column(cursor.at) : 0
  const tools = events.filter(ev => ev.type.endsWith('tool_use')).length
  const requests = events.filter(ev => ev.type === 'span.model_request_end')
  const errors = events.filter(ev => ev.isError || ev.type === 'session.error').length
  const out = requests.reduce((sum, ev) => sum + ev.outputTokens, 0)
  const shown = events.slice(0, replay.cursor + 1)
  const room = Math.max(4, rows - lanes.length - 16)

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={C.ant} bold>{'◉ flight recorder'}</Text>
        <Text bold>{`  ${replay.agentName}`}</Text>
        <Text dimColor>{replay.title ? `  “${replay.title}”` : ''}</Text>
      </Box>
      <Text dimColor>{`${span(length)} · ${requests.length} model requests · ${tools} tool calls · ${compact(out)} tokens out · ${money(replay.cost)} · ${errors} errors`}</Text>
      <Text> </Text>
      {lanes.map((lane, i) => (
        <Box>
          <Text dimColor>{fit(lane.name, label)}</Text>
          {Raster ? (
            <Raster
              key={`lane-${i}`}
              columns={columns}
              rows={1}
              cells={pack(lane.row.map((color, x): Cell => (x === cursorColumn ? ['┃', 0xffffff, color] : [' ', DEFAULT_COLOR, color])))}
            />
          ) : null}
        </Box>
      ))}
      <Box>
        <Text dimColor>{fit('', label)}</Text>
        <Text dimColor>{`0:00${' '.repeat(Math.max(1, columns - 4 - span(length).length))}${span(length)}`}</Text>
      </Box>
      <Text>
        <Text dimColor>{fit('', label)}</Text>
        <Text color={C.think}>{'■ model  '}</Text>
        <Text color={C.tool}>{'■ tool  '}</Text>
        <Text color={C.live}>{'■ other agent  '}</Text>
        <Text color={C.bad}>{'■ error'}</Text>
      </Text>
      <Text> </Text>
      <Text dimColor>{`event ${Math.min(replay.cursor + 1, events.length)} of ${events.length} · +${span((cursor?.at ?? first) - first)}`}</Text>
      {feedLines(ui, shown, width, true).slice(-room)}
      <Text> </Text>
      <Box>
        <Button key="back" hotkey="j" plain label="‹ back" onPress={() => act.step(-1)} />
        <Text>{'   '}</Text>
        <Button key="forward" hotkey="k" plain label="forward ›" onPress={() => act.step(1)} />
        <Text>{'   '}</Text>
        <Button key="play" hotkey="p" plain label={replay.isPlaying ? 'pause' : 'play'} onPress={() => act.play()} />
        <Text>{'   '}</Text>
        <Button key="debug" hotkey="d" variant="primary" label="Debug with Claude" onPress={() => act.debug()} />
      </Box>
    </Box>
  )
}

type BakeoffActs = { pick: (sessionId: string) => void }

export const bakeoffView = (ui: Ui, bakeoff: Bakeoff, feeds: Record<string, Feed>, now: number, width: number, rows: number, act: BakeoffActs) => {
  const { Box, Text, Button } = ui
  const each = Math.max(24, Math.floor((width - 3) / Math.max(1, bakeoff.sessionIds.length)))
  const room = Math.max(4, rows - 12)
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={C.ant} bold>{'◧ bake-off'}</Text>
        <Text dimColor>{'   same prompt, two agents, side by side'}</Text>
      </Box>
      <Text wrap="wrap">
        <Text color={C.ant} bold>{'❯ '}</Text>
        <Text bold>{bakeoff.prompt}</Text>
      </Text>
      <Text> </Text>
      <Box>
        {bakeoff.sessionIds.map((sessionId, i) => {
          const feed = feeds[sessionId]
          if (!feed) return <Box width={each}><Text dimColor>starting…</Text></Box>
          const [label, color] = STATUS[feed.status]
          // The work as one-line rows, then the answer drawn as a reply is.
          const work = feed.events.filter(ev => ev.type !== 'user.message' && ev.type !== 'agent.message' && ev.type !== 'session.status_idle')
          const lines = feedLines(ui, work, each - 3, true)
          const said = feed.events.filter(ev => ev.type === 'agent.message' && ev.text.trim() !== '').map(ev => ev.text.trim())
          const answer = [...said, feed.draft.trim() !== '' ? `${feed.draft.trim()} ▌` : ''].filter(Boolean).join('\n\n')
          if (answer !== '') lines.push(<ui.Markdown text={answer.slice(0, 9000)} />)
          const started = feed.events.find(ev => ev.type === 'session.status_running')?.at ?? feed.startedAt
          const ended = feed.status === 'idle' ? (feed.events.at(-1)?.at ?? now) : now
          const isPicked = bakeoff.picked === sessionId
          return (
            <Box flexDirection="column" width={each} marginRight={i === 0 ? 2 : 0} borderStyle="round" borderColor={isPicked ? C.live : '#30363d'} paddingX={1}>
              <Text>
                <Text color={C.ant} bold>{`${String.fromCharCode(65 + i)} · ${feed.agentName}`}</Text>
              </Text>
              <Text>
                <Text color={color}>{label}</Text>
                <Text dimColor>{`  ${span(Math.max(0, ended - started))} · ${compact(feed.outputTokens)} out · ${money(feed.cost)}`}</Text>
              </Text>
              <Box>
                <Button key={`pick-${sessionId}`} hotkey={String(i + 1)} variant={isPicked ? 'primary' : 'secondary'} label={isPicked ? `✓ ${String.fromCharCode(65 + i)} wins` : `Pick ${String.fromCharCode(65 + i)}`} onPress={() => act.pick(sessionId)} />
              </Box>
              <Text dimColor>{'─'.repeat(Math.max(4, each - 4))}</Text>
              {lines.slice(-room)}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

// The reply card `/ask` leaves in the transcript.
export const askCard = (ui: Ui, feed: Feed, question: string, width: number) => {
  const { Box, Text, Markdown } = ui
  // This card's stretch of the session: from its question to the next one.
  const asked = feed.events.map(ev => (ev.type === 'user.message' ? ev.text.trim().replace(/\s+/g, ' ') : '')).lastIndexOf(question)
  const from = asked < 0 ? feed.events.map(ev => ev.type).lastIndexOf('user.message') : asked
  const until = feed.events.findIndex((ev, i) => i > from && ev.type === 'user.message')
  const mine = feed.events.slice(from + 1, until < 0 ? undefined : until)
  const isLatest = until < 0
  const reply = mine.filter(ev => ev.type === 'agent.message' && ev.text.trim() !== '').map(ev => ev.text.trim()).join('\n\n')
  const text = isLatest && feed.draft.trim() !== '' ? `${reply}\n\n${feed.draft}`.trim() : reply
  const tools = mine.filter(ev => ev.type.endsWith('tool_use'))
  const [label, color] = isLatest ? STATUS[feed.status] : STATUS.idle
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.ant} paddingX={1} width={Math.min(width, 110)}>
      <Text>
        <Text color={C.ant} bold>{`ж ${feed.agentName}`}</Text>
        <Text dimColor>{'  cloud agent  '}</Text>
        <Text color={color}>{label}</Text>
        <Text dimColor>{`  ${compact(feed.outputTokens)} out · ${money(feed.cost)}`}</Text>
      </Text>
      {tools.map(ev => (
        <Text wrap="truncate-end">
          <Text color={C.tool}>{`◆ ${ev.name} `}</Text>
          <Text dimColor>{ev.text.slice(0, Math.max(10, width - 30))}</Text>
          <Text color={ev.permission === 'ask' ? C.wait : C.dim}>{ev.permission === 'ask' ? '  asked you first' : ''}</Text>
        </Text>
      ))}
      {text.trim() === '' ? <Text dimColor>{feed.status === 'error' ? feed.note : 'thinking…'}</Text> : <Markdown text={text.slice(0, 9000)} />}
      <Text dimColor>{`${feed.sessionId} · /tail to watch · @${feed.agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-')} to reply`}</Text>
    </Box>
  )
}

