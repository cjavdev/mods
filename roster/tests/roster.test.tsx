import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseSessions, watchCommand } from '../hooks/sessions'

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.parse('2026-10-02T16:00:00Z')
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

const PANE = {
  plugin: 'roster',
  component: 'Pane',
  requestId: 'roster',
  props: {
    title: 'Roster',
    isFocused: true,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// What `ant beta:sessions list --format raw --transform ...` prints.
const LIST = [
  { id: 'sesn_01idle', title: 'Review PR #479', status: 'idle', agent_name: 'Code reviewer', agent_version: 7, cost: '140', cap: '200', created_at: '2026-10-02T13:00:00Z', updated_at: '2026-10-02T14:00:00Z' },
  { id: 'sesn_01run', title: 'Review PR #482', status: 'running', agent_name: 'Code reviewer', agent_version: 7, cost: '84', cap: null, created_at: '2026-10-02T15:40:00Z', updated_at: '2026-10-02T15:48:00Z' },
  { id: 'sesn_01retry', title: 'Triage 2026-10-02', status: 'rescheduling', agent_name: 'Nightly triage', agent_version: 2, cost: '12', created_at: '2026-10-02T15:50:00Z', updated_at: '2026-10-02T15:57:00Z', deployment_id: 'depl_01nightly' },
  { id: 'sesn_01done', title: 'Plan Q4 roadmap', status: 'terminated', agent_name: 'Engineering lead', agent_version: 3, cost: '480', created_at: '2026-10-02T09:00:00Z', updated_at: '2026-10-02T11:00:00Z' },
]

type World = { argv: string[][]; monitors: { description: string; command: string; timeout_ms: number }[]; copied: string[] }

const engine = (on: On, stdout = JSON.stringify(LIST), exitCode = 0): World => {
  const world: World = { argv: [], monitors: [], copied: [] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('process.run', (_$, e) => {
    world.argv.push([...e.argv])
    return { value: { exitCode, stdout: exitCode === 0 ? stdout : '', stderr: exitCode === 0 ? '' : 'Error: 401 Unauthorized', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Monitor' }, (_$, e) => {
    world.monitors.push({ description: e.description, command: e.command ?? '', timeout_ms: e.timeout_ms })
    return { result: { taskId: 'task_1' } as never, text: 'Monitor started' }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', (_$, e) => {
    world.copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  return world
}

describe('roster', () => {
  test('parses the transformed list, the full envelope and jsonl', async () => {
    const full = { data: [{ id: 'sesn_01x', status: 'idle', title: null, agent: { name: 'Reviewer', version: 4 }, usage: { list_cost: { amount: '250' } }, budget: { max_list_cost: { amount: '2500' } }, created_at: '2026-10-02T10:00:00Z', updated_at: '2026-10-02T10:00:00Z' }], next_page: null }
    const [one] = parseSessions(JSON.stringify(full))
    expect(one).toEqual({ id: 'sesn_01x', title: null, status: 'idle', agent: 'Reviewer', agentVersion: 4, costCents: 250, capCents: 2500, deploymentId: null, createdAt: Date.parse('2026-10-02T10:00:00Z'), updatedAt: Date.parse('2026-10-02T10:00:00Z') })
    expect(parseSessions(JSON.stringify(LIST)).length).toBe(4)
    expect(parseSessions(LIST.map(s => JSON.stringify(s)).join('\n')).length).toBe(4)
    expect(parseSessions('{"id":"x","status":"weird"}')).toEqual([])
  })

  test('/roster lists active sessions above recent ones', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = engine(on)
    await $.session.start(START)
    await $.command.run({ ...RUN, command: 'roster', args: '' })
    await clock.settle()

    expect(world.argv[0]?.slice(0, 7)).toEqual(['ant', 'beta:sessions', 'list', '--limit', '50', '--format', 'raw'])
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: '2 in play' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'row:sesn_01run' })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: /Review PR #482\s+running\s+12m\s+\$0\.84/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: /Nightly triage v2.*retrying/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: /Plan Q4 roadmap\s+ended/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: /Plan Q4 roadmap\s+running/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('[w] watches the selected session as a background Monitor task', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = engine(on)
    await $.session.start(START)
    await $.command.run({ ...RUN, command: 'roster', args: '' })
    await clock.settle()

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'row:sesn_01retry' })
    await ui.press({ key: 'watch' })
    await ui.unmount()

    expect(world.monitors.length).toBe(1)
    expect(world.monitors[0]?.description).toBe('Managed Agents Nightly triage: Triage 2026-10-02')
    expect(world.monitors[0]?.command).toBe(watchCommand('ant', 'sesn_01retry'))
    expect(world.monitors[0]?.timeout_ms).toBe(30 * 60_000)

    const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await after.find({ type: 'Button', text: /retrying ◉/ })).toBeDefined()
    await after.unmount()
  })

  test('/roster-watch takes an id and refuses anything else', { options: { watchMinutes: 5, antPath: '/opt/ant' } }, async ($, on) => {
    mock.clock(on, { now: NOW })
    const world = engine(on)
    await $.session.start(START)

    const bad = await $.command.run({ ...RUN, command: 'roster-watch', args: 'sesn_1; rm -rf ~' })
    expect(bad.text).toContain('Not a session id')
    const ok = await $.command.run({ ...RUN, command: 'roster-watch', args: 'sesn_01run' })
    expect(ok.text).toBe('Watching sesn_01run as a background task.')
    expect(world.monitors.map(m => m.timeout_ms)).toEqual([5 * 60_000])
    expect(world.monitors[0]?.command.startsWith("'/opt/ant' beta:sessions:events stream --session-id sesn_01run")).toBe(true)
  })

  test('copies the connect command for the selected session', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const world = engine(on)
    await $.session.start(START)
    await $.command.run({ ...RUN, command: 'roster', args: '' })
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'copy' })
    await ui.unmount()
    // Nothing picked yet: the first active session is selected.
    expect(world.copied).toEqual(['ant beta:sessions connect sesn_01retry'])
  })

  test('says what went wrong when ant fails', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    engine(on, '', 1)
    await $.session.start(START)
    await $.command.run({ ...RUN, command: 'roster', args: '' })
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'Error: 401 Unauthorized' })).toBeDefined()
    await ui.unmount()
  })

  test('off in /config registers nothing', { options: { enabled: false } }, async ($, on) => {
    const world = engine(on)
    await $.session.start(START)
    const ran = await $.command.run({ ...RUN, command: 'roster', args: '' }).catch(() => null)
    expect(ran?.text ?? '').not.toContain('Roster opened')
    expect(world.argv).toEqual([])
  })
})
