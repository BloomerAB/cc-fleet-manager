import { types as cassandraTypes } from "cassandra-driver"
import type { Client } from "cassandra-driver"
import type { SessionStatus, SessionResult } from "@bloomer-ab/claude-types"

interface CreateSessionInput {
  readonly userId: string
  readonly userLogin: string
  readonly prompt: string
  readonly repoUrl: string
  readonly repoBranch?: string
  readonly maxTurns?: number
  readonly maxBudgetUsd?: number
}

interface Session {
  readonly id: string
  readonly userId: string
  readonly userLogin: string
  readonly status: SessionStatus
  readonly prompt: string
  readonly repoUrl: string
  readonly repoBranch: string | null
  readonly maxTurns: number
  readonly maxBudgetUsd: number
  readonly deadlineSeconds: number
  readonly jobName: string | null
  readonly result: SessionResult | null
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

const DEFAULT_MAX_TURNS = 50
const DEFAULT_MAX_BUDGET_USD = 5.0
const DEFAULT_DEADLINE_SECONDS = 3600
const DEFAULT_LIST_LIMIT = 20

const rowToSession = (row: cassandraTypes.Row): Session => ({
  id: row.id.toString(),
  userId: row.user_id,
  userLogin: row.user_login,
  status: row.status as SessionStatus,
  prompt: row.prompt,
  repoUrl: row.repo_url,
  repoBranch: row.repo_branch ?? null,
  maxTurns: row.max_turns,
  maxBudgetUsd: row.max_budget_usd,
  deadlineSeconds: row.deadline_seconds,
  jobName: row.job_name ?? null,
  result: row.result ? JSON.parse(row.result) : null,
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

    await client.execute(
      `INSERT INTO sessions (
        user_id, id, user_login, status, prompt, repo_url, repo_branch,
        max_turns, max_budget_usd, deadline_seconds, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.userId, id, input.userLogin, "queued", input.prompt,
        input.repoUrl, input.repoBranch ?? null,
        maxTurns, maxBudgetUsd, DEFAULT_DEADLINE_SECONDS, now, now,
      ],
      { prepare: true },
    )

    return {
      id: id.toString(),
      userId: input.userId,
      userLogin: input.userLogin,
      status: "queued",
      prompt: input.prompt,
      repoUrl: input.repoUrl,
      repoBranch: input.repoBranch ?? null,
      maxTurns,
      maxBudgetUsd,
      deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
      jobName: null,
      result: null,
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
    // ScyllaDB doesn't support OFFSET — use limit and skip in app layer
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
    readonly jobName?: string
    readonly result?: SessionResult
  }): Promise<void> => {
    const setClauses = ["status = ?", "updated_at = ?"]
    const values: unknown[] = [status, new Date()]

    if (extras?.jobName) {
      setClauses.push("job_name = ?")
      values.push(extras.jobName)
    }
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

    // Need to know user_id and created_at for the partition key
    // Look up the session first
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
})

type SessionStore = ReturnType<typeof createSessionStore>

export { type CreateSessionInput, type Session, type SessionMessage, type SessionStore, createSessionStore }
