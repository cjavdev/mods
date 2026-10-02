import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { ago, findAgent, histogram, money, parseLines, parsePlan, span, spark, toAgent, toEv } from '../hooks/ant'
import { farmStep, seedFarm } from '../hooks/farm'
import type { Feed, Fleet } from '../types'

const HINT = {
  plugin: 'ant-farm',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: 'auto mode on' },
} as const

const BAND = {
  plugin: 'ant-farm',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.parse('2026-10-02T16:00:00Z')

const AGENTS = [
  { id: 'agent_1', name: 'Code Reviewer', model: { id: 'claude-opus-5' }, version: 1, tools: [{ type: 'agent_toolset_20260401' }], created_at: '2026-09-29T18:42:45Z' },
  {
    id: 'agent_2',
    name: 'Gatekeeper',
    model: { id: 'claude-haiku-4-5' },
    version: 2,
    tools: [{ type: 'agent_toolset_20260401', default_config: { permission_policy: { type: 'always_ask' } } }],
    created_at: '2026-10-02T15:40:00Z',
  },
]

const SESSIONS = [
  {
    id: 'sesn_1',
    title: 'review',
    status: 'running',
    agent: { id: 'agent_1', name: 'Code Reviewer' },
    environment_id: 'env_1',
    created_at: '2026-10-02T15:50:00Z',
    updated_at: '2026-10-02T15:59:00Z',
    usage: { output_tokens: 400, list_cost: { amount: '42', currency: 'USD' } },
    stats: { active_seconds: 30 },
  },
]

const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n')

// The engine beneath the mod, with `ant` answered from the fixtures above.
const engine = (on: On, ran: string[][] = []) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__ant-farm__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('process.run', (_$, e) => {
    ran.push([...e.argv])
    const call = e.argv.slice(1).join(' ')
    const stdout = call.startsWith('beta:agents list')
      ? jsonl(AGENTS)
      : call.startsWith('beta:sessions list')
        ? jsonl(SESSIONS)
        : call.startsWith('auth status')
          ? 'Logged in to ACME as dev@example.com'
          : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.tail ? `${e.props.hint} · ${e.props.tail}` : e.props.hint}</Text>
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

describe('helpers', () => {
  test('reads ant jsonl and skips what is not a row', async () => {
    expect(parseLines('{"id":"a"}\nnot json\n{"id":"b"}\n{"cut')).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  test('an agent row knows whether its tools ask first', async () => {
    const [reviewer, gatekeeper] = AGENTS.map(toAgent)
    expect(reviewer?.model).toBe('opus-5')
    expect(reviewer?.slug).toBe('code-reviewer')
    expect(reviewer?.asks).toBe(false)
    expect(gatekeeper?.asks).toBe(true)
  })

  test('finds an agent by slug, prefix or part of its name', async () => {
    const agents = AGENTS.map(toAgent)
    expect(findAgent(agents, 'code-reviewer')?.id).toBe('agent_1')
    expect(findAgent(agents, 'gate')?.id).toBe('agent_2')
    expect(findAgent(agents, 'reviewer')?.id).toBe('agent_1')
    expect(findAgent(agents, 'nobody')).toBe(null)
  })

  test('an event row carries the tool, its input and the permission', async () => {
    const ev = toEv({
      id: 'sevt_1',
      type: 'agent.tool_use',
      name: 'bash',
      input: { command: 'ls  -la\n/tmp' },
      evaluated_permission: 'ask',
      processed_at: '2026-10-02T16:00:00Z',
    })
    expect(ev.name).toBe('bash')
    expect(ev.text).toBe('ls -la /tmp')
    expect(ev.permission).toBe('ask')
    expect(toEv({ type: 'session.usage', usage: { list_cost: { amount: '7' } } }).cost).toBe(7)
  })

  test('formats spans, ages and money', async () => {
    expect(ago(42_000)).toBe('42s')
    expect(ago(3 * 24 * 3600_000)).toBe('3d')
    expect(span(375_000)).toBe('6m 15s')
    expect(span(26 * 3600_000)).toBe('1d 2h')
    expect(money(152)).toBe('$1.52')
  })

  test('a spark has one block per bucket', async () => {
    expect(histogram([10, 20, 95], 100, 10, 3)).toEqual([0, 0, 1])
    expect(spark([0, 1, 2])).toBe('·▄█')
  })

  test('reads an ant apply plan', async () => {
    const plan = [
      '± Name                    Plan',
      '+ ./agents/new.md         create',
      '    model: "claude-haiku-4-5"',
      '~ ./agents/gatekeeper.md  update     agent_01J7',
      '    ~ system: …46 words… together{+. Keep it short+}.',
      '',
      'Resources  + 1 to create, ~ 1 to update',
    ].join('\n')
    const rows = parsePlan(plan)
    expect(rows.map(row => [row.action, row.name])).toEqual([
      ['create', 'agents/new.md'],
      ['update', 'agents/gatekeeper.md'],
    ])
    expect(rows[1]?.detail).toEqual(['agent_01J7', '~ system: …46 words… together{+. Keep it short+}.'])
  })

  test('a tool call sends an ant out and brings it home', async () => {
    const fleet: Fleet = { org: 'ACME', agents: AGENTS.map(toAgent), sessions: [], deployments: [], fetchedAt: NOW, error: null }
    fleet.sessions = [{ id: 'sesn_1', title: '', status: 'idle', agentId: 'agent_1', agentName: 'Code Reviewer', environmentId: 'env_1', createdAt: NOW, updatedAt: NOW, activeSeconds: 1, outputTokens: 1, cost: 1 }]
    const farm = seedFarm(fleet, NOW)
    expect(farm.chambers.map(c => c.name)).toEqual(['Code Reviewer'])
    const feed: Feed = {
      sessionId: 'sesn_1',
      agentName: 'Code Reviewer',
      title: '',
      status: 'running',
      events: [toEv({ id: 'sevt_1', type: 'agent.tool_use', name: 'bash', processed_at: new Date(NOW).toISOString() })],
      draft: '',
      startedAt: NOW,
      outputTokens: 0,
      cost: 0,
      note: '',
    }
    farmStep(farm, [feed])
    expect(farm.ants.length).toBe(1)
    for (let i = 0; i < 60; i++) farmStep(farm, [feed])
    expect(farm.ants.length).toBe(0)
  })
})

describe('bar', () => {
  test('the colony at a glance, at the end of the hint row', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const ran: string[][] = []
    engine(on, ran)
    await $.session.start(START)
    await clock.advance(1000)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...HINT, surface })
      expect(await ui.find({ type: 'Text', text: 'auto mode on · ж 2 agents · ● 1 live · $0.42 today' })).toBeDefined()
      await ui.unmount()
    }
    expect(ran.some(argv => argv.join(' ').includes('beta:agents list'))).toBe(true)
  })

  test('nothing above the prompt while nothing is waiting', async ($, on) => {
    mock.clock(on, { now: NOW })
    engine(on)
    await $.session.start(START)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Button', text: 'Allow' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('off in settings: no bar', { options: { enabled: false } }, async ($, on) => {
    engine(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: 'auto mode on' })).toBeDefined()
    await ui.unmount()
  })
})
