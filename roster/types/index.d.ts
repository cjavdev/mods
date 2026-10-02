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

declare module 'claude-code' {
  interface PluginState {
    'roster': {
      list: SessionList
      selected: string | null
      // Session id -> when its watch ends (ms since epoch).
      watching: Record<string, number>
      now: number
    }
  }
}
