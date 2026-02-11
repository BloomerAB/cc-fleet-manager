import type { FastifyInstance } from "fastify"
import type { WebSocket } from "ws"
import type { WsManager } from "../services/ws-manager.js"
import type { SessionStore } from "../services/session-store.js"
import type {
  RunnerMessage,
  DashboardToManagerMessage,
} from "@bloomer-ab/claude-types"

interface JwtPayload {
  readonly sub: string
  readonly login: string
}

export function registerSessionRoutes(
  app: FastifyInstance,
  wsManager: WsManager,
  sessionStore: SessionStore,
) {
  // WebSocket endpoint for runners
  app.get("/ws/runner", { websocket: true }, (socket, request) => {
    const sessionId = (request.query as Record<string, string>).sessionId
    if (!sessionId) {
      socket.close(4000, "Missing sessionId query parameter")
      return
    }

    wsManager.registerRunner(sessionId, socket as unknown as WebSocket)

    socket.on("message", async (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString()) as RunnerMessage

        // Look up the session to find the userId for broadcasting
        // Runner authenticates via the sessionId (runner is in-cluster, trusted)
        const sessions = await sessionStore.findByUser("*", 1, 0)
        // We need a method to find by session ID without userId filter
        // For now, store messages and broadcast based on the runner's session

        switch (message.type) {
          case "sdk_message": {
            await sessionStore.addMessage(
              sessionId,
              message.message.role,
              message.message.content,
              message.message.toolName,
            )
            // We need the userId — get it from DB
            break
          }
          case "question": {
            await sessionStore.updateStatus(sessionId, "waiting_for_input")
            break
          }
          case "status": {
            if (message.status === "running") {
              await sessionStore.updateStatus(sessionId, "running")
            } else if (message.status === "completed") {
              await sessionStore.updateStatus(sessionId, "completed", {
                result: message.result ? {
                  success: message.result.success,
                  summary: message.result.summary,
                  prUrl: message.result.prUrl,
                  costUsd: message.result.costUsd,
                  turnsUsed: message.result.turnsUsed,
                } : undefined,
              })
            } else if (message.status === "failed") {
              await sessionStore.updateStatus(sessionId, "failed", {
                result: message.result ? {
                  success: false,
                  summary: message.result.summary,
                  costUsd: message.result.costUsd,
                  turnsUsed: message.result.turnsUsed,
                } : undefined,
              })
            }
            break
          }
        }
      } catch (error) {
        app.log.error({ error, sessionId }, "Error processing runner message")
      }
    })
  })

  // WebSocket endpoint for dashboards
  app.get("/ws/dashboard", { websocket: true }, async (socket, request) => {
    // Verify JWT from query param (WebSocket can't use headers easily)
    const token = (request.query as Record<string, string>).token
    if (!token) {
      socket.close(4001, "Missing token")
      return
    }

    let user: JwtPayload
    try {
      user = app.jwt.verify(token) as JwtPayload
    } catch {
      socket.close(4001, "Invalid token")
      return
    }

    const conn = wsManager.registerDashboard(user.sub, socket as unknown as WebSocket)

    socket.on("message", (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString()) as DashboardToManagerMessage

        switch (message.type) {
          case "subscribe": {
            conn.subscribedSessions.clear()
            for (const id of message.sessionIds) {
              conn.subscribedSessions.add(id)
            }
            break
          }
          case "answer": {
            wsManager.sendToRunner(message.sessionId, {
              type: "answer",
              answers: message.answers,
            })
            break
          }
          case "cancel": {
            wsManager.sendToRunner(message.sessionId, {
              type: "cancel",
            })
            break
          }
        }
      } catch (error) {
        app.log.error({ error }, "Error processing dashboard message")
      }
    })
  })
}
