import { describe, expect, test } from 'claude-code/testing'
import type { Args, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { findMentions, remember, transcriptTexts } from '../hooks/links'

const HINT = {
  plugin: 'link-bar',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

const ART = (id: string) => `https://claude.ai/artifact/${id}`
const PR = (n: number) => `https://github.com/cjavdev/mods/pull/${n}`

// What the engine answers beneath the plugins: the hint row as one Text.
const engine = (on: On) => {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.hint}</Text>
  })
}

// A test cannot stand in for the store beneath session.append (an answer
// without next is skipped), so the bottom throws once the plugins have run.
const append = ($: Engine, row: Args<'session.append'>) => $.session.append(row).catch(() => undefined)

let n = 0
const say = (role: 'user' | 'assistant', text: string, extra: Partial<Args<'session.append'>> = {}): Args<'session.append'> => ({
  message: { type: role, role, content: [{ type: 'text', text }] },
  door: role === 'user' ? 'prompt' : 'response',
  origin: role === 'user' ? { kind: 'composer' } : { kind: 'model', model: 'm' },
  uuid: `u${++n}`,
  ...extra,
})

describe('helpers', () => {
  test('finds artifacts and pull requests in the order written', async () => {
    const found = findMentions(
      `Opened ${PR(1)}/files and [UX picks](${ART('DhK2K2zTdLYmEFxd6ceWVi')}), see https://example.com and ${ART('abcdef123')}.`,
    )
    expect(found.map(f => [f.kind, f.url, f.label])).toEqual([
      ['pr', PR(1), 'mods#1'],
      ['artifact', ART('DhK2K2zTdLYmEFxd6ceWVi'), 'UX picks'],
      ['artifact', ART('abcdef123'), 'artifact abcdef'],
    ])
  })

  test('code artifact links count too', async () => {
    const url = 'https://claude.ai/code/artifact/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab'
    expect(findMentions(url).map(f => f.url)).toEqual([url])
  })

  test('newest first, deduplicated, cut to the max, labels kept', async () => {
    let list = remember([], findMentions(`[Plan](${ART('a1')}) ${ART('b2')}`), 3)
    expect(list.map(m => m.label)).toEqual(['artifact b2', 'Plan'])
    list = remember(list, findMentions(`${ART('a1')} ${ART('c3')} ${ART('d4')}`), 3)
    expect(list.map(m => m.label)).toEqual(['artifact d4', 'artifact c3', 'Plan'])
  })

  test('reads prompts and replies back from a transcript', async () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { content: `look at ${PR(3)}` } }),
      JSON.stringify({ type: 'user', isMeta: true, message: { content: PR(4) } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: PR(5) }] } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: PR(6) }] } }),
      'not json',
    ].join('\n')
    expect(transcriptTexts(jsonl)).toEqual([`look at ${PR(3)}`, PR(5)])
  })
})

describe('bar', () => {
  test('nothing added until a link is mentioned', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await append($, say('user', 'hello'))
    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    await ui.unmount()
  })

  test('three artifacts and five pull requests, most recent first', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await append($, say('user', `${ART('a1')} ${PR(1)} ${PR(2)} ${PR(3)}`))
    await append($, say('assistant', `${ART('b2')} [Plan](${ART('c3')}) ${PR(4)} ${PR(5)} ${PR(6)}`))
    await append($, say('assistant', `${ART('d4')} again ${PR(2)}`))

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...HINT, surface })
      expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
      const shown = (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
      expect(shown).toEqual([ART('d4'), ART('c3'), ART('b2'), PR(2), PR(6), PR(5), PR(4), PR(3)])
      expect(await ui.find({ type: 'Link', text: 'Plan' })).toBeDefined()
      expect(await ui.find({ type: 'Link', text: 'mods#2' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('tool output, reminders and subagents do not count', async ($, on) => {
    engine(on)
    await $.session.start(START)
    await append($, say('user', PR(7), { message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: PR(7) }] } }))
    await append($, say('assistant', PR(8), { agentId: 'sub' }))
    await append($, say('user', PR(9), { door: 'tool-result' }))
    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    await ui.unmount()
  })

  test('a resumed session reads its links back from the transcript', async ($, on) => {
    engine(on)
    const jsonl = [
      JSON.stringify({ type: 'user', message: { content: `review ${PR(11)}` } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `[Deck](${ART('z9')}) and ${PR(12)}` }] } }),
    ].join('\n')
    on('process.run', (_$, e) =>
      e.argv[0] === 'tail' && e.argv[3] === '/t.jsonl'
        ? { value: { exitCode: 0, stdout: jsonl, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
        : { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } },
    )
    await $.session.start(START)
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/t.jsonl' })
    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect((await ui.findAll({ type: 'Link' })).map(l => l.props.href)).toEqual([ART('z9'), PR(12), PR(11)])

    await $.classic.SessionStart({ source: 'clear' })
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    await ui.unmount()
  })

  test('settings change how many', { options: { artifacts: 0, pullRequests: 1 } }, async ($, on) => {
    engine(on)
    await $.session.start(START)
    await append($, say('assistant', `${ART('a1')} ${PR(1)} ${PR(2)}`))
    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect((await ui.findAll({ type: 'Link' })).map(l => l.props.href)).toEqual([PR(2)])
    await ui.unmount()
  })

  test('off in /config: the bar is left alone', { options: { enabled: false } }, async ($, on) => {
    engine(on)
    await $.session.start(START)
    await append($, say('assistant', PR(1)))
    const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    await ui.unmount()
  })
})
