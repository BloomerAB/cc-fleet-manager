export type SessionStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "waiting_for_input"
  | "timed_out"
  | "cancelled"

export interface RepoConfig {
  readonly url: string
  readonly branch?: string
}

// Repo source modes — how Claude discovers which repos to work with
export interface DirectRepoSource {
  readonly mode: "direct"
  readonly repos: readonly RepoConfig[]
}

export interface OrgRepoSource {
  readonly mode: "org"
  readonly org: string
  readonly pattern?: string // glob pattern to filter repo names
}

export interface DiscoveryRepoSource {
  readonly mode: "discovery"
  readonly org: string
  readonly hint?: string // natural language hint for Claude
}

export type RepoSource = DirectRepoSource | OrgRepoSource | DiscoveryRepoSource

export interface TaskConfig {
  readonly prompt: string
  readonly repoSource: RepoSource
  readonly maxTurns?: number
  readonly maxBudgetUsd?: number
  readonly deadlineSeconds?: number
}

export interface Session {
  readonly id: string
  readonly userId: string
  readonly status: SessionStatus
  readonly prompt: string
  readonly repoSource: RepoSource
  readonly repos: readonly RepoConfig[]
  readonly maxTurns: number
  readonly maxBudgetUsd: number
  readonly deadlineSeconds: number
  readonly result: SessionResult | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly startedAt: string | null
  readonly completedAt: string | null
}

export interface SessionResult {
  readonly success: boolean
  readonly summary: string
  readonly prUrl?: string
  readonly costUsd?: number
  readonly turnsUsed?: number
}
