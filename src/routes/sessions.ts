import type { FastifyInstance } from "fastify"
import type { WebSocket } from "ws"
import type { WsManager } from "../services/ws-manager.js"
import type { SessionStore } from "../services/session-store.js"
import { parseRunnerMessage, parseDashboardMessage } from "../services/ws-manager.js"

interface JwtPayload {
  readonly sub: string
  readonly login: string
}

const WS_CLOSE_MISSING_PARAM = 4000
const WS_CLOSE_AUTH_FAILED = 4001

const registerSessionRoutes = (
  app: FastifyInstance,
  wsManager: WsManager,
  sessionStore: SessionStore,
) => {
  // WebSocket endpoint for runners
  app.get("/ws/runner", { websocket: true }, (socket, request) => {
    const sessionId = (request.query as Record<string, string>).sessionId
    if (!sessionId) {
      socket.close(WS_CLOSE_MISSING_PARAM, "Missing sessionId query parameter")
      return
    }

    wsManager.registerRunner(sessionId, socket as unknown as WebSocket)

    socket.on("message", async (raw: Buffer) => {
      try {
        const message = parseRunnerMessage(raw.toString())

        // Look up session to get userId for broadcasting (runner is in-cluster, trusted)
        const session = await sessionStore.findByIdUnsafe(sessionId)
        if (!session) {
          app.log.warn({ sessionId }, "Runner message for unknown session")
          return
        }

        const { userId } = session

        switch (message.type) {
          case "sdk_message": {
            await sessionStore.addMessage(
              sessionId,
              message.message.role,
              message.message.content,
              message.message.toolName,
            )
            wsManager.broadcastToDashboards(sessionId, userId, {
              type: "output",
              sessionId,
              text: message.message.content,
              toolName: message.message.toolName,
              timestamp: message.message.timestamp,
            })
            break
          }
          case "question": {
            await sessionStore.updateStatus(sessionId, "waiting_for_input")
            wsManager.broadcastToDashboards(sessionId, userId, {
              type: "session_update",
              sessionId,
              status: "waiting_for_input",
            })
            wsManager.broadcastToDashboards(sessionId, userId, {
              type: "question",
              sessionId,
              questions: message.questions,
            })
            break
          }
          case "status": {
            if (message.status === "running") {
              await sessionStore.updateStatus(sessionId, "running")
              wsManager.broadcastToDashboards(sessionId, userId, {
                type: "session_update",
                sessionId,
                status: "running",
              })
            } else if (message.status === "completed") {
              const result = message.result ? {
                success: message.result.success,
                summary: message.result.summary,
                prUrl: message.result.prUrl,
                costUsd: message.result.costUsd,
                turnsUsed: message.result.turnsUsed,
              } : undefined
              await sessionStore.updateStatus(sessionId, "completed", { result })
              wsManager.broadcastToDashboards(sessionId, userId, {
                type: "session_update",
                sessionId,
                status: "completed",
              })
              if (result) {
                wsManager.broadcastToDashboards(sessionId, userId, {
                  type: "result",
                  sessionId,
                  result,
                })
              }
            } else if (message.status === "failed") {
              const result = message.result ? {
                success: false,
                summary: message.result.summary,
                costUsd: message.result.costUsd,
                turnsUsed: message.result.turnsUsed,
              } : undefined
              await sessionStore.updateStatus(sessionId, "failed", { result })
              wsManager.broadcastToDashboards(sessionId, userId, {
                type: "session_update",
                sessionId,
                status: "failed",
              })
              if (result) {
                wsManager.broadcastToDashboards(sessionId, userId, {
                  type: "result",
                  sessionId,
                  result,
                })
              }
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
      socket.close(WS_CLOSE_AUTH_FAILED, "Missing token")
      return
    }

    let user: JwtPayload
    try {
      user = app.jwt.verify(token) as JwtPayload
    } catch {
      socket.close(WS_CLOSE_AUTH_FAILED, "Invalid token")
      return
    }

    const conn = wsManager.registerDashboard(user.sub, socket as unknown as WebSocket)

    socket.on("message", async (raw: Buffer) => {
      try {
        const message = parseDashboardMessage(raw.toString())

        switch (message.type) {
          case "subscribe": {
            // Validate session ownership — only allow subscribing to own sessions
            const ownedIds: string[] = []
            for (const id of message.sessionIds) {
              const session = await sessionStore.findById(id, user.sub)
              if (session) {
                ownedIds.push(id)
              } else {
                app.log.warn({ sessionId: id, userId: user.sub }, "Subscription denied: not owner")
              }
            }
            conn.subscribedSessions.clear()
            for (const id of ownedIds) {
              conn.subscribedSessions.add(id)
            }
            break
          }
          case "answer": {
            // Verify user owns this session before forwarding answer
            const session = await sessionStore.findById(message.sessionId, user.sub)
            if (!session) {
              app.log.warn({ sessionId: message.sessionId, userId: user.sub }, "Answer denied: not owner")
              break
            }
            wsManager.sendToRunner(message.sessionId, {
              type: "answer",
              answers: message.answers,
            })
            break
          }
          case "cancel": {
            // Verify user owns this session before forwarding cancel
            const session = await sessionStore.findById(message.sessionId, user.sub)
            if (!session) {
              app.log.warn({ sessionId: message.sessionId, userId: user.sub }, "Cancel denied: not owner")
              break
            }
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

export { registerSessionRoutes }
