import { z } from "zod"
import type { WebSocket } from "ws"
import type {
  ManagerToDashboardMessage,
  DashboardToManagerMessage,
} from "../types/index.js"

interface DashboardConnection {
  readonly ws: WebSocket
  readonly userId: string
  readonly subscribedSessions: Set<string>
}

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

const dashboardFollowUpSchema = z.object({
  type: z.literal("follow_up"),
  sessionId: z.string(),
  text: z.string().min(1).max(50000),
})

const dashboardEndSessionSchema = z.object({
  type: z.literal("end_session"),
  sessionId: z.string(),
})

const dashboardAdvanceStageSchema = z.object({
  type: z.literal("advance_stage"),
  sessionId: z.string(),
})

const dashboardSkipStageSchema = z.object({
  type: z.literal("skip_stage"),
  sessionId: z.string(),
})

const dashboardMessageSchema = z.discriminatedUnion("type", [
  dashboardSubscribeSchema,
  dashboardAnswerSchema,
  dashboardCancelSchema,
  dashboardFollowUpSchema,
  dashboardEndSessionSchema,
  dashboardAdvanceStageSchema,
  dashboardSkipStageSchema,
])

const createWsManager = () => {
  const dashboards = new Set<DashboardConnection>()

  return {
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

    emitToSession: (sessionId: string, userId: string, message: ManagerToDashboardMessage) => {
      for (const conn of dashboards) {
        if (conn.userId !== userId) continue
        if (conn.subscribedSessions.size > 0 && !conn.subscribedSessions.has(sessionId)) continue
        if (conn.ws.readyState === conn.ws.OPEN) {
          conn.ws.send(JSON.stringify(message))
        }
      }
    },
  }
}

const parseDashboardMessage = (raw: string): DashboardToManagerMessage => {
  return dashboardMessageSchema.parse(JSON.parse(raw)) as DashboardToManagerMessage
}

type WsManager = ReturnType<typeof createWsManager>

export { type WsManager, type DashboardConnection, createWsManager, parseDashboardMessage }
