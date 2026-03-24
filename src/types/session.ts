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

export interface TaskConfig {
  readonly prompt: string
  readonly repos: readonly RepoConfig[]
  readonly maxTurns?: number
  readonly maxBudgetUsd?: number
  readonly deadlineSeconds?: number
}

export interface Session {
  readonly id: string
  readonly userId: string
  readonly status: SessionStatus
  readonly prompt: string
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
