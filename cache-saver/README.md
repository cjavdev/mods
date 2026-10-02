# cache-saver

A [Claude Code](https://claude.com/claude-code) mod for when you walk away from a long session. Just before the idle prompt cache expires, it summarizes the conversation while the cache is still warm. When you come back to a cold cache, you choose how to continue:

![The choice cache-saver offers once the cache is cold](./screenshots/choice.png)

- **1 / A: keep the full session.** Nothing changes. Your next turn writes all 121k tokens to the cache again.
- **2 / B: continue from the summary.** `/compact` goes into the prompt box; press Enter and the conversation is replaced by the summary already built. No second summarizer request has to read the cold transcript.
- **3: preview** opens the summary in a pane.

If you type a message before choosing, it's held, shown under the choices, and sent once you pick.

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

## Why B goes through `/compact`

The engine skips a plugin's own hooks on any compaction that plugin's hook started. A compaction that cache-saver started itself would therefore go to Claude Code's summarizer, which reads the whole cold transcript. That is the cost this mod exists to avoid. Instead, pressing 2 arms the mod and puts `/compact` in the prompt box. When you press Enter, the compaction is yours, and cache-saver's `session.compact` hook answers it with the prepared summary. A `/compact` that you type yourself without arming, or one with instructions (`/compact focus on X`), still goes to Claude Code as usual.

## Settings

| Option | Default | |
| --- | --- | --- |
| `enabled` | `true` | Turns the mod off without unloading it. |
| `ttl` | `auto` | `auto` reads the TTL from the transcript; `5m` or `1h` forces it. |
| `leadSeconds` | `45` | How long before the idle cache expires to build the summary. |
| `minTokens` | `30000` | Sessions smaller than this get no summary. |

## Develop

```sh
claude plugin validate ~/mods/cache-saver
claude plugin test ~/mods/cache-saver
```

The tests drive a whole idle stretch on a mocked clock. They cover the summary built 45 seconds before expiry, a single fork per stretch, the choice appearing only once the cache is cold, a typed prompt held and then sent, B answering `/compact` with the summary without the engine's summarizer, and A leaving the session alone.
