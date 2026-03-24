import { z } from "zod"
import type { WebSocket } from "ws"
import type {
  RunnerMessage,
  ManagerToRunnerMessage,
  ManagerToDashboardMessage,
  DashboardToManagerMessage,
} from "@bloomerab/claude-types"

interface RunnerConnection {
  readonly ws: WebSocket
  readonly sessionId: string
}

interface DashboardConnection {
  readonly ws: WebSocket
  readonly userId: string
  readonly subscribedSessions: Set<string>
}

// Zod schemas for incoming WebSocket messages
const runnerSdkMessageSchema = z.object({
  type: z.literal("sdk_message"),
  message: z.object({
    role: z.enum(["assistant", "tool"]),
    content: z.string(),
    toolName: z.string().optional(),
    timestamp: z.string(),
  }),
})

const runnerQuestionSchema = z.object({
  type: z.literal("question"),
  questions: z.array(z.object({
    id: z.string(),
    question: z.string(),
    options: z.array(z.object({
      label: z.string(),
      value: z.string(),
    })).optional(),
    defaultAnswer: z.string().optional(),
  })),
})

const runnerStatusSchema = z.object({
  type: z.literal("status"),
  status: z.enum(["running", "completed", "failed"]),
  result: z.object({
    success: z.boolean(),
    summary: z.string(),
    prUrl: z.string().optional(),
    costUsd: z.number().optional(),
    turnsUsed: z.number().optional(),
  }).optional(),
})

const runnerMessageSchema = z.discriminatedUnion("type", [
  runnerSdkMessageSchema,
  runnerQuestionSchema,
  runnerStatusSchema,
])

const dashboardSubscribeSchema = z.object({
  type: z.literal("subscribe"),
  sessionIds: z.array(z.string()),
})

const dashboardAnswerSchema = z.object({
  type: z.literal("answer"),
  sessionId: z.string(),
  answers: z.record(z.string(), z.string()),
})

const dashboardCancelSchema = z.object({
  type: z.literal("cancel"),
  sessionId: z.string(),
})

const dashboardMessageSchema = z.discriminatedUnion("type", [
  dashboardSubscribeSchema,
  dashboardAnswerSchema,
  dashboardCancelSchema,
])

const createWsManager = () => {
  const runners = new Map<string, RunnerConnection>()
  const dashboards = new Set<DashboardConnection>()

  return {
    registerRunner: (sessionId: string, ws: WebSocket) => {
      runners.set(sessionId, { ws, sessionId })
      ws.on("close", () => runners.delete(sessionId))
    },

    registerDashboard: (userId: string, ws: WebSocket): DashboardConnection => {
      const conn: DashboardConnection = {
        ws,
        userId,
        subscribedSessions: new Set(),
      }
      dashboards.add(conn)
      ws.on("close", () => dashboards.delete(conn))
      return conn
    },

    sendToRunner: (sessionId: string, message: ManagerToRunnerMessage) => {
      const runner = runners.get(sessionId)
      if (runner && runner.ws.readyState === runner.ws.OPEN) {
        runner.ws.send(JSON.stringify(message))
      }
    },

    broadcastToDashboards: (sessionId: string, userId: string, message: ManagerToDashboardMessage) => {
      for (const conn of dashboards) {
        if (conn.userId !== userId) continue
        if (conn.subscribedSessions.size > 0 && !conn.subscribedSessions.has(sessionId)) continue
        if (conn.ws.readyState === conn.ws.OPEN) {
          conn.ws.send(JSON.stringify(message))
        }
      }
    },

    getRunnerConnection: (sessionId: string) => {
      return runners.get(sessionId) ?? null
    },

    isRunnerConnected: (sessionId: string) => {
      const runner = runners.get(sessionId)
      return runner !== undefined && runner.ws.readyState === runner.ws.OPEN
    },
  }
}

const parseRunnerMessage = (raw: string): RunnerMessage => {
  return runnerMessageSchema.parse(JSON.parse(raw)) as RunnerMessage
}

const parseDashboardMessage = (raw: string): DashboardToManagerMessage => {
  return dashboardMessageSchema.parse(JSON.parse(raw)) as DashboardToManagerMessage
}

type WsManager = ReturnType<typeof createWsManager>

export { type WsManager, type RunnerConnection, type DashboardConnection, createWsManager, parseRunnerMessage, parseDashboardMessage }
