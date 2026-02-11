import { pgTable, text, timestamp, jsonb, uuid, integer, real } from "drizzle-orm/pg-core"

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  userLogin: text("user_login").notNull(),
  status: text("status", {
    enum: ["queued", "running", "completed", "failed", "waiting_for_input", "timed_out", "cancelled"],
  }).notNull().default("queued"),
  prompt: text("prompt").notNull(),
  repoUrl: text("repo_url").notNull(),
  repoBranch: text("repo_branch"),
  maxTurns: integer("max_turns").default(50),
  maxBudgetUsd: real("max_budget_usd").default(5.0),
  deadlineSeconds: integer("deadline_seconds").default(3600),
  jobName: text("job_name"),
  result: jsonb("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
})

export const sessionMessages = pgTable("session_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id),
  role: text("role", { enum: ["assistant", "tool", "user", "system"] }).notNull(),
  content: text("content").notNull(),
  toolName: text("tool_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
