import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { minimatch } from "minimatch"
import type { SessionStore } from "../services/session-store.js"
import type { TaskExecutor } from "../services/task-executor.js"
import type { WsManager } from "../services/ws-manager.js"
import type { UserStore } from "../services/user-store.js"
import type { PipelineRegistry } from "../services/pipeline-registry.js"
import type { Env } from "../env.js"

const MAX_PROMPT_LENGTH = 10000
const MAX_TURNS_LIMIT = 500
const MIN_BUDGET_USD = 0.01
const MAX_BUDGET_USD = 50
const MAX_PAGE_SIZE = 100
const MAX_REPOS = 10
const MAX_IMPORT_SIZE = 50 * 1024 * 1024 // 50 MB

// Only allow safe path segments: alphanumeric, hyphens, underscores, dots (no slashes, .., etc.)
const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/

const repoSchema = z.object({
  url: z.string().url(),
  branch: z.string().optional(),
})

const directSourceSchema = z.object({
  mode: z.literal("direct"),
  repos: z.array(repoSchema).min(1).max(MAX_REPOS),
})

const orgSourceSchema = z.object({
  mode: z.literal("org"),
  org: z.string().min(1),
  pattern: z.string().optional(),
})

const discoverySourceSchema = z.object({
  mode: z.literal("discovery"),
  org: z.string().min(1),
  hint: z.string().max(500).optional(),
})

const repoSourceSchema = z.discriminatedUnion("mode", [
  directSourceSchema,
  orgSourceSchema,
  discoverySourceSchema,
])

const createTaskSchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  repoSource: repoSourceSchema,
  rules: z.string().max(5000).optional(),
  permissionMode: z.enum(["plan", "acceptEdits", "bypassPermissions"]).optional(),
  model: z.enum(["sonnet", "opus"]).optional(),
  maxTurns: z.number().int().min(1).max(MAX_TURNS_LIMIT).optional(),
  maxBudgetUsd: z.number().min(MIN_BUDGET_USD).max(MAX_BUDGET_USD).optional(),
  pipelineId: z.string().min(1).optional(),
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

const parseAllowedRepos = (raw: string): readonly string[] => {
  if (!raw.trim()) return []
  return raw.split(",").map((s) => s.trim()).filter(Boolean)
}

const isRepoAllowed = (repoUrl: string, patterns: readonly string[]): boolean => {
  if (patterns.length === 0) return true
  const normalized = repoUrl.replace(/^https?:\/\//, "").replace(/\.git$/, "")
  return patterns.some((pattern) => minimatch(normalized, pattern))
}

const registerTaskRoutes = (
  app: FastifyInstance,
  env: Env,
  sessionStore: SessionStore,
  userStore: UserStore,
  taskExecutor: TaskExecutor,
  wsManager: WsManager,
  pipelineRegistry: PipelineRegistry,
) => {
  const allowedRepos = parseAllowedRepos(env.ALLOWED_REPOS)

  // Auth hook for all task and pipeline routes
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/tasks") || request.url.startsWith("/api/pipelines")) {
      try {
        await request.jwtVerify()
      } catch {
        return reply.status(401).send({ success: false, error: "Unauthorized" })
      }
    }
  })

  // GET /api/pipelines — list available pipelines
  app.get("/api/pipelines", async () => {
    return { success: true, data: pipelineRegistry.getAll() }
  })

  // POST /api/tasks — create and execute a task
  app.post("/api/tasks", async (request, reply) => {
    const body = createTaskSchema.parse(request.body)
    const user = request.user as JwtPayload

    // Validate repos against allowlist (only for direct mode)
    if (body.repoSource.mode === "direct") {
      for (const repo of body.repoSource.repos) {
        if (!isRepoAllowed(repo.url, allowedRepos)) {
          return reply.status(403).send({
            success: false,
            error: `Repository not allowed: ${repo.url}`,
          })
        }
      }
    }

    // For org/discovery modes, verify the user has a GitHub token
    if (body.repoSource.mode !== "direct") {
      const token = await userStore.getAccessToken(user.sub)
      if (!token) {
        return reply.status(400).send({
          success: false,
          error: "No GitHub token found. Re-login required for org/discovery modes.",
        })
      }
    }

    // Validate pipeline if specified
    if (body.pipelineId) {
      const pipeline = pipelineRegistry.getById(body.pipelineId)
      if (!pipeline) {
        return reply.status(400).send({ success: false, error: `Unknown pipeline: ${body.pipelineId}` })
      }
    }

    const session = await sessionStore.create({
      userId: user.sub,
      prompt: body.prompt,
      repoSource: body.repoSource,
      rules: body.rules,
      permissionMode: body.permissionMode,
      model: body.model,
      maxTurns: body.maxTurns,
      maxBudgetUsd: body.maxBudgetUsd,
      pipelineId: body.pipelineId,
    })

    // Notify dashboards
    wsManager.emitToSession(session.id, user.sub, {
      type: "session_update",
      sessionId: session.id,
      status: "queued",
    })

    // Execute in background — don't await
    taskExecutor.executeTask(session.id, user.sub).catch((error) => {
      app.log.error({ error, sessionId: session.id }, "Task execution failed")
    })

    return { success: true, data: session }
  })

  // POST /api/tasks/:id/resume — resume a completed/failed session
  app.post("/api/tasks/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = request.user as JwtPayload

    const originalSession = await sessionStore.findById(id, user.sub)
    if (!originalSession) {
      return reply.status(404).send({ success: false, error: "Task not found" })
    }
    if (!originalSession.cliSessionId) {
      return reply.status(400).send({ success: false, error: "No conversation history — use Retry instead." })
    }
    if (originalSession.status === "running" || originalSession.status === "waiting_for_input") {
      return reply.status(400).send({ success: false, error: "Session is still active" })
    }

    // Validate path segment to prevent path traversal
    if (!SAFE_PATH_SEGMENT.test(user.sub)) {
      return reply.status(400).send({ success: false, error: "Invalid user identifier" })
    }
    if (!SAFE_PATH_SEGMENT.test(originalSession.cliSessionId)) {
      return reply.status(400).send({ success: false, error: "Invalid CLI session identifier" })
    }

    // Check if session JSONL exists in the user's home dir
    const { existsSync } = await import("node:fs")
    const { readdirSync } = await import("node:fs")
    const claudeProjectsDir = `/home/appuser/${user.sub}/.claude/projects`
    let sessionFileExists = false
    try {
      if (existsSync(claudeProjectsDir)) {
        for (const dir of readdirSync(claudeProjectsDir)) {
          const jsonlPath = `${claudeProjectsDir}/${dir}/${originalSession.cliSessionId}.jsonl`
          if (existsSync(jsonlPath)) {
            sessionFileExists = true
            break
          }
        }
      }
    } catch {
      // Best effort
    }
    if (!sessionFileExists) {
      return reply.status(400).send({ success: false, error: "Conversation history not found on this pod — use Retry instead." })
    }

    // Create a new fleet session linked to the original
    const newSession = await sessionStore.create({
      userId: user.sub,
      prompt: `[Resumed from session ${id}] ${originalSession.prompt}`,
      repoSource: originalSession.repoSource,
      rules: originalSession.rules ?? undefined,
      permissionMode: originalSession.permissionMode,
      model: originalSession.model,
      maxTurns: originalSession.maxTurns,
    })

    // Execute with resume — pass the CLI session ID
    taskExecutor.executeTask(newSession.id, user.sub, originalSession.cliSessionId).catch((error) => {
      app.log.error({ error, sessionId: newSession.id }, "Resume execution failed")
    })

    return { success: true, data: newSession }
  })

  // GET /api/tasks — list user's tasks
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

  // GET /api/tasks/:id — get task details
  app.get("/api/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = request.user as JwtPayload

    const session = await sessionStore.findById(id, user.sub)
    if (!session) {
      return reply.status(404).send({ success: false, error: "Task not found" })
    }

    return { success: true, data: session }
  })

  // POST /api/tasks/:id/cancel — cancel a task
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

    taskExecutor.cancelTask(id)
    await sessionStore.updateStatus(id, "cancelled")

    wsManager.emitToSession(id, user.sub, {
      type: "session_update",
      sessionId: id,
      status: "cancelled",
    })

    return { success: true, data: { cancelled: true } }
  })

  // POST /api/tasks/:id/advance-stage — manually advance to the next pipeline stage
  app.post("/api/tasks/:id/advance-stage", async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = request.user as JwtPayload

    const session = await sessionStore.findById(id, user.sub)
    if (!session) {
      return reply.status(404).send({ success: false, error: "Task not found" })
    }

    try {
      await taskExecutor.advanceStage(id)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.status(400).send({ success: false, error: message })
    }
  })

  // POST /api/tasks/:id/skip-stage — skip the current pipeline stage
  app.post("/api/tasks/:id/skip-stage", async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = request.user as JwtPayload

    const session = await sessionStore.findById(id, user.sub)
    if (!session) {
      return reply.status(404).send({ success: false, error: "Task not found" })
    }

    try {
      await taskExecutor.skipStage(id)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.status(400).send({ success: false, error: message })
    }
  })

  // DELETE /api/tasks/:id — delete a session
  app.delete("/api/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = request.user as JwtPayload

    const session = await sessionStore.findById(id, user.sub)
    if (!session) {
      return reply.status(404).send({ success: false, error: "Task not found" })
    }
    if (session.status === "running") {
      return reply.status(400).send({ success: false, error: "Cannot delete a running task. Cancel it first." })
    }

    // Clean up active session context if waiting_for_input
    if (session.status === "waiting_for_input") {
      taskExecutor.cancelTask(id)
    }

    const deleted = await sessionStore.deleteSession(id, user.sub)
    if (!deleted) {
      return reply.status(404).send({ success: false, error: "Task not found" })
    }

    return { success: true, data: { deleted: true } }
  })

  // GET /api/tasks/:id/messages — get session messages
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

  // GET /api/tasks/:id/export — download session JSONL for local resume
  app.get("/api/tasks/:id/export", async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = request.user as JwtPayload

    const session = await sessionStore.findById(id, user.sub)
    if (!session) {
      return reply.status(404).send({ success: false, error: "Task not found" })
    }
    if (!session.cliSessionId) {
      return reply.status(400).send({ success: false, error: "No CLI session — nothing to export" })
    }

    // Validate path segments to prevent path traversal
    if (!SAFE_PATH_SEGMENT.test(user.sub)) {
      return reply.status(400).send({ success: false, error: "Invalid user identifier" })
    }
    if (!SAFE_PATH_SEGMENT.test(session.cliSessionId)) {
      return reply.status(400).send({ success: false, error: "Invalid CLI session identifier" })
    }

    const { existsSync, readFileSync, readdirSync } = await import("node:fs")
    const userProjectsDir = `/home/appuser/${user.sub}/.claude/projects`

    let jsonlContent: string | null = null
    try {
      if (existsSync(userProjectsDir)) {
        for (const dir of readdirSync(userProjectsDir)) {
          const jsonlPath = `${userProjectsDir}/${dir}/${session.cliSessionId}.jsonl`
          if (existsSync(jsonlPath)) {
            jsonlContent = readFileSync(jsonlPath, "utf-8")
            break
          }
        }
      }
    } catch {
      // Best effort
    }

    if (!jsonlContent) {
      return reply.status(404).send({ success: false, error: "Session file not found" })
    }

    return reply
      .header("Content-Type", "application/x-ndjson")
      .header("Content-Disposition", `attachment; filename="${session.cliSessionId}.jsonl"`)
      .send(jsonlContent)
  })

  // POST /api/tasks/import — import a local session JSONL to Fleet
  app.post("/api/tasks/import", async (request, reply) => {
    const user = request.user as JwtPayload

    const importSchema = z.object({
      jsonl: z.string().min(1).max(MAX_IMPORT_SIZE),
      prompt: z.string().max(MAX_PROMPT_LENGTH).optional(),
      repoSource: z.unknown().optional(),
    })

    const parseResult = importSchema.safeParse(request.body)
    if (!parseResult.success) {
      return reply.status(400).send({ success: false, error: `Invalid import body: ${parseResult.error.issues.map((i) => i.message).join(", ")}` })
    }
    const body = parseResult.data

    // Parse the JSONL to extract session ID and first prompt
    const lines = body.jsonl.trim().split("\n")
    let cliSessionId: string | null = null
    let firstPrompt = body.prompt ?? "Imported session"

    for (const line of lines) {
      try {
        const record = JSON.parse(line)
        if (record.session_id && !cliSessionId) {
          cliSessionId = record.session_id
        }
        if (record.type === "user" && record.message?.content && firstPrompt === "Imported session") {
          const content = typeof record.message.content === "string"
            ? record.message.content
            : JSON.stringify(record.message.content)
          firstPrompt = content.slice(0, 200)
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (!cliSessionId) {
      return reply.status(400).send({ success: false, error: "Could not find session_id in JSONL" })
    }

    // Validate path segments to prevent path traversal
    if (!SAFE_PATH_SEGMENT.test(user.sub)) {
      return reply.status(400).send({ success: false, error: "Invalid user identifier" })
    }
    if (!SAFE_PATH_SEGMENT.test(cliSessionId)) {
      return reply.status(400).send({ success: false, error: "Invalid session_id in JSONL" })
    }

    // Write the JSONL to the user's Claude projects dir
    const { mkdir: mkdirAsync, writeFile: writeFileAsync } = await import("node:fs/promises")
    const projectDir = `/home/appuser/${user.sub}/.claude/projects/imported`
    await mkdirAsync(projectDir, { recursive: true })
    await writeFileAsync(`${projectDir}/${cliSessionId}.jsonl`, body.jsonl)

    // Create a Fleet session that can resume this
    const repoSource = (body.repoSource as { mode: string }) ?? { mode: "direct" as const, repos: [] }
    const newSession = await sessionStore.create({
      userId: user.sub,
      prompt: `[Imported] ${firstPrompt}`,
      repoSource: repoSource as import("../types/index.js").RepoSource,
    })

    // Store the CLI session ID for resume
    await sessionStore.updateCliSessionId(newSession.id, cliSessionId)

    return { success: true, data: { id: newSession.id, cliSessionId } }
  })
}

export { registerTaskRoutes, isRepoAllowed, parseAllowedRepos }
