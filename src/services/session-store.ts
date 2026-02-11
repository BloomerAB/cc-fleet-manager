import { eq, and, desc, sql } from "drizzle-orm"
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js"
import { sessions, sessionMessages } from "../db/schema.js"
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

const DEFAULT_MAX_TURNS = 50
const DEFAULT_MAX_BUDGET_USD = 5.0
const DEFAULT_LIST_LIMIT = 20

const createSessionStore = (db: PostgresJsDatabase) => ({
  create: async (input: CreateSessionInput) => {
    const [session] = await db
      .insert(sessions)
      .values({
        userId: input.userId,
        userLogin: input.userLogin,
        prompt: input.prompt,
        repoUrl: input.repoUrl,
        repoBranch: input.repoBranch,
        maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS,
        maxBudgetUsd: input.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
      })
      .returning()
    return session
  },

  findById: async (id: string, userId: string) => {
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
    return session ?? null
  },

  findByIdUnsafe: async (id: string) => {
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
    return session ?? null
  },

  findByUser: async (userId: string, limit = DEFAULT_LIST_LIMIT, offset = 0) => {
    return db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.createdAt))
      .limit(limit)
      .offset(offset)
  },

  countByUser: async (userId: string) => {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(eq(sessions.userId, userId))
    return result?.count ?? 0
  },

  updateStatus: async (id: string, status: SessionStatus, extras?: {
    readonly jobName?: string
    readonly result?: SessionResult
  }) => {
    const updates: Record<string, unknown> = {
      status,
      updatedAt: new Date(),
    }
    if (extras?.jobName) updates.jobName = extras.jobName
    if (extras?.result) updates.result = extras.result
    if (status === "running") updates.startedAt = new Date()
    if (status === "completed" || status === "failed") updates.completedAt = new Date()

    await db.update(sessions).set(updates).where(eq(sessions.id, id))
  },

  addMessage: async (
    sessionId: string,
    role: "assistant" | "tool" | "user" | "system",
    content: string,
    toolName?: string,
  ) => {
    await db.insert(sessionMessages).values({
      sessionId,
      role,
      content,
      toolName,
    })
  },

  getMessages: async (sessionId: string) => {
    return db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(sessionMessages.createdAt)
  },
})

type SessionStore = ReturnType<typeof createSessionStore>

export { type CreateSessionInput, type SessionStore, createSessionStore }
