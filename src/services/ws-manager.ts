import type { WebSocket } from "ws"
import type {
  RunnerMessage,
  ManagerToRunnerMessage,
  ManagerToDashboardMessage,
  DashboardToManagerMessage,
} from "@bloomer-ab/claude-types"

interface RunnerConnection {
  readonly ws: WebSocket
  readonly sessionId: string
}

interface DashboardConnection {
  readonly ws: WebSocket
  readonly userId: string
  readonly subscribedSessions: Set<string>
}

export function createWsManager() {
  const runners = new Map<string, RunnerConnection>()
  const dashboards = new Set<DashboardConnection>()

  return {
    registerRunner(sessionId: string, ws: WebSocket) {
      runners.set(sessionId, { ws, sessionId })
      ws.on("close", () => runners.delete(sessionId))
    },

    registerDashboard(userId: string, ws: WebSocket): DashboardConnection {
      const conn: DashboardConnection = {
        ws,
        userId,
        subscribedSessions: new Set(),
      }
      dashboards.add(conn)
      ws.on("close", () => dashboards.delete(conn))
      return conn
    },

    sendToRunner(sessionId: string, message: ManagerToRunnerMessage) {
      const runner = runners.get(sessionId)
      if (runner && runner.ws.readyState === runner.ws.OPEN) {
        runner.ws.send(JSON.stringify(message))
      }
    },

    broadcastToDashboards(sessionId: string, userId: string, message: ManagerToDashboardMessage) {
      for (const conn of dashboards) {
        if (conn.userId !== userId) continue
        if (conn.subscribedSessions.size > 0 && !conn.subscribedSessions.has(sessionId)) continue
        if (conn.ws.readyState === conn.ws.OPEN) {
          conn.ws.send(JSON.stringify(message))
        }
      }
    },

    getRunnerConnection(sessionId: string) {
      return runners.get(sessionId) ?? null
    },

    isRunnerConnected(sessionId: string) {
      const runner = runners.get(sessionId)
      return runner !== undefined && runner.ws.readyState === runner.ws.OPEN
    },
  }
}

export type WsManager = ReturnType<typeof createWsManager>
