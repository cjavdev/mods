# cache-shot-clock

A [Claude Code](https://claude.com/claude-code) mod that puts a shot clock above the prompt: how long until the prompt cache expires and your next turn pays to write the whole conversation into the cache again.

```
Cache 3:42 ██████████████░░░░░░░░░░ 5m TTL · 121k tokens warm
```

Once it runs out:

```
Cache cold for 2m · next turn re-writes 121k tokens (5m TTL)
```

## Install

You need Claude Code 2.1.287 or newer.

```sh
git clone https://github.com/cjavdev/mods.git ~/mods
claude --plugin-dir ~/mods/cache-shot-clock
```

To load it in every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` (separate several folders with `:`):

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/mods/context-meter:~/mods/cache-shot-clock" } }
```

It stacks under other bands above the prompt, such as context-meter, rather than replacing them.

## What it shows

- **The clock** counts down from the cache TTL, restarting on every main-thread model request. A request that reads the cache refreshes the TTL just like one that writes it. The color fades from green to red as the TTL runs out.
- **The TTL** is `5m` or `1h`. The mod reads it from the session transcript: each response records whether its cache write went to the 5-minute or the 1-hour bucket. Until the first turn ends it assumes 5m and shows `5m?`. A cache hit after more than 5 minutes idle also proves the TTL is 1h.
- **The tokens** are what the next request re-sends: the last response's input, cache-read, cache-write and output tokens. On a cold cache, all of them are written again at the cache-write rate (1.25× base input for 5m, 2× for 1h).

A toast warns you when an idle cache has 60 seconds left.

Subagent requests don't move the clock, since they cache their own prefixes. A model switch, `/compact` or `/clear` resets it, because the new prefix has nothing cached yet.

## Settings

In `/config`, or under `pluginConfigs["cache-shot-clock"].options` in settings:

| Option | Default | |
| --- | --- | --- |
| `ttl` | `auto` | `auto`, `5m` or `1h`. Forces the TTL instead of reading it from the transcript. |
| `warnSeconds` | `60` | When to toast before an idle cache expires. `0` turns the toast off. |

## How it works

[`hooks/register.tsx`](./hooks/register.tsx):

- A `turn.step` hook reads each main-thread response's usage and restarts the clock.
- A `model.fork` hook restarts it when another mod's fork reads the main prefix, such as [cache-saver](../cache-saver).
- A `classic.Stop` hook tails the transcript after each turn and reads the newest `cache_creation` bucket to find the TTL.
- A one-second `$.clock.every` tick redraws the band and raises the warning.
- A `ui.render` hook on `AbovePrompt` draws the clock below whatever else is in the band.

The parsing and formatting are pure functions in [`hooks/clock.ts`](./hooks/clock.ts).

## Develop

```sh
claude plugin validate ~/mods/cache-shot-clock
claude plugin test ~/mods/cache-shot-clock
```
