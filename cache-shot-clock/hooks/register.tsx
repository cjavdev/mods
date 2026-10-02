import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Clock, Ttl, TtlSource } from '../types'
import { TTL_MS, bigDigits, compact, fmtAgo, fmtClock, fmtShot, prefixOf, ttlFromTranscript } from './clock'

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
  warnMs: 60_000,
  // The big LED clock shows from this much time left until BIG_AFTER_MS past
  // the buzzer; 0 keeps it to the bar under the prompt.
  bigMs: 15_000,
  // For testing: count down from this instead of the real TTL; 0 is off.
  testMs: 0,
  warnedFor: 0,
  buzzedFor: 0,
  // The 100ms timer that runs the tenths through the last ten seconds.
  fast: null as { cancel: () => void } | null,
}

// How long the clock runs: the cache's TTL, or the test override.
const ttlMs = (c: Clock) => mem.testMs || TTL_MS[c.ttl]

// LED amber on the floor, red when it's under ten.
const AMBER = '#ffb000'
const RED = '#ff3030'
const DARK_RED = '#7a1010'
const PANEL = '#000000'
// How long the violation stays up after the buzzer before the clock folds
// back into the bar.
const BIG_AFTER_MS = 10_000

// Whether the big LED clock is up: the last seconds and just past the buzzer.
const isBig = (left: number) => mem.bigMs > 0 && left <= mem.bigMs && left > -BIG_AFTER_MS

// The bar's clock: 04:59, 59:53, 1:02:03 past an hour, 00:00 once cold.
const barClock = (left: number) => fmtClock(left).padStart(5, '0')

// One redraw: the time, the warning, the buzzer, and the tenths timer.
async function tick($: EngineInterface) {
  const at = await $.clock.now()
  await update($, now, () => at)
  const c = await read($, clock)
  if (c === null) return
  const left = c.lastAt + ttlMs(c) - at

  if (mem.warnMs > 0 && mem.warnMs < ttlMs(c) && !mem.isWorking && left > 0 && left <= mem.warnMs && mem.warnedFor !== c.lastAt) {
    mem.warnedFor = c.lastAt
    $.ui.toast(`Shot clock: ${fmtClock(left)} left on the prompt cache (${compact(c.prefixTokens)} tokens)`)
  }

  if (left <= 0 && left > -5000 && mem.buzzedFor !== c.lastAt) {
    mem.buzzedFor = c.lastAt
    $.ui.toast(`BZZZT! Shot clock violation: the prompt cache expired. The next turn re-writes ${compact(c.prefixTokens)} tokens.`)
  }

  if (left > 0 && left <= 11_000 && mem.fast === null) {
    mem.fast = $.clock.every(100, () => void tick($))
  } else if ((left <= 0 || left > 11_000) && mem.fast !== null) {
    mem.fast.cancel()
    mem.fast = null
  }
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
  // Off in /config: hook nothing at all.
  if (options.enabled === false) return

  mem.forced = options.ttl === '5m' || options.ttl === '1h' ? options.ttl : null
  mem.ttl = mem.forced ?? '5m'
  mem.ttlSource = mem.forced ? 'setting' : 'assumed'
  mem.warnMs = Math.max(0, Number(options.warnSeconds ?? 60)) * 1000
  mem.fast = null
  mem.bigMs = Math.max(0, Number(options.bigAt ?? 15)) * 1000
  mem.testMs = Math.max(0, Number(options.testTtlSeconds ?? 0)) * 1000

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const prev = await read($, clock)
    if (prev && !mem.forced) {
      mem.ttl = prev.ttl
      mem.ttlSource = prev.ttlSource
    }
    await update($, now, () => Date.now())

    // One tick a second; the last ten seconds tick in tenths.
    $.clock.every(1000, () => void tick($))
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
    // A call on `$` reaches its hooks as `{ value }` (or `{ deny }`).
    const reply = result.value
    if (reply?.isAnswered && reply.usage.cache_read_input_tokens > 0) {
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

  // Most of the time: just `⏱ 04:59` at the end of the hint row under the
  // prompt, beside the mode and the running shells. It steps aside while the
  // big clock is up.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const c = await read($, clock)
    if (c === null) return next(e)

    const at = (await read($, now)) ?? Date.now()
    const left = c.lastAt + ttlMs(c) - at
    if (isBig(left)) return next(e)

    const tail = `⏱ ${barClock(left)}`
    return next({ ...e, props: { ...e.props, tail: e.props.tail ? `${e.props.tail} · ${tail}` : tail } })
  })

  // The last seconds: the big LED clock above the prompt, through the buzzer.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const c = await read($, clock)
    if (c === null) return below

    const at = (await read($, now)) ?? Date.now()
    const left = c.lastAt + ttlMs(c) - at
    if (!isBig(left)) return below

    const { Box, Text } = $.ui.resolve(e)
    const isViolation = left <= 0
    const digitColor = left <= 10_000 ? RED : AMBER
    const rows = bigDigits(fmtShot(left))
    const ttlLabel = mem.testMs ? `${mem.testMs / 1000}s test TTL` : `${c.ttl}${c.ttlSource === 'assumed' ? '?' : ''} TTL`
    const tokens = compact(c.prefixTokens)

    const side = isViolation
      ? [
          <Text color={RED} bold>
            SHOT CLOCK VIOLATION
          </Text>,
          <Text dimColor>{`Prompt cache cold for ${fmtAgo(-left)}`}</Text>,
          <Text dimColor>{`Next turn re-writes ${tokens} tokens (${ttlLabel})`}</Text>,
        ]
      : [
          <Text bold>SHOT CLOCK</Text>,
          <Text dimColor>{`Prompt cache · ${ttlLabel}`}</Text>,
          <Text dimColor>{`${tokens} tokens on the line`}</Text>,
        ]

    const mine = (
      <Box key="cache-shot-clock">
        <Box borderStyle="bold" borderColor="#444444" backgroundColor={PANEL} flexDirection="column" paddingX={1}>
          {rows.map(row => (
            <Text color={isViolation && Math.floor(-left / 1000) % 2 === 1 ? DARK_RED : digitColor} backgroundColor={PANEL} bold>
              {row}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
          {side}
        </Box>
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
