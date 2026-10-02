import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Fill } from '../types'
import { bar, compact } from './meter'

const fill = atom({ plugin: 'context-meter', key: 'fill' } as const, null)

// Reads the window's fill (the free call: no token counting) and stores it;
// a changed value redraws the meter.
const refresh = async ($: EngineInterface) => {
  const { context } = await $.session.usage()
  const now: Fill | null =
    context.tokens === undefined || context.percent === undefined
      ? null
      : { tokens: context.tokens, window: context.window, percent: context.percent }

  await update($, fill, prev =>
    prev?.tokens === now?.tokens && prev?.window === now?.window ? prev : now,
  )
}

export const register: Register = (on, options) => {
  // Off in /config: hook nothing at all.
  if (options.enabled === false) return

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    // Catches a model switch, /compact or /clear between turns.
    $.clock.every(3000, () => void refresh($))
    return result
  })

  // A tool result follows a model response, so the meter moves mid-turn.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  // The engine pushes this after each main-thread turn when the fill moved.
  on('session.measure', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  // A five-cell meter at the end of the hint row under the prompt:
  // `█░░░░ 5% 49k/1M`. Nothing until a response of the live window (a fresh
  // session, or one just compacted or cleared).
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const f = await read($, fill)
    if (f === null) return next(e)

    const { filled, empty } = bar(f.percent, 5)
    const meter = `${filled}${empty} ${f.percent}% ${compact(f.tokens)}/${compact(f.window)}`
    return next({ ...e, props: { ...e.props, tail: e.props.tail ? `${meter} · ${e.props.tail}` : meter } })
  })
}
