# mods

Mods for [Claude Code](https://claude.com/claude-code): small plugins built on Claude Code's function-hooks API that change what the terminal UI shows.

| Mod | What it does |
| --- | --- |
| [context-meter](./context-meter) | A bar above the prompt showing how full the context window is, fading from green to red as it fills. |
| [cache-shot-clock](./cache-shot-clock) | A countdown above the prompt to when the prompt cache expires and the next turn pays a full cache write. |
| [cache-saver](./cache-saver) | Summarizes an idle session while its cache is still warm, then lets you pick: keep the full session (re-cache it) or continue from the summary. |

![context-meter](./context-meter/screenshots/progression.png)

## Using a mod

Clone the repo, then point Claude Code at the mod's folder:

```sh
git clone https://github.com/cjavdev/mods.git ~/mods
claude --plugin-dir ~/mods/context-meter
```

Each mod's README covers loading it in every session.

> The function-hooks API is early access and may change between Claude Code releases. These mods were built and tested on Claude Code 2.1.287.
