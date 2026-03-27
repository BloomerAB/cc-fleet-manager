import type { FastifyInstance } from "fastify"
import type { WsManager } from "../services/ws-manager.js"
import type { SessionStore } from "../services/session-store.js"
import type { TaskExecutor } from "../services/task-executor.js"
import { parseDashboardMessage } from "../services/ws-manager.js"

interface JwtPayload {
  readonly sub: string
  readonly login: string
}

const WS_CLOSE_AUTH_FAILED = 4001

const registerSessionRoutes = (
  app: FastifyInstance,
  wsManager: WsManager,
  sessionStore: SessionStore,
  taskExecutor: TaskExecutor,
) => {
  // WebSocket endpoint for dashboards
  app.get("/ws/dashboard", { websocket: true }, async (socket, request) => {
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

    const conn = wsManager.registerDashboard(user.sub, socket as unknown as import("ws").WebSocket)

    socket.on("message", async (raw: Buffer) => {
      try {
        const message = parseDashboardMessage(raw.toString())

        switch (message.type) {
          case "subscribe": {
            const ownedIds: string[] = []
            for (const id of message.sessionIds) {
              const session = await sessionStore.findById(id, user.sub)
              if (session) {
                ownedIds.push(id)
              }
            }
            conn.subscribedSessions.clear()
            for (const id of ownedIds) {
              conn.subscribedSessions.add(id)
            }
            break
          }
          case "answer": {
            // TODO: Bridge answers back to SDK when question support is added
            app.log.info({ sessionId: message.sessionId }, "Answer received (not yet implemented)")
            break
          }
          case "cancel": {
            const session = await sessionStore.findById(message.sessionId, user.sub)
            if (session) {
              taskExecutor.cancelTask(message.sessionId)
              await sessionStore.updateStatus(message.sessionId, "cancelled")
              wsManager.emitToSession(message.sessionId, user.sub, {
                type: "session_update",
                sessionId: message.sessionId,
                status: "cancelled",
              })
            }
            break
          }
          case "follow_up": {
            const session = await sessionStore.findById(message.sessionId, user.sub)
            if (!session) break
            if (session.status !== "waiting_for_input") {
              app.log.warn({ sessionId: message.sessionId, status: session.status }, "Follow-up sent to non-waiting session")
              break
            }
            taskExecutor.sendFollowUp(message.sessionId, user.sub, message.text).catch((error) => {
              app.log.error({ error, sessionId: message.sessionId }, "Follow-up failed")
            })
            break
          }
          case "end_session": {
            const session = await sessionStore.findById(message.sessionId, user.sub)
            if (!session) break
            taskExecutor.endSession(message.sessionId, user.sub).catch((error) => {
              app.log.error({ error, sessionId: message.sessionId }, "End session failed")
            })
            break
          }
          case "advance_stage": {
            const session = await sessionStore.findById(message.sessionId, user.sub)
            if (!session) break
            taskExecutor.advanceStage(message.sessionId).catch((error) => {
              app.log.error({ error, sessionId: message.sessionId }, "Advance stage failed")
            })
            break
          }
          case "skip_stage": {
            const session = await sessionStore.findById(message.sessionId, user.sub)
            if (!session) break
            taskExecutor.skipStage(message.sessionId).catch((error) => {
              app.log.error({ error, sessionId: message.sessionId }, "Skip stage failed")
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
