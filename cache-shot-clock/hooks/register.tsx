import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Clock, Ttl, TtlSource } from '../types'
import { TTL_MS, bar, colorFor, compact, fmtAgo, fmtClock, prefixOf, ttlFromTranscript } from './clock'

const clock = atom({ plugin: 'cache-shot-clock', key: 'clock' } as const, null)
const now = atom({ plugin: 'cache-shot-clock', key: 'now' } as const, 0)

// How far past 5m a cache hit must land before it proves the TTL is 1h.
const SLACK_MS = 15_000
// The transcript tail read for the TTL: plenty of rows, never the whole file.
const TAIL_BYTES = '262144'

type Usage = Parameters<typeof prefixOf>[0]

// What we know between cache touches. Module variables start over on a
// reload; session.start seeds them back from state.
const mem = {
  forced: null as Ttl | null,
  ttl: '5m' as Ttl,
  ttlSource: 'assumed' as TtlSource,
  isWorking: false,
  warnedFor: 0,
}

async function learnTtl($: EngineInterface, next: Ttl, source: TtlSource) {
  if (mem.forced) return
  mem.ttl = next
  mem.ttlSource = source
  await update($, clock, prev =>
    prev && (prev.ttl !== next || prev.ttlSource !== source) ? { ...prev, ttl: next, ttlSource: source } : prev,
  )
}

// A main-thread request touched the cache: restart the clock.
async function touch($: EngineInterface, usage: Usage) {
  const at = await $.clock.now()
  const prev = await read($, clock)

  // A hit after a gap only a 1h entry survives settles the TTL by itself.
  if (
    prev &&
    mem.ttl === '5m' &&
    usage.cache_read_input_tokens > 0 &&
    at - prev.lastAt > TTL_MS['5m'] + SLACK_MS
  ) {
    await learnTtl($, '1h', 'observed')
  }

  const next: Clock = { lastAt: at, prefixTokens: prefixOf(usage), ttl: mem.ttl, ttlSource: mem.ttlSource }
  await update($, clock, () => next)
  await update($, now, () => at)
}

async function reset($: EngineInterface) {
  await update($, clock, () => null)
}

export const register: Register = (on, options) => {
  mem.forced = options.ttl === '5m' || options.ttl === '1h' ? options.ttl : null
  mem.ttl = mem.forced ?? '5m'
  mem.ttlSource = mem.forced ? 'setting' : 'assumed'
  const warnMs = Math.max(0, Number(options.warnSeconds ?? 60)) * 1000

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const prev = await read($, clock)
    if (prev && !mem.forced) {
      mem.ttl = prev.ttl
      mem.ttlSource = prev.ttlSource
    }
    await update($, now, () => Date.now())

    // One tick a second redraws the clock; the warning rides the same tick.
    $.clock.every(1000, async () => {
      const at = await $.clock.now()
      const c = await read($, clock)
      if (c === null) return
      const left = c.lastAt + TTL_MS[c.ttl] - at
      await update($, now, () => at)

      if (warnMs > 0 && !mem.isWorking && left > 0 && left <= warnMs && mem.warnedFor !== c.lastAt) {
        mem.warnedFor = c.lastAt
        $.ui.toast(`Prompt cache goes cold in ${fmtClock(left)}: the next turn re-writes ${compact(c.prefixTokens)} tokens after that`)
      }
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

  // Every main-thread request reads and extends the cache; subagents keep
  // their own prefixes and leave the main one alone.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage) await touch($, result.usage)
    return result
  })

  // A fork (another mod's `$.model.fork`) re-reads the main prefix; a hit
  // refreshes the entry just as a turn would.
  on('model.fork', async ($, e, next) => {
    const result = await next(e)
    if (result.isAnswered && result.usage.cache_read_input_tokens > 0) {
      const prev = await read($, clock)
      const at = await $.clock.now()
      if (prev) await update($, clock, () => ({ ...prev, lastAt: at }))
    }
    return result
  })

  // After each main turn the transcript holds the API's cache_creation
  // buckets, which say outright whether the write was 5m or 1h.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (!mem.forced) {
      const tail = await $.process
        .run(['tail', '-c', TAIL_BYTES, e.transcript_path], { timeoutMs: 5000 })
        .catch(() => null)
      const found = tail?.exitCode === 0 ? ttlFromTranscript(tail.stdout) : null
      if (found) await learnTtl($, found, 'transcript')
    }
    return result
  })

  // A switch forfeits the cache; the hook input also names the TTL.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    await reset($)
    if (!mem.forced) {
      mem.ttl = e.cache_ttl
      mem.ttlSource = 'model-switch'
    }
    return result
  })

  // A compaction or /clear starts a new prefix: nothing is cached for it yet.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.messages) await reset($)
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await reset($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const c = await read($, clock)
    if (c === null) return below

    const { Box, Text } = $.ui.resolve(e)
    const at = (await read($, now)) ?? Date.now()
    const ttlMs = TTL_MS[c.ttl]
    const left = c.lastAt + ttlMs - at
    const ttlLabel = `${c.ttl}${c.ttlSource === 'assumed' ? '?' : ''} TTL`
    const width = Math.max(8, Math.min(24, e.props.bodyColumns - 60))

    const mine =
      left > 0 ? (
        <Box key="cache-shot-clock">
          <Text dimColor>Cache </Text>
          <Text color={colorFor(left / ttlMs)} bold>
            {fmtClock(left)}
          </Text>
          <Text> </Text>
          <Text color={colorFor(left / ttlMs)}>{bar(left / ttlMs, width).filled}</Text>
          <Text dimColor>{bar(left / ttlMs, width).empty}</Text>
          <Text dimColor>{` ${ttlLabel} · ${compact(c.prefixTokens)} tokens warm`}</Text>
        </Box>
      ) : (
        <Box key="cache-shot-clock">
          <Text dimColor>Cache </Text>
          <Text color="#ec1313" bold>
            cold
          </Text>
          <Text dimColor>{` for ${fmtAgo(-left)} · next turn re-writes `}</Text>
          <Text bold>{compact(c.prefixTokens)}</Text>
          <Text dimColor>{` tokens (${ttlLabel})`}</Text>
        </Box>
      )

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
