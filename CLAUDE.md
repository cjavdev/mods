# mods

Claude Code mods: one folder per mod, each a plugin built on the function-hooks API. Load the `plugin-authoring` skill before writing or changing a mod.

## The root README

The root `README.md` has one section per mod, and every new mod gets one in the same shape. Keep them in this order inside the section:

1. An `##` heading with the mod's name.
2. A one or two sentence description of what it does for the person.
3. A link to the mod's folder: `[README and source →](./<mod>)`.
4. At least one screenshot from `<mod>/screenshots/`.
5. A settings table (`Setting`, `Default`, what it does) listing every `userConfig` field in the mod's `plugin.json`.

Also add the mod to the link list under the hero GIF and to the install commands. When a mod's settings change, update its table in both the root README and the mod's own README.

## Every mod

- Layout: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, `types/index.d.ts`, `tests/*.test.tsx`, `screenshots/`, `README.md`.
- An `enabled` boolean in `userConfig` (default `true`); `register` returns before hooking anything when it is `false`.
- `claude plugin validate <mod>` and `claude plugin test <mod>` both pass before a commit.
- Screenshots are real captures of the mod running in Claude Code, never mockups: run it in tmux, save the pane with `tmux capture-pane -p -e`, turn it into a page with `scripts/ansi2html.py`, and screenshot that page.
- Mods that depend on the cache TTL take a `testTtlSeconds` setting so a full cycle can be tested in about a minute.

## Things the hooks API does that are easy to get wrong

- A hook on a `$` call (`model.fork`, `process.run`, `ui.toast`) gets `{ value }` or `{ deny }` from `next(e)`, not the bare result. Hooks on engine events (`turn.step`, `session.compact`) get the result itself.
- The engine skips a plugin's own hooks on a dispatch that plugin started. `$.session.compact()` never reaches the caller's `session.compact` hook; `$.command.run({ command: 'compact' })` does, because the command is queued and run as the person's.
- Helpers that take `$` must be declared at the top level of the hooks module, or validation fails.
- The `PromptHint` `tail` (the bar under the prompt) is dim text, drawn by the terminal only. Letter hotkeys on band Buttons work only while the band has focus; bare digits work from an empty prompt box. `$.ui.ask` raises a menu that takes the keyboard by itself.
