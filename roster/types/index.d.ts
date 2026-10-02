export type SessionStatus = 'running' | 'rescheduling' | 'idle' | 'terminated'

// One Managed Agents session as the pane draws it.
export type AgentSession = {
  id: string
  title: string | null
  status: SessionStatus
  agent: string | null
  agentVersion: number | null
  // Whole US cents, as the API reports list cost.
  costCents: number | null
  capCents: number | null
  deploymentId: string | null
  createdAt: number
  updatedAt: number
}

export type SessionList = {
  sessions: AgentSession[]
  // When the list was last loaded (ms since epoch); 0 before the first load.
  loadedAt: number
  isLoading: boolean
  // Why the last load failed, in words for the person.
  error: string | null
}

// One event of a session's transcript, cut down to what the session view draws.
export type SessionEvent = {
  id: string
  type: string
  at: number
  text: string | null
  // A tool use's tool, and its input in one line.
  name: string | null
  input: string | null
  // A status event's stop reason, and the events it waits on.
  why: string | null
  ids: string[]
  isError: boolean
}

// One open session view: its transcript as last loaded.
export type SessionView = {
  events: SessionEvent[]
  loadedAt: number
  isLoading: boolean
  error: string | null
  // What the last send did, for the line under the box.
  sent: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'roster': {
      list: SessionList
      selected: string | null
      // The session the pane shows instead of the list.
      viewing: string | null
      // Session id -> when its watch ends (ms since epoch).
      watching: Record<string, number>
      // Session id -> its open view.
      views: Record<string, SessionView>
      now: number
    }
  }
}
