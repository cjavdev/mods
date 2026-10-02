# cache-saver

A [Claude Code](https://claude.com/claude-code) mod for when you walk away from a long session. Just before the idle prompt cache expires, it summarizes the conversation while the cache is still warm. When you come back to a cold cache, a menu asks how to continue:

![The menu cache-saver raises once the cache is cold](./screenshots/menu.png)

- **Keep full session.** Nothing changes. Your next turn writes the whole conversation to the cache again.
- **Continue from summary.** The conversation is replaced by the summary already built, at once. No second summarizer request has to read the cold transcript.
- **Preview the summary first** opens it in a pane.

Pick with the arrow keys and Enter, or press the option's number.

If you close the menu with Esc, the same choice stays above the prompt:

![The choice above the prompt, after the menu is dismissed](./screenshots/choice.png)

There, press 1 or 2, or type `a` or `b` and press Enter. Anything else you type before choosing is held, shown under the choices, and sent once you pick.

## Install

You need Claude Code 2.1.287 or newer.

```sh
git clone https://github.com/cjavdev/mods.git ~/mods
claude --plugin-dir ~/mods/cache-saver
```

Or add `~/mods/cache-saver` to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. It works well alongside [cache-shot-clock](../cache-shot-clock).

## What it costs

The summary is a `$.model.fork` of the main thread. It's sent while the cache is warm, so its prefix is a cache read (0.1× base input), plus the summary's output tokens. One fork per idle stretch. Sessions smaller than `minTokens` are skipped, because re-caching them is cheap anyway.

The fork's cache read also refreshes the cache entry, so the cache stays warm for one more TTL after the summary is built. The choice only appears once it is actually cold. If you come back before then, just keep working: the summary is dropped when the next response arrives.

## Why the summary goes through `/compact`

The engine skips a plugin's own hooks on any compaction that plugin starts directly. A compaction cache-saver started that way would go to Claude Code's summarizer, which reads the whole cold transcript. That is the cost this mod exists to avoid. So when you pick the summary, cache-saver runs `/compact` as a queued command, the way you would by typing it. That compaction reaches cache-saver's `session.compact` hook, which answers with the prepared summary, and Claude Code's summarizer never runs.

A `/compact` that you type yourself, or one with instructions (`/compact focus on X`), still goes to Claude Code as usual.

## Settings

| Option | Default | |
| --- | --- | --- |
| `enabled` | `true` | Turns the mod off without unloading it. |
| `ttl` | `auto` | `auto` reads the TTL from the transcript; `5m` or `1h` forces it. |
| `leadSeconds` | `45` | How long before the idle cache expires to build the summary. |
| `minTokens` | `30000` | Sessions smaller than this get no summary. |
| `testTtlSeconds` | `0` | For testing: treat the cache as expiring after this many seconds. `0` is off. |

### Test it in about a minute

With a 1-hour cache, the choice shows up two hours after you go idle. `testTtlSeconds` runs the whole cycle on a short clock instead. The real cache stays warm, so the summary is still cheap:

```sh
claude --settings '{"pluginConfigs":{"cache-saver":{"options":{"testTtlSeconds":40,"leadSeconds":20}},"cache-shot-clock":{"options":{"testTtlSeconds":40}}}}'
```

Send one prompt and wait. The summary is built about 20 seconds after the reply, and the choice appears about 45 seconds after that. The session needs at least `minTokens` of context, which a fresh session with a few connectors already has.

## Develop

```sh
claude plugin validate ~/mods/cache-saver
claude plugin test ~/mods/cache-saver
```

The tests drive a whole idle stretch on a mocked clock. They cover the summary built 45 seconds before expiry, a single fork per stretch, the choice appearing only once the cache is cold, a typed prompt held and then sent, the choice typed as `a` or `b`, `/compact` answered with the summary without the engine's summarizer, and the short test TTL.
