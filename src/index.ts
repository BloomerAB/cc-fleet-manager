import Fastify from "fastify"
import fastifyWebsocket from "@fastify/websocket"
import fastifyCors from "@fastify/cors"
import fastifyJwt from "@fastify/jwt"
import { loadEnv } from "./env.js"
import { createDbClient } from "./db/client.js"
import { runMigrations } from "./db/migrate.js"
import { createSessionStore } from "./services/session-store.js"
import { createUserStore } from "./services/user-store.js"
import { createTaskExecutor } from "./services/task-executor.js"
import { createWsManager } from "./services/ws-manager.js"
import { registerAuthRoutes } from "./routes/auth.js"
import { registerTaskRoutes } from "./routes/tasks.js"
import { registerSessionRoutes } from "./routes/sessions.js"
import { registerSettingsRoutes } from "./routes/settings.js"
import { registerGitHubRoutes } from "./routes/github.js"

const main = async () => {
  const env = loadEnv()

  const app = Fastify({
    logger: {
      level: "info",
    },
  })

  // Plugins
  await app.register(fastifyCors, { origin: env.CORS_ORIGIN, credentials: true })
  await app.register(fastifyJwt, { secret: env.JWT_SECRET })
  await app.register(fastifyWebsocket)

  // Database
  const db = createDbClient(env)
  await db.connect()
  await runMigrations(db.client)

  // Services
  const sessionStore = createSessionStore(db.client)
  const userStore = createUserStore(db.client)
  const wsManager = createWsManager()
  const taskExecutor = createTaskExecutor(env, sessionStore, userStore, wsManager)

  // Routes
  registerAuthRoutes(app, env, userStore)
  registerTaskRoutes(app, env, sessionStore, userStore, taskExecutor, wsManager)
  registerSessionRoutes(app, wsManager, sessionStore, taskExecutor)
  registerSettingsRoutes(app, env, userStore)
  registerGitHubRoutes(app, userStore)

  // Health checks
  app.get("/healthz", async () => ({ status: "ok" }))
  app.get("/health", async () => ({ status: "ok" }))

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully`)
    taskExecutor.killAllTasks()
    await app.close()
    await db.disconnect()
    process.exit(0)
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))

  // Start
  await app.listen({ port: env.PORT, host: env.HOST })
  app.log.info(`CC Fleet Manager listening on ${env.HOST}:${env.PORT}`)
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${error}\n`)
  process.exit(1)
})
