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

async function main() {
  const env = loadEnv()

  const app = Fastify({
    logger: {
      level: "info",
      transport: {
        target: "pino-pretty",
        options: { translateTime: "HH:MM:ss" },
      },
    },
  })

  // Plugins
  await app.register(fastifyCors, { origin: env.CORS_ORIGIN, credentials: true })
  await app.register(fastifyJwt, { secret: env.JWT_SECRET })
  await app.register(fastifyWebsocket)

  // Database
  const sql = postgres(env.DATABASE_URL)
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

  // Start
  await app.listen({ port: env.PORT, host: env.HOST })
  app.log.info(`Session Manager listening on ${env.HOST}:${env.PORT}`)
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${error}\n`)
  process.exit(1)
})
