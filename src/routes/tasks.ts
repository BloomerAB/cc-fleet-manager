import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { SessionStore } from "../services/session-store.js"
import type { JobCreator } from "../services/job-creator.js"
import type { GitHubAppService } from "../services/github-app.js"
import type { WsManager } from "../services/ws-manager.js"
import type { Env } from "../env.js"

const MAX_PROMPT_LENGTH = 10000
const MAX_TURNS_LIMIT = 200
const MIN_BUDGET_USD = 0.01
const MAX_BUDGET_USD = 50
const MAX_PAGE_SIZE = 100
const DEFAULT_MAX_TURNS = 50
const DEFAULT_MAX_BUDGET_USD = 5.0
const DEFAULT_DEADLINE_SECONDS = 3600

const createTaskSchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  repoUrl: z.string().url(),
  repoBranch: z.string().optional(),
  maxTurns: z.number().int().min(1).max(MAX_TURNS_LIMIT).optional(),
  maxBudgetUsd: z.number().min(MIN_BUDGET_USD).max(MAX_BUDGET_USD).optional(),
})

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
  status: z.string().optional(),
})

interface JwtPayload {
  readonly sub: string
  readonly login: string
}

const registerTaskRoutes = (
  app: FastifyInstance,
  env: Env,
  sessionStore: SessionStore,
  jobCreator: JobCreator,
  githubApp: GitHubAppService,
  wsManager: WsManager,
) => {
  // Auth hook for all task routes
  app.addHook("onRequest", async (request, reply) => {
    try {
      await request.jwtVerify()
    } catch {
      return reply.status(401).send({ success: false, error: "Unauthorized" })
    }
  })

  // POST /api/tasks -- create a new task
  app.post("/api/tasks", async (request) => {
    const body = createTaskSchema.parse(request.body)
    const user = request.user as JwtPayload

    const session = await sessionStore.create({
      userId: user.sub,
      userLogin: user.login,
      prompt: body.prompt,
      repoUrl: body.repoUrl,
      repoBranch: body.repoBranch,
      maxTurns: body.maxTurns,
      maxBudgetUsd: body.maxBudgetUsd,
    })

    // Get GitHub App installation token for repo cloning
    const githubToken = await githubApp.getInstallationToken()

    // Create K8s Job
    const jobName = await jobCreator.createRunnerJob({
      sessionId: session.id,
      userId: user.sub,
      prompt: body.prompt,
      repoUrl: body.repoUrl,
      repoBranch: body.repoBranch,
      maxTurns: session.maxTurns ?? DEFAULT_MAX_TURNS,
      maxBudgetUsd: session.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
      deadlineSeconds: session.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS,
      managerWsUrl: `ws://claude-session-manager.${env.RUNNER_NAMESPACE}.svc.cluster.local:${env.PORT}/ws/runner`,
      githubToken,
    })

    await sessionStore.updateStatus(session.id, "queued", { jobName })

    // Notify dashboards
    wsManager.broadcastToDashboards(session.id, user.sub, {
      type: "session_update",
      sessionId: session.id,
      status: "queued",
    })

    return { success: true, data: { ...session, jobName } }
  })

  // GET /api/tasks -- list user's tasks
  app.get("/api/tasks", async (request) => {
    const query = listQuerySchema.parse(request.query)
    const user = request.user as JwtPayload

    const [tasks, total] = await Promise.all([
      sessionStore.findByUser(user.sub, query.limit, (query.page - 1) * query.limit),
      sessionStore.countByUser(user.sub),
    ])

    return {
      success: true,
      data: tasks,
      meta: {
        total,
        page: query.page,
        limit: query.limit,
      },
    }
  })

  // GET /api/tasks/:id -- get task details
  app.get("/api/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = request.user as JwtPayload

    const session = await sessionStore.findById(id, user.sub)
    if (!session) {
      return reply.status(404).send({ success: false, error: "Task not found" })
    }

    return { success: true, data: session }
  })

  // POST /api/tasks/:id/cancel -- cancel a task
  app.post("/api/tasks/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = request.user as JwtPayload

    const session = await sessionStore.findById(id, user.sub)
    if (!session) {
      return reply.status(404).send({ success: false, error: "Task not found" })
    }

    if (session.status === "completed" || session.status === "failed" || session.status === "cancelled") {
      return reply.status(400).send({ success: false, error: "Task already terminated" })
    }

    // Send cancel to runner
    wsManager.sendToRunner(id, { type: "cancel" })

    // Update status
    await sessionStore.updateStatus(id, "cancelled")

    // Delete K8s Job if exists
    if (session.jobName) {
      try {
        await jobCreator.deleteJob(session.jobName)
      } catch {
        // Job may already be gone
      }
    }

    wsManager.broadcastToDashboards(id, user.sub, {
      type: "session_update",
      sessionId: id,
      status: "cancelled",
    })

    return { success: true, data: { cancelled: true } }
  })

  // GET /api/tasks/:id/messages -- get session messages
  app.get("/api/tasks/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = request.user as JwtPayload

    const session = await sessionStore.findById(id, user.sub)
    if (!session) {
      return reply.status(404).send({ success: false, error: "Task not found" })
    }

    const messages = await sessionStore.getMessages(id)
    return { success: true, data: messages }
  })
}

export { registerTaskRoutes }
