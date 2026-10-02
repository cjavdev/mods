// One link in the bar: where it goes and the short text drawn for it.
export type Mention = { url: string; label: string }

// Newest first, each list already cut to its setting.
export type Links = { artifacts: Mention[]; prs: Mention[] }

declare module 'claude-code' {
  interface PluginState {
    'link-bar': { links: Links }
  }
}
