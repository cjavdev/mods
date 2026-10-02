# context-meter

A [Claude Code](https://claude.com/claude-code) mod that shows how full your context window is, as a tiny meter in the bar under the prompt. You can see a `/compact` coming before it happens.

![The meter in the bar under the prompt](./screenshots/bar.png)

```
⏵⏵ auto mode on · ████░ 76% 152k/200k
```

- **The five cells** fill as the window does: one cell per 20%.
- **The percent** is the input tokens of the last response divided by the model's context window. It's the same number the status line reports as `used_percentage`.
- **The counts** are tokens used and the window size. A 1M-token model shows `49k/1M`.

Nothing shows until the first response of a session, or the first one after `/compact` or `/clear`, because there's no reading yet.

## Install

You need Claude Code 2.1.287 or newer.

```sh
git clone https://github.com/cjavdev/mods.git ~/mods
claude --plugin-dir ~/mods/context-meter
```

To load it in every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` (separate several folders with `:`):

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/mods/context-meter" } }
```

It shares the bar with [cache-shot-clock](../cache-shot-clock): the meter comes first, then the clock.

## Settings

In `/config`, or under `pluginConfigs["context-meter"].options` in settings:

| Option | Default | |
| --- | --- | --- |
| `enabled` | `true` | Turns the meter off without unloading the mod. |

## Why it doesn't match "N% context used"

Near the top, Claude Code shows its own warning, such as `93% context used`, while the meter reads `84%`. Claude Code measures against the **auto-compact threshold**, which is a little below the full window. context-meter measures against the **full window**. As a result, auto-compact usually fires while the meter reads around 85–90%.

## How it works

The mod is one hooks module, [`hooks/register.tsx`](./hooks/register.tsx):

- `$.session.usage()` reads the window's fill. The plain call doesn't count tokens, so it costs nothing.
- The reading is stored in session state (`$.state`, declared in [`types/index.d.ts`](./types/index.d.ts)). The bar redraws whenever the reading changes.
- The reading refreshes when:
  - the session starts
  - a tool call finishes, so the meter moves mid-turn
  - `session.measure` fires; the engine pushes it after each turn
  - a 3-second timer runs, which catches a model switch, `/compact` or `/clear` between turns
- A `ui.render` hook on the `PromptHint` component adds the meter as the hint line's `tail`. The terminal draws that line dim, so the meter has no color of its own. Other surfaces don't draw the tail yet.

The bar and token formatting are pure functions in [`hooks/meter.ts`](./hooks/meter.ts).

## Develop

```sh
claude plugin validate ~/mods/context-meter   # manifest and hooks check
claude plugin test ~/mods/context-meter       # runs tests/*.test.tsx
```

The screenshot is a real capture of Claude Code running the mod in tmux (`tmux capture-pane -p -e`), turned into a page with [`scripts/ansi2html.py`](../scripts/ansi2html.py) and screenshotted.
