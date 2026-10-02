import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cache, Offer, Ttl } from '../types'
import { TTL_MS, compact, fmtAgo, fmtClock, prefixOf, ttlFromTranscript } from './clock'

const cache = atom({ plugin: 'cache-saver', key: 'cache' } as const, null)
const offer = atom({ plugin: 'cache-saver', key: 'offer' } as const, null)
const now = atom({ plugin: 'cache-saver', key: 'now' } as const, 0)

const PREVIEW = 'cache-saver-summary'
const TAIL_BYTES = '262144'
// The fork has to start before the entry lapses to read it; past this little
// time left it would pay the full write it is meant to save.
const MIN_LEFT_MS = 3000
// Where a prompt comes from the person (the terminal, the desktop app, Remote
// Control), as opposed to a notification, a peer or a plugin.
const PERSON = new Set(['composer', 'sdk', 'bridge'])

const SUMMARY_PROMPT = `The prompt cache for this conversation is about to expire. Write a summary that lets you continue this work in a fresh context with nothing else to go on. Do not call tools and do not continue the task; reply with the summary alone, in Markdown, under these headings:

1. Primary request and intent: everything the user has asked for, in detail.
2. Key technical concepts: technologies, frameworks and decisions in play.
3. Files and code: every file examined, changed or created, why it matters, and the important snippets verbatim.
4. Errors and fixes: what went wrong and how it was resolved, including user feedback.
5. Problem solving: what is solved and what is still being worked out.
6. All user messages: every non-tool-result user message, verbatim or nearly so.
7. Pending tasks: what was asked for and is not done.
8. Current work: precisely what was happening just before this summary.
9. Next step: the next step in line with the user's latest request, quoting it where it helps.`

const wrapSummary = (summary: string) =>
  `This session is being continued from an earlier conversation that was summarized to avoid re-writing its expired prompt cache. The summary below covers everything before this point.\n\n${summary}`

type Usage = Parameters<typeof prefixOf>[0]

const mem = {
  forced: null as Ttl | null,
  ttl: '5m' as Ttl,
  leadMs: 45_000,
  minTokens: 30_000,
  isWorking: false,
  // The step a summary was already tried for: one try per idle stretch.
  triedStep: -1,
}

const cacheLeft = (c: Cache, at: number) => c.lastAt + TTL_MS[c.ttl] - at

async function learnTtl($: EngineInterface, ttl: Ttl) {
  if (mem.forced) return
  mem.ttl = ttl
  await update($, cache, prev => (prev && prev.ttl !== ttl ? { ...prev, ttl } : prev))
}

// A main-thread response: the cache is fresh, and any summary is stale.
async function touch($: EngineInterface, usage: Usage) {
  const at = await $.clock.now()
  const prev = await read($, cache)
  if (prev && mem.ttl === '5m' && usage.cache_read_input_tokens > 0 && at - prev.lastAt > TTL_MS['5m'] + 15_000) {
    await learnTtl($, '1h')
  }
  const next: Cache = { lastAt: at, prefixTokens: prefixOf(usage), ttl: mem.ttl, step: (prev?.step ?? 0) + 1 }
  await update($, cache, () => next)
  await update($, offer, o => (o && o.status !== 'compacting' && o.held === null ? null : o))
}

async function forget($: EngineInterface) {
  await update($, cache, () => null)
  await update($, offer, () => null)
}

// Summarize over the still-warm prefix: a fork reads it from the cache at a
// tenth of the input price, where the same tokens cold cost a full write.
async function prepare($: EngineInterface, c: Cache) {
  mem.triedStep = c.step
  await update($, offer, () => ({
    status: 'preparing',
    step: c.step,
    summary: '',
    summaryTokens: 0,
    fullTokens: c.prefixTokens,
    held: null,
  }))

  const reply = await $.model.fork({ prompt: SUMMARY_PROMPT }).catch(
    (err: unknown) => ({ isAnswered: false as const, reason: String(err) }),
  )
  if (!reply.isAnswered || reply.text.trim() === '') {
    $.ui.log(`cache-saver: no summary (${reply.isAnswered ? 'empty reply' : reply.reason})`, { to: 'debug' })
    await update($, offer, o => (o?.step === c.step && o.status === 'preparing' ? null : o))
    return
  }

  // The fork's read refreshed the entry: it lives a full TTL from now.
  if (reply.usage.cache_read_input_tokens > 0) {
    const at = await $.clock.now()
    await update($, cache, prev => (prev && prev.step === c.step ? { ...prev, lastAt: at } : prev))
  }
  await update($, offer, o =>
    o?.step === c.step && o.status === 'preparing'
      ? { ...o, status: 'ready', summary: reply.text.trim(), summaryTokens: reply.usage.output_tokens }
      : o,
  )
}

// A: keep the full conversation; the next turn re-writes the cache.
async function keepFull($: EngineInterface) {
  const o = await read($, offer)
  if (!o || (o.status !== 'ready' && o.status !== 'armed')) return
  if (o.status === 'armed') await disarm($)
  await update($, offer, () => null)
  void $.ui.close({ id: PREVIEW }).catch(() => undefined)
  if (o.held) await $.prompt.submit({ text: o.held })
}

// B: swap the conversation for the summary. The engine skips a plugin's own
// hooks on a compaction its hook started, so the compaction has to be the
// person's: `/compact` goes in the prompt box, and Enter runs it through the
// session.compact hook below, which answers with the summary built earlier.
async function useSummary($: EngineInterface) {
  const o = await read($, offer)
  if (!o || o.status !== 'ready') return
  void $.ui.close({ id: PREVIEW }).catch(() => undefined)
  const filled = await $.prompt.fill({ text: '/compact' })
  await update($, offer, () => ({ ...o, status: 'armed' }))
  if (!filled.isFilled) $.ui.toast('cache-saver: run /compact to continue from the summary')
}

// Back out of B: the box is the person's again.
async function disarm($: EngineInterface) {
  await update($, offer, o => (o?.status === 'armed' ? { ...o, status: 'ready' } : o))
  const box = await $.prompt.read()
  if (box.text.trim() === '/compact') await $.prompt.fill({ text: '' })
}

async function preview($: EngineInterface) {
  await $.ui.open({ id: PREVIEW, title: 'Session summary (option B)' })
}

export const register: Register = (on, options) => {
  // Off in /config: hook nothing at all.
  if (options.enabled === false) return

  mem.forced = options.ttl === '5m' || options.ttl === '1h' ? options.ttl : null
  mem.ttl = mem.forced ?? '5m'
  mem.leadMs = Math.max(5, Number(options.leadSeconds ?? 45)) * 1000
  mem.minTokens = Math.max(0, Number(options.minTokens ?? 30_000))

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const c = await read($, cache)
    if (c && !mem.forced) mem.ttl = c.ttl
    // A summary left half-built by a reload will never finish.
    await update($, offer, o => (o?.status === 'ready' || o?.status === 'armed' ? { ...o, status: 'ready' } : null))

    $.clock.every(1000, async () => {
      const at = await $.clock.now()
      await update($, now, () => at)

      const c = await read($, cache)
      if (!c || mem.isWorking || c.prefixTokens < mem.minTokens || mem.triedStep === c.step) return
      const left = cacheLeft(c, at)
      if (left <= mem.leadMs && left > MIN_LEFT_MS) void prepare($, c)
    })
    return result
  })

  on('turn.start', async ($, e, next) => {
    mem.isWorking = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) mem.isWorking = false
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage) await touch($, result.usage)
    return result
  })

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (!mem.forced) {
      const tail = await $.process
        .run(['tail', '-c', TAIL_BYTES, e.transcript_path], { timeoutMs: 5000 })
        .catch(() => null)
      const found = tail?.exitCode === 0 ? ttlFromTranscript(tail.stdout) : null
      if (found) await learnTtl($, found)
    }
    return result
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    await forget($)
    if (!mem.forced) mem.ttl = e.cache_ttl
    return result
  })

  // B armed: the person's /compact gets the summary built over the warm
  // cache, so no summarizer request re-reads the cold transcript. Any other
  // compaction leaves a new prefix with nothing cached for it.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const o = await read($, offer)
    if (o?.status === 'armed' && (e.trigger === 'manual' || e.trigger === 'plugin') && !e.instructions) {
      await forget($)
      $.ui.toast(`Continuing from the summary: ${compact(o.summaryTokens)} tokens instead of ${compact(o.fullTokens)}`)
      if (o.held) {
        const held = o.held
        $.clock.after(0, () => void $.prompt.submit({ text: held }))
      }
      return {
        messages: [{ role: 'user', text: wrapSummary(o.summary), toolUses: [] }],
        tokensBefore: o.fullTokens,
        tokensAfter: o.summaryTokens,
      }
    }
    const result = await next(e)
    if (result.messages) await forget($)
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await forget($)
    return next(e)
  })

  // Typed before choosing: hold it, and send it once A or B is picked.
  on('prompt.submit', async ($, e, next) => {
    const o = await read($, offer)
    const c = await read($, cache)
    const isCold = c !== null && cacheLeft(c, await $.clock.now()) <= 0
    const isChoosing = o !== null && (o.status === 'ready' || o.status === 'armed')
    if (!o || !isChoosing || !isCold || !PERSON.has(e.origin.kind) || e.text.trimStart().startsWith('/')) return next(e)

    const held = o.held ? `${o.held}\n\n${e.text}` : e.text
    await update($, offer, prev => (prev ? { ...prev, held } : prev))
    return {
      drop:
        o.status === 'armed'
          ? 'cache-saver: held until /compact runs; it sends after'
          : 'cache-saver: held until you pick 1 (keep full session) or 2 (continue from summary) above',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PREVIEW }, async ($, e) => {
    const { Box, Markdown, Text } = $.ui.resolve(e)
    const o = await read($, offer)
    if (!o || o.status !== 'ready') {
      return (
        <Box>
          <Text dimColor>No summary waiting.</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text dimColor>{`${compact(o.summaryTokens)} tokens, in place of ${compact(o.fullTokens)}`}</Text>
        <Markdown text={o.summary.slice(0, 10_000)} />
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const o = await read($, offer)
    const c = await read($, cache)
    if (e.props.hasSurvey || !o || !c) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const at = (await read($, now)) ?? Date.now()
    const left = cacheLeft(c, at)
    let mine

    if (o.status === 'preparing') {
      mine = (
        <Box key="cache-saver">
          <Text dimColor>{`cache-saver: summarizing ${compact(o.fullTokens)} tokens while the cache is warm…`}</Text>
        </Box>
      )
    } else if (o.status === 'compacting') {
      mine = (
        <Box key="cache-saver">
          <Text dimColor>cache-saver: switching to the summary…</Text>
        </Box>
      )
    } else if (o.status === 'armed') {
      mine = (
        <Box key="cache-saver" flexDirection="column">
          <Text>
            <Text bold>Press Enter</Text>
            <Text dimColor>{` to run /compact and continue from the ${compact(o.summaryTokens)}-token summary`}</Text>
          </Text>
          <Box>
            <Button key="keep-full" hotkey="1" plain dimColor label="Keep full session instead" onPress={() => keepFull($)} />
          </Box>
        </Box>
      )
    } else if (left > 0) {
      mine = (
        <Box key="cache-saver">
          <Text dimColor>{`cache-saver: summary ready (${compact(o.summaryTokens)} tokens), offered if the cache goes cold in ${fmtClock(left)}`}</Text>
        </Box>
      )
    } else if (!e.props.isWorking) {
      const saved = Math.round((1 - o.summaryTokens / Math.max(1, o.fullTokens)) * 100)
      mine = (
        <Box key="cache-saver" flexDirection="column">
          <Text>
            <Text bold>Prompt cache went cold </Text>
            <Text dimColor>{`${fmtAgo(-left)} ago. How do you want to continue?`}</Text>
          </Text>
          <Box>
            <Button key="keep-full" hotkey="1" variant="secondary" label={`A · Keep full session`} onPress={() => keepFull($)} />
            <Text dimColor>{`  re-cache ${compact(o.fullTokens)} tokens`}</Text>
          </Box>
          <Box>
            <Button key="use-summary" hotkey="2" variant="primary" label={`B · Continue from summary`} onPress={() => useSummary($)} />
            <Text dimColor>{`  ${compact(o.summaryTokens)} tokens (${saved}% smaller)`}</Text>
          </Box>
          <Box>
            <Button key="preview" hotkey="3" plain dimColor label="Preview summary" onPress={() => preview($)} />
          </Box>
          {o.held !== null && <Text dimColor>{`Held: “${o.held.slice(0, 60)}${o.held.length > 60 ? '…' : ''}” sends after you choose`}</Text>}
        </Box>
      )
    }

    if (!mine) return below
    return below ? (
      <Box flexDirection="column">
        {below}
        {mine}
      </Box>
    ) : (
      mine
    )
  })
}
