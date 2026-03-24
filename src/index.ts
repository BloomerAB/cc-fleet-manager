import { existsSync } from "node:fs"
import { join } from "node:path"
import Fastify from "fastify"
import fastifyWebsocket from "@fastify/websocket"
import fastifyCors from "@fastify/cors"
import fastifyJwt from "@fastify/jwt"
import fastifyStatic from "@fastify/static"
import { loadEnv } from "./env.js"
import { createDbClient } from "./db/client.js"
import { createSessionStore } from "./services/session-store.js"
import { createJobCreator } from "./services/job-creator.js"
import { createGitHubAppService } from "./services/github-app.js"
import { createWsManager } from "./services/ws-manager.js"
import { registerAuthRoutes } from "./routes/auth.js"
import { registerTaskRoutes } from "./routes/tasks.js"
import { registerSessionRoutes } from "./routes/sessions.js"

const STATIC_DIR = join(import.meta.dirname, "../public")

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

  // Services
  const sessionStore = createSessionStore(db.client)
  const jobCreator = createJobCreator(env)
  const githubApp = createGitHubAppService(env)
  const wsManager = createWsManager()

  // API routes
  registerAuthRoutes(app, env)
  registerTaskRoutes(app, env, sessionStore, jobCreator, githubApp, wsManager)
  registerSessionRoutes(app, wsManager, sessionStore)

  // Health checks
  app.get("/healthz", async () => ({ status: "ok" }))
  app.get("/health", async () => ({ status: "ok" }))

  // Serve dashboard SPA if public/ dir exists (built from claude-dashboard)
  if (existsSync(STATIC_DIR)) {
    await app.register(fastifyStatic, {
      root: STATIC_DIR,
      prefix: "/",
      wildcard: false,
    })

    // SPA fallback — serve index.html for non-API routes
    app.setNotFoundHandler(async (request, reply) => {
      if (
        request.url.startsWith("/api/") ||
        request.url.startsWith("/ws/") ||
        request.url.startsWith("/healthz") ||
        request.url.startsWith("/health")
      ) {
        return reply.status(404).send({ success: false, error: "Not found" })
      }
      return reply.sendFile("index.html")
    })
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully`)
    await app.close()
    await db.disconnect()
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
