// One agent as the fleet views list it: the fields the rows draw.
export type Agent = {
  id: string
  name: string
  slug: string
  model: string
  version: number
  description: string
  system: string
  tools: number
  mcp: string[]
  skills: number
  // A coordinator with a roster of other agents.
  isCoordinator: boolean
  // Some tool pauses for a person's approval before it runs.
  asks: boolean
  createdAt: number
}

export type Session = {
  id: string
  title: string
  status: string
  agentId: string
  agentName: string
  environmentId: string
  createdAt: number
  updatedAt: number
  activeSeconds: number
  outputTokens: number
  // List cost in cents.
  cost: number
}

export type Deployment = {
  id: string
  name: string
  status: string
  pausedReason: string | null
  agentId: string
  environmentId: string
  cron: string
  timezone: string
  lastRunAt: number | null
  // How the last run was started and what it cost: "manual · $1.52".
  lastRunNote: string
  upcoming: number[]
  prompt: string
}

export type Fleet = {
  org: string
  agents: Agent[]
  sessions: Session[]
  deployments: Deployment[]
  fetchedAt: number
  error: string | null
}

// One session event, cut down to what a feed row draws.
export type Ev = {
  id: string
  at: number
  type: string
  // Which agent's thread it happened on (multi-agent sessions).
  thread: string
  agent: string
  // A tool's name, a stop reason, or empty.
  name: string
  text: string
  // `ask` while a tool call waits for approval.
  permission: string
  toolUseId: string
  isError: boolean
  outputTokens: number
  inputTokens: number
  // Cumulative list cost in cents, on usage events; -1 elsewhere.
  cost: number
}

// A session being followed live.
export type Feed = {
  sessionId: string
  agentName: string
  title: string
  status: 'connecting' | 'running' | 'idle' | 'waiting' | 'ended' | 'error'
  events: Ev[]
  // The agent message being typed, before its event lands.
  draft: string
  startedAt: number
  outputTokens: number
  cost: number
  note: string
}

// A tool call a cloud agent is waiting on a person for.
export type Approval = {
  sessionId: string
  eventId: string
  agentName: string
  title: string
  tool: string
  input: string
  at: number
}

// Work Claude handed to a cloud agent.
export type Job = {
  id: number
  sessionId: string
  agentName: string
  task: string
  startedAt: number
  endedAt: number | null
  result: string
}

// One line of an `ant apply --dry-run` plan.
export type PlanRow = {
  action: 'create' | 'update' | 'delete' | 'unchanged' | 'other'
  kind: string
  name: string
  detail: string[]
}

export type Plan = {
  paths: string[]
  rows: PlanRow[]
  raw: string
  ranAt: number
  status: 'planning' | 'ready' | 'applying' | 'applied' | 'error'
  note: string
}

export type Nav = { view: 'fleet' | 'agent'; agentId: string }

export type Replay = {
  sessionId: string
  title: string
  agentName: string
  events: Ev[]
  cursor: number
  isPlaying: boolean
  cost: number
}

export type Bakeoff = { prompt: string; sessionIds: string[]; picked: string }

declare module 'claude-code' {
  interface PluginState {
    'ant-farm': {
      fleet: Fleet | null
      now: number
      nav: Nav
      feeds: Record<string, Feed>
      tv: string
      approvals: Approval[]
      jobs: Job[]
      plan: Plan | null
      replay: Replay | null
      bakeoff: Bakeoff | null
      farm: number
      // The session behind each ask, by the command's arguments as typed.
      asks: Record<string, string>
    }
  }
}
