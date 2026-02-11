import Fastify from "fastify"
import fastifyWebsocket from "@fastify/websocket"
import fastifyCors from "@fastify/cors"
import fastifyJwt from "@fastify/jwt"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { loadEnv } from "./env.js"
import { createSessionStore } from "./services/session-store.js"
import { createJobCreator } from "./services/job-creator.js"
import { createGitHubAppService } from "./services/github-app.js"
import { createWsManager } from "./services/ws-manager.js"
import { registerAuthRoutes } from "./routes/auth.js"
import { registerTaskRoutes } from "./routes/tasks.js"
import { registerSessionRoutes } from "./routes/sessions.js"

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
  const sql = postgres(env.DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 30,
  })
  const db = drizzle(sql)

  // Services
  const sessionStore = createSessionStore(db)
  const jobCreator = createJobCreator(env)
  const githubApp = createGitHubAppService(env)
  const wsManager = createWsManager()

  // Routes
  registerAuthRoutes(app, env)
  registerTaskRoutes(app, env, sessionStore, jobCreator, githubApp, wsManager)
  registerSessionRoutes(app, wsManager, sessionStore)

  // Health check
  app.get("/healthz", async () => ({ status: "ok" }))

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully`)
    await app.close()
    await sql.end()
    process.exit(0)
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))

  // Start
  await app.listen({ port: env.PORT, host: env.HOST })
  app.log.info(`Session Manager listening on ${env.HOST}:${env.PORT}`)
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${error}\n`)
  process.exit(1)
})
