import { eq, and, desc, sql } from "drizzle-orm"
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js"
import { sessions, sessionMessages } from "../db/schema.js"
import type { SessionStatus, SessionResult } from "@bloomer-ab/claude-types"

export interface CreateSessionInput {
  readonly userId: string
  readonly userLogin: string
  readonly prompt: string
  readonly repoUrl: string
  readonly repoBranch?: string
  readonly maxTurns?: number
  readonly maxBudgetUsd?: number
}

export function createSessionStore(db: PostgresJsDatabase) {
  return {
    async create(input: CreateSessionInput) {
      const [session] = await db
        .insert(sessions)
        .values({
          userId: input.userId,
          userLogin: input.userLogin,
          prompt: input.prompt,
          repoUrl: input.repoUrl,
          repoBranch: input.repoBranch,
          maxTurns: input.maxTurns ?? 50,
          maxBudgetUsd: input.maxBudgetUsd ?? 5.0,
        })
        .returning()
      return session
    },

    async findById(id: string, userId: string) {
      const [session] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
      return session ?? null
    },

    async findByUser(userId: string, limit = 20, offset = 0) {
      return db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, userId))
        .orderBy(desc(sessions.createdAt))
        .limit(limit)
        .offset(offset)
    },

    async countByUser(userId: string) {
      const [result] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(sessions)
        .where(eq(sessions.userId, userId))
      return result?.count ?? 0
    },

    async updateStatus(id: string, status: SessionStatus, extras?: {
      readonly jobName?: string
      readonly result?: SessionResult
    }) {
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

    async addMessage(
      sessionId: string,
      role: "assistant" | "tool" | "user" | "system",
      content: string,
      toolName?: string,
    ) {
      await db.insert(sessionMessages).values({
        sessionId,
        role,
        content,
        toolName,
      })
    },

    async getMessages(sessionId: string) {
      return db
        .select()
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, sessionId))
        .orderBy(sessionMessages.createdAt)
    },
  }
}

export type SessionStore = ReturnType<typeof createSessionStore>
