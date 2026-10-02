import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Links } from '../types'
import { findMentions, remember, textOf, transcriptTexts } from './links'

const links = atom({ plugin: 'link-bar', key: 'links' } as const, { artifacts: [], prs: [] })

const EMPTY: Links = { artifacts: [], prs: [] }
// How much of a resumed transcript to read back: the recent end, never the whole file.
const TAIL_BYTES = '4194304'

// How many of each the bar keeps. Module variables start over on a reload;
// register sets them again from the settings.
const max = { artifacts: 3, prs: 5 }

// Adds what one message mentions to the front of the lists.
async function note($: EngineInterface, text: string) {
  const found = findMentions(text)
  if (found.length === 0) return
  await update($, links, prev => {
    const cur = prev ?? EMPTY
    return {
      artifacts: remember(cur.artifacts, found.filter(f => f.kind === 'artifact'), max.artifacts),
      prs: remember(cur.prs, found.filter(f => f.kind === 'pr'), max.prs),
    }
  })
}

export const register: Register = (on, options) => {
  // Off in /config: hook nothing at all.
  if (options.enabled === false) return

  max.artifacts = Math.max(0, Math.floor(Number(options.artifacts ?? 3)))
  max.prs = Math.max(0, Math.floor(Number(options.pullRequests ?? 5)))

  // Every row the conversation keeps passes here. The person's prompts and
  // the model's replies count as mentions; tool output, reminders and
  // subagents' rows do not.
  // A row is never refused below a plugin, so it is noted on the way down.
  on('session.append', async ($, e, next) => {
    const isMention =
      e.agentId === undefined && !e.message.isMeta && (e.door === 'prompt' || e.door === 'response')
    if (isMention) await note($, textOf(e.message.content))
    return next(e)
  })

  // A resumed session's rows are loaded, not appended: read them back from
  // the transcript. /clear starts the lists over.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source === 'clear') {
      await update($, links, () => EMPTY)
    } else if (e.source === 'resume' || e.source === 'fork') {
      const tail = await $.process
        .run(['tail', '-c', TAIL_BYTES, e.transcript_path], { timeoutMs: 5000 })
        .catch(() => null)
      if (tail?.exitCode === 0) await note($, transcriptTexts(tail.stdout).join('\n'))
    }
    return result
  })

  // The bar under the prompt: the engine's own line, then a row of links
  // under it. `tail` is plain text cut at the row's end, so the links get a
  // row of their own beside the engine's drawing, each a real hyperlink.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const below = await next(e)
    const l = (await read($, links)) ?? EMPTY
    if (l.artifacts.length === 0 && l.prs.length === 0) return below

    const { Box, Text, Link } = $.ui.resolve(e)
    const group = (title: string, items: Links['prs']) => [
      <Text dimColor>{`${title} `}</Text>,
      ...items.flatMap((m, i) => [...(i > 0 ? [<Text dimColor>{' · '}</Text>] : []), <Link href={m.url}>{m.label}</Link>]),
    ]
    const groups = [
      ...(l.artifacts.length ? [group('Artifacts', l.artifacts)] : []),
      ...(l.prs.length ? [group('PRs', l.prs)] : []),
    ]
    const row = groups.flatMap((g, i) => [...(i > 0 ? [<Text dimColor>{'   '}</Text>] : []), ...g])

    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" paddingLeft={2}>
          {row}
        </Box>
      </Box>
    )
  })
}
