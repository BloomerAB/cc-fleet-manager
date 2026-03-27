import { types as cassandraTypes } from "cassandra-driver"
import type { Client } from "cassandra-driver"
import type { SessionStatus, SessionResult, RepoSource, RepoConfig, PermissionMode, ModelChoice, StageState } from "../types/index.js"

interface CreateSessionInput {
  readonly userId: string
  readonly prompt: string
  readonly repoSource: RepoSource
  readonly rules?: string
  readonly permissionMode?: PermissionMode
  readonly model?: ModelChoice
  readonly maxTurns?: number
  readonly maxBudgetUsd?: number
  readonly pipelineId?: string
  readonly stageState?: StageState
}

interface Session {
  readonly id: string
  readonly userId: string
  readonly status: SessionStatus
  readonly prompt: string
  readonly repoSource: RepoSource
  readonly repos: readonly RepoConfig[]
  readonly rules: string | null
  readonly permissionMode: PermissionMode
  readonly model: ModelChoice
  readonly cliSessionId: string | null
  readonly maxTurns: number
  readonly maxBudgetUsd: number
  readonly deadlineSeconds: number
  readonly result: SessionResult | null
  readonly pipelineId: string | null
  readonly stageState: StageState | null
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly startedAt: Date | null
  readonly completedAt: Date | null
}

interface SessionMessage {
  readonly id: string
  readonly sessionId: string
  readonly role: string
  readonly content: string
  readonly toolName: string | null
  readonly createdAt: Date
}

const DEFAULT_MAX_TURNS = 200
const DEFAULT_MAX_BUDGET_USD = 5.0
const DEFAULT_DEADLINE_SECONDS = 3600
const DEFAULT_LIST_LIMIT = 20

const parseRepoSource = (raw: string | null | undefined): RepoSource => {
  if (raw) {
    try {
      return JSON.parse(raw) as RepoSource
    } catch {
      // fallback
    }
  }
  return { mode: "direct", repos: [] }
}

const parseStageState = (raw: string | null | undefined): StageState | null => {
  if (raw) {
    try {
      return JSON.parse(raw) as StageState
    } catch {
      // fallback
    }
  }
  return null
}

const rowToSession = (row: cassandraTypes.Row): Session => ({
  id: row.id.toString(),
  userId: row.user_id,
  status: row.status as SessionStatus,
  prompt: row.prompt,
  repoSource: parseRepoSource(row.repo_source),
  repos: row.repos ? JSON.parse(row.repos) : [],
  rules: row.rules ?? null,
  permissionMode: (row.permission_mode as PermissionMode) ?? "acceptEdits",
  model: (row.model as ModelChoice) ?? "sonnet",
  cliSessionId: row.cli_session_id ?? null,
  maxTurns: row.max_turns,
  maxBudgetUsd: row.max_budget_usd,
  deadlineSeconds: row.deadline_seconds,
  result: row.result ? JSON.parse(row.result) : null,
  pipelineId: row.pipeline_id ?? null,
  stageState: parseStageState(row.stage_state),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at ?? null,
  completedAt: row.completed_at ?? null,
})

const rowToMessage = (row: cassandraTypes.Row): SessionMessage => ({
  id: row.id.toString(),
  sessionId: row.session_id.toString(),
  role: row.role,
  content: row.content,
  toolName: row.tool_name ?? null,
  createdAt: row.created_at,
})

const createSessionStore = (client: Client) => ({
  create: async (input: CreateSessionInput): Promise<Session> => {
    const id = cassandraTypes.Uuid.random()
    const now = new Date()
    const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS
    const maxBudgetUsd = input.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD
    const initialRepos = input.repoSource.mode === "direct" ? input.repoSource.repos : []
    const permissionMode = input.permissionMode ?? "acceptEdits"
    const model = input.model ?? "sonnet"

    const pipelineId = input.pipelineId ?? null
    const stageState = input.stageState ?? null

    await client.execute(
      `INSERT INTO sessions (
        user_id, id, status, prompt, repo_source, repos, rules,
        permission_mode, model, pipeline_id, stage_state,
        max_turns, max_budget_usd, deadline_seconds, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.userId, id, "queued", input.prompt,
        JSON.stringify(input.repoSource),
        JSON.stringify(initialRepos),
        input.rules ?? null,
        permissionMode, model,
        pipelineId, stageState ? JSON.stringify(stageState) : null,
        maxTurns, maxBudgetUsd, DEFAULT_DEADLINE_SECONDS, now, now,
      ],
      { prepare: true },
    )

    return {
      id: id.toString(),
      userId: input.userId,
      status: "queued",
      prompt: input.prompt,
      repoSource: input.repoSource,
      repos: initialRepos,
      rules: input.rules ?? null,
      permissionMode,
      model,
      cliSessionId: null,
      maxTurns,
      maxBudgetUsd,
      deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
      result: null,
      pipelineId,
      stageState,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    }
  },

  findById: async (id: string, userId: string): Promise<Session | null> => {
    const result = await client.execute(
      "SELECT * FROM sessions WHERE id = ? AND user_id = ? ALLOW FILTERING",
      [cassandraTypes.Uuid.fromString(id), userId],
      { prepare: true },
    )
    const row = result.first()
    return row ? rowToSession(row) : null
  },

  findByIdUnsafe: async (id: string): Promise<Session | null> => {
    const result = await client.execute(
      "SELECT * FROM sessions WHERE id = ?",
      [cassandraTypes.Uuid.fromString(id)],
      { prepare: true },
    )
    const row = result.first()
    return row ? rowToSession(row) : null
  },

  findByUser: async (userId: string, limit = DEFAULT_LIST_LIMIT, offset = 0): Promise<readonly Session[]> => {
    const fetchLimit = limit + offset
    const result = await client.execute(
      "SELECT * FROM sessions WHERE user_id = ? LIMIT ?",
      [userId, fetchLimit],
      { prepare: true },
    )
    return result.rows.slice(offset).map(rowToSession)
  },

  countByUser: async (userId: string): Promise<number> => {
    const result = await client.execute(
      "SELECT COUNT(*) FROM sessions WHERE user_id = ?",
      [userId],
      { prepare: true },
    )
    const row = result.first()
    return row ? Number(row.count) : 0
  },

  updateStatus: async (id: string, status: SessionStatus, extras?: {
    readonly result?: SessionResult
  }): Promise<void> => {
    const setClauses = ["status = ?", "updated_at = ?"]
    const values: unknown[] = [status, new Date()]

    if (extras?.result) {
      setClauses.push("result = ?")
      values.push(JSON.stringify(extras.result))
    }
    if (status === "running") {
      setClauses.push("started_at = ?")
      values.push(new Date())
    }
    if (status === "completed" || status === "failed") {
      setClauses.push("completed_at = ?")
      values.push(new Date())
    }

    const session = await client.execute(
      "SELECT user_id, created_at FROM sessions WHERE id = ?",
      [cassandraTypes.Uuid.fromString(id)],
      { prepare: true },
    )
    const row = session.first()
    if (!row) return

    values.push(row.user_id, row.created_at, cassandraTypes.Uuid.fromString(id))

    await client.execute(
      `UPDATE sessions SET ${setClauses.join(", ")} WHERE user_id = ? AND created_at = ? AND id = ?`,
      values,
      { prepare: true },
    )
  },

  deleteSession: async (id: string, userId: string): Promise<boolean> => {
    // Look up to get created_at (needed for partition key)
    const result = await client.execute(
      "SELECT created_at FROM sessions WHERE id = ? AND user_id = ? ALLOW FILTERING",
      [cassandraTypes.Uuid.fromString(id), userId],
      { prepare: true },
    )
    const row = result.first()
    if (!row) return false

    await client.execute(
      "DELETE FROM sessions WHERE user_id = ? AND created_at = ? AND id = ?",
      [userId, row.created_at, cassandraTypes.Uuid.fromString(id)],
      { prepare: true },
    )

    // Best-effort cleanup of messages
    await client.execute(
      "DELETE FROM session_messages WHERE session_id = ?",
      [cassandraTypes.Uuid.fromString(id)],
      { prepare: true },
    ).catch(() => {})

    return true
  },

  updateCliSessionId: async (sessionId: string, cliSessionId: string): Promise<void> => {
    const session = await client.execute(
      "SELECT user_id, created_at FROM sessions WHERE id = ?",
      [cassandraTypes.Uuid.fromString(sessionId)],
      { prepare: true },
    )
    const row = session.first()
    if (!row) return

    await client.execute(
      "UPDATE sessions SET cli_session_id = ?, updated_at = ? WHERE user_id = ? AND created_at = ? AND id = ?",
      [cliSessionId, new Date(), row.user_id, row.created_at, cassandraTypes.Uuid.fromString(sessionId)],
      { prepare: true },
    )
  },

  addMessage: async (
    sessionId: string,
    role: "assistant" | "tool" | "user" | "system",
    content: string,
    toolName?: string,
  ): Promise<void> => {
    const id = cassandraTypes.Uuid.random()
    const now = new Date()

    await client.execute(
      `INSERT INTO session_messages (session_id, id, role, content, tool_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [cassandraTypes.Uuid.fromString(sessionId), id, role, content, toolName ?? null, now],
      { prepare: true },
    )
  },

  getMessages: async (sessionId: string): Promise<readonly SessionMessage[]> => {
    const result = await client.execute(
      "SELECT * FROM session_messages WHERE session_id = ?",
      [cassandraTypes.Uuid.fromString(sessionId)],
      { prepare: true },
    )
    return result.rows.map(rowToMessage)
  },

  updateStageState: async (sessionId: string, stageState: StageState): Promise<void> => {
    const session = await client.execute(
      "SELECT user_id, created_at FROM sessions WHERE id = ?",
      [cassandraTypes.Uuid.fromString(sessionId)],
      { prepare: true },
    )
    const row = session.first()
    if (!row) return

    await client.execute(
      "UPDATE sessions SET stage_state = ?, updated_at = ? WHERE user_id = ? AND created_at = ? AND id = ?",
      [JSON.stringify(stageState), new Date(), row.user_id, row.created_at, cassandraTypes.Uuid.fromString(sessionId)],
      { prepare: true },
    )
  },
})

type SessionStore = ReturnType<typeof createSessionStore>

export { type CreateSessionInput, type Session, type SessionMessage, type SessionStore, createSessionStore }
