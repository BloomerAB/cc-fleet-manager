import { execFile } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { Query, SDKMessage, SDKAssistantMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Env } from "../env.js"
import type { SessionStore } from "./session-store.js"
import type { UserStore } from "./user-store.js"
import type { WsManager } from "./ws-manager.js"
import type { RepoConfig, RepoSource, StageState } from "../types/index.js"
import type { PipelineRegistry } from "./pipeline-registry.js"
import { minimatch } from "minimatch"

const execFileAsync = promisify(execFile)

const GITHUB_API = "https://api.github.com"
const PER_PAGE = 100
const IDLE_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes
const IDLE_CHECK_INTERVAL_MS = 60 * 1000 // 1 minute

interface InputQueue {
  push(msg: { type: "user"; message: { role: "user"; content: string }; parent_tool_use_id: null; session_id: string }): void
  close(): void
}

const createInputQueue = (): { stream: AsyncIterable<{ type: "user"; message: { role: "user"; content: string }; parent_tool_use_id: null; session_id: string }>; queue: InputQueue } => {
  type UserMsg = { type: "user"; message: { role: "user"; content: string }; parent_tool_use_id: null; session_id: string }
  const pending: UserMsg[] = []
  let resolver: ((value: IteratorResult<UserMsg>) => void) | null = null
  let closed = false

  const stream: AsyncIterable<UserMsg> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<UserMsg>> {
          if (pending.length > 0) {
            return Promise.resolve({ value: pending.shift()!, done: false })
          }
          if (closed) {
            return Promise.resolve({ value: undefined as unknown as UserMsg, done: true })
          }
          return new Promise((resolve) => { resolver = resolve })
        },
      }
    },
  }

  const queue: InputQueue = {
    push(msg: UserMsg) {
      if (resolver) {
        const r = resolver
        resolver = null
        r({ value: msg, done: false })
      } else {
        pending.push(msg)
      }
    },
    close() {
      closed = true
      if (resolver) {
        const r = resolver
        resolver = null
        r({ value: undefined as unknown as UserMsg, done: true })
      }
    },
  }

  return { stream, queue }
}

interface SessionContext {
  readonly sessionId: string
  readonly userId: string
  readonly workspaceDir: string
  query: Query | null
  inputQueue: InputQueue | null
  cliSessionId: string | null
  totalCostUsd: number
  totalTurnsUsed: number
  lastActivityAt: number
  pipelineId: string | null
  stageState: StageState | null
}

interface GhRepo {
  readonly name: string
  readonly full_name: string
  readonly html_url: string
  readonly clone_url: string
  readonly description: string | null
  readonly language: string | null
  readonly default_branch: string
  readonly archived: boolean
}

const createTaskExecutor = (
  env: Env,
  sessionStore: SessionStore,
  userStore: UserStore,
  wsManager: WsManager,
  pipelineRegistry: PipelineRegistry,
) => {
  const sessionContexts = new Map<string, SessionContext>()
  const activeTurns = new Set<string>()

  const getGitToken = async (userId: string): Promise<string | null> => {
    const token = await userStore.getAccessToken(userId)
    if (token) return token
    return env.GIT_TOKEN || null
  }

  const getAnthropicKey = async (userId: string): Promise<string | null> => {
    if (env.AUTH_MODE === "subscription") return null
    const userKey = await userStore.getAnthropicApiKey(userId)
    if (userKey) return userKey
    if (env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY
    throw new Error("No Anthropic API key configured. Set your key in Settings, or switch to subscription auth mode.")
  }

  const fetchOrgRepos = async (org: string, token: string): Promise<readonly GhRepo[]> => {
    const results: GhRepo[] = []
    let page = 1

    while (true) {
      const response = await fetch(
        `${GITHUB_API}/orgs/${encodeURIComponent(org)}/repos?sort=updated&per_page=${PER_PAGE}&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      )

      if (!response.ok) {
        if (page === 1) return fetchUserRepos(token)
        break
      }

      const items = (await response.json()) as GhRepo[]
      results.push(...items)
      if (items.length < PER_PAGE) break
      page++
    }

    return results.filter((r) => !r.archived)
  }

  const fetchUserRepos = async (token: string): Promise<readonly GhRepo[]> => {
    const results: GhRepo[] = []
    let page = 1

    while (true) {
      const response = await fetch(
        `${GITHUB_API}/user/repos?type=owner&sort=updated&per_page=${PER_PAGE}&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      )

      if (!response.ok) break
      const items = (await response.json()) as GhRepo[]
      results.push(...items)
      if (items.length < PER_PAGE) break
      page++
    }

    return results.filter((r) => !r.archived)
  }

  const cloneRepos = async (
    repos: readonly RepoConfig[],
    workspaceDir: string,
    gitToken: string | null,
  ): Promise<void> => {
    await mkdir(workspaceDir, { recursive: true })

    for (const repo of repos) {
      const url = gitToken
        ? repo.url.replace("https://", `https://x-access-token:${gitToken}@`)
        : repo.url

      const args = ["clone", "--depth", "1"]
      if (repo.branch) {
        args.push("--branch", repo.branch)
      }
      args.push(url, join(workspaceDir, repoNameFromUrl(repo.url)))

      await execFileAsync("git", args, { timeout: 120_000 })
    }
  }

  const repoNameFromUrl = (url: string): string => {
    const parts = url.replace(/\.git$/, "").split("/")
    return parts[parts.length - 1]
  }

  const configureGitCredentials = async (
    workspaceDir: string,
    gitToken: string,
  ): Promise<void> => {
    const gitConfig = [
      "[credential]",
      `  helper = store --file=${join(workspaceDir, ".git-credentials")}`,
      "[user]",
      "  name = cc-fleet",
      "  email = cc-fleet@noreply",
    ].join("\n")

    const credentials = `https://x-access-token:${gitToken}@github.com\n`

    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, ".gitconfig"), gitConfig)
    await writeFile(join(workspaceDir, ".git-credentials"), credentials, { mode: 0o600 })
  }

  const PLATFORM_RULES = `# CC Fleet — Platform Rules

You are running as an autonomous agent via CC Fleet.
Git credentials are pre-configured — use \`git push\` directly.

## Workflow
- Always create a feature branch from the default branch before making changes
- Use conventional commits (feat:, fix:, refactor:, docs:, test:, chore:)
- Create a pull request when code changes are made — never push directly to main
- Run tests before committing if a test framework is configured
- Keep commits small and focused — one logical change per commit

## Quality
- Read existing code before modifying — understand conventions first
- Follow the project's existing code style and patterns
- Add tests for new functionality when a test framework exists
- Do not leave debug logs, commented-out code, or TODOs

## Safety
- Never hardcode secrets, API keys, or credentials
- Never run destructive commands (rm -rf, DROP TABLE, force push) without confirmation
- If something is unclear or risky, stop and ask the user`

  const buildSystemPrompt = (
    repoSource: RepoSource,
    availableRepos: readonly GhRepo[] | null,
    userRules: string | null,
    taskRules: string | null,
  ): string => {
    const sections: string[] = [PLATFORM_RULES]

    if (repoSource.mode === "org" && availableRepos) {
      sections.push([
        `## Available repositories (${repoSource.org})`,
        "",
        "These repos matched the filter. They are NOT yet cloned.",
        "Clone only the repos you need to complete the task using `git clone <url>`.",
        "",
        ...availableRepos.map(
          (r) => `- **${r.name}** (${r.language ?? "unknown"}) — ${r.description ?? "no description"} → ${r.clone_url}`,
        ),
      ].join("\n"))
    } else if (repoSource.mode === "discovery" && availableRepos) {
      sections.push([
        `## Repository discovery mode (${repoSource.org})`,
        "",
        "Below is the full list of repos in this org. Analyze the task and decide which repos are relevant.",
        "Clone only what you need. If unsure, start with the most likely candidates.",
        repoSource.hint ? `\nHint from user: ${repoSource.hint}` : "",
        "",
        ...availableRepos.map(
          (r) => `- **${r.name}** (${r.language ?? "unknown"}) — ${r.description ?? "no description"} → ${r.clone_url}`,
        ),
      ].join("\n"))
    }

    if (userRules?.trim()) {
      sections.push(`# User Rules\n\n${userRules.trim()}`)
    }

    if (taskRules?.trim()) {
      sections.push(`# Task Rules\n\n${taskRules.trim()}`)
    }

    return sections.join("\n\n")
  }

  const cleanupWorkspace = async (workspaceDir: string): Promise<void> => {
    try {
      await rm(workspaceDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup
    }
  }

  const resolveRepos = async (
    repoSource: RepoSource,
    gitToken: string,
  ): Promise<{ readonly repos: readonly RepoConfig[]; readonly availableRepos: readonly GhRepo[] | null }> => {
    switch (repoSource.mode) {
      case "direct":
        return { repos: repoSource.repos, availableRepos: null }

      case "org": {
        const allRepos = await fetchOrgRepos(repoSource.org, gitToken)
        const filtered = repoSource.pattern
          ? allRepos.filter((r) => minimatch(r.name, repoSource.pattern!))
          : allRepos

        const repos = filtered.map((r) => ({
          url: r.clone_url,
          branch: r.default_branch,
        }))

        return { repos, availableRepos: filtered }
      }

      case "discovery": {
        const allRepos = await fetchOrgRepos(repoSource.org, gitToken)
        return { repos: [], availableRepos: allRepos }
      }
    }
  }

  /** Emit a stage_update message to the dashboard */
  const emitStageUpdate = (ctx: SessionContext): void => {
    if (!ctx.stageState || !ctx.pipelineId) return

    const pipeline = pipelineRegistry.getById(ctx.pipelineId)
    if (!pipeline) return

    const stage = pipeline.stages[ctx.stageState.currentStageIndex]
    if (!stage) return

    wsManager.emitToSession(ctx.sessionId, ctx.userId, {
      type: "stage_update",
      sessionId: ctx.sessionId,
      stageState: ctx.stageState,
      currentStage: {
        id: stage.id,
        name: stage.name,
        description: stage.description,
        transition: stage.transition,
      },
    })
  }

  /** Advance to the next pipeline stage (internal) */
  const doAdvanceStage = async (ctx: SessionContext): Promise<void> => {
    if (!ctx.stageState || !ctx.pipelineId || !ctx.inputQueue) return

    const pipeline = pipelineRegistry.getById(ctx.pipelineId)
    if (!pipeline) return

    const currentStage = pipeline.stages[ctx.stageState.currentStageIndex]
    if (currentStage) {
      ctx.stageState.stageResults.push({
        stageId: currentStage.id,
        status: "completed",
        completedAt: new Date().toISOString(),
      })
    }

    const nextIndex = ctx.stageState.currentStageIndex + 1

    if (nextIndex >= pipeline.stages.length) {
      // All stages complete — end the session
      await sessionStore.updateStageState(ctx.sessionId, ctx.stageState)
      await endSession(ctx.sessionId, ctx.userId)
      return
    }

    // Move to the next stage
    ctx.stageState.currentStageIndex = nextIndex
    ctx.stageState.stageStartedAt = new Date().toISOString()
    await sessionStore.updateStageState(ctx.sessionId, ctx.stageState)

    const nextStage = pipeline.stages[nextIndex]
    emitStageUpdate(ctx)

    // Push a stage transition message to resume the SDK turn
    const stageMessage = nextStage.systemPromptAppend
      ? `[Stage transition: now entering "${nextStage.name}" stage]\n\n${nextStage.systemPromptAppend}\n\nContinue with the task.`
      : `[Stage transition: now entering "${nextStage.name}" stage]\n\nContinue with the task.`

    ctx.lastActivityAt = Date.now()
    activeTurns.add(ctx.sessionId)

    await sessionStore.updateStatus(ctx.sessionId, "running")
    wsManager.emitToSession(ctx.sessionId, ctx.userId, {
      type: "session_update",
      sessionId: ctx.sessionId,
      status: "running",
    })

    ctx.inputQueue.push({
      type: "user",
      message: { role: "user", content: stageMessage },
      parent_tool_use_id: null,
      session_id: ctx.cliSessionId ?? ctx.sessionId,
    })
  }

  /** Skip the current pipeline stage (internal) */
  const doSkipStage = async (ctx: SessionContext): Promise<void> => {
    if (!ctx.stageState || !ctx.pipelineId || !ctx.inputQueue) return

    const pipeline = pipelineRegistry.getById(ctx.pipelineId)
    if (!pipeline) return

    const currentStage = pipeline.stages[ctx.stageState.currentStageIndex]
    if (currentStage) {
      ctx.stageState.stageResults.push({
        stageId: currentStage.id,
        status: "skipped",
        completedAt: new Date().toISOString(),
      })
    }

    const nextIndex = ctx.stageState.currentStageIndex + 1

    if (nextIndex >= pipeline.stages.length) {
      await sessionStore.updateStageState(ctx.sessionId, ctx.stageState)
      await endSession(ctx.sessionId, ctx.userId)
      return
    }

    ctx.stageState.currentStageIndex = nextIndex
    ctx.stageState.stageStartedAt = new Date().toISOString()
    await sessionStore.updateStageState(ctx.sessionId, ctx.stageState)

    const nextStage = pipeline.stages[nextIndex]
    emitStageUpdate(ctx)

    const stageMessage = nextStage.systemPromptAppend
      ? `[Stage transition: skipped previous stage, now entering "${nextStage.name}" stage]\n\n${nextStage.systemPromptAppend}\n\nContinue with the task.`
      : `[Stage transition: skipped previous stage, now entering "${nextStage.name}" stage]\n\nContinue with the task.`

    ctx.lastActivityAt = Date.now()
    activeTurns.add(ctx.sessionId)

    await sessionStore.updateStatus(ctx.sessionId, "running")
    wsManager.emitToSession(ctx.sessionId, ctx.userId, {
      type: "session_update",
      sessionId: ctx.sessionId,
      status: "running",
    })

    ctx.inputQueue.push({
      type: "user",
      message: { role: "user", content: stageMessage },
      parent_tool_use_id: null,
      session_id: ctx.cliSessionId ?? ctx.sessionId,
    })
  }

  /** Extract text content from SDK assistant messages */
  const extractTextFromMessage = (msg: SDKAssistantMessage): { text: string; toolBlocks: { name: string; input: string }[] } => {
    let text = ""
    const toolBlocks: { name: string; input: string }[] = []

    if (msg.message && "content" in msg.message) {
      const content = msg.message.content as unknown[]
      for (const block of content) {
        const b = block as Record<string, unknown>
        if (b.type === "text" && typeof b.text === "string") {
          text += b.text
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          toolBlocks.push({ name: b.name, input: JSON.stringify(b.input ?? {}) })
        }
      }
    }

    return { text, toolBlocks }
  }

  /** Run the SDK message loop for the entire session lifetime (background) */
  const runSessionLoop = async (ctx: SessionContext): Promise<void> => {
    console.log(`[fleet] Session loop started for ${ctx.sessionId}`)

    try {
      for await (const msg of ctx.query!) {
        const sdkMsg = msg as SDKMessage
        console.log(`[fleet] SDK message: type=${sdkMsg.type}${("subtype" in sdkMsg ? ` subtype=${sdkMsg.subtype}` : "")}`)

        if (sdkMsg.type === "assistant") {
          const assistant = sdkMsg as SDKAssistantMessage
          const { text, toolBlocks } = extractTextFromMessage(assistant)

          if (text) {
            wsManager.emitToSession(ctx.sessionId, ctx.userId, {
              type: "output",
              sessionId: ctx.sessionId,
              text,
              timestamp: new Date().toISOString(),
            })
            sessionStore.addMessage(ctx.sessionId, "assistant", text).catch(() => {})
          }

          for (const tool of toolBlocks) {
            wsManager.emitToSession(ctx.sessionId, ctx.userId, {
              type: "output",
              sessionId: ctx.sessionId,
              text: tool.input,
              toolName: tool.name,
              timestamp: new Date().toISOString(),
            })
            sessionStore.addMessage(ctx.sessionId, "tool", tool.input, tool.name).catch(() => {})
          }

          if (!ctx.cliSessionId && sdkMsg.session_id) {
            ctx.cliSessionId = sdkMsg.session_id
            sessionStore.updateCliSessionId(ctx.sessionId, sdkMsg.session_id).catch(() => {})
          }
        } else if (sdkMsg.type === "result") {
          const result = sdkMsg as SDKResultMessage
          ctx.totalCostUsd += ("total_cost_usd" in result ? result.total_cost_usd : 0) ?? 0
          ctx.totalTurnsUsed += ("num_turns" in result ? result.num_turns : 0) ?? 0

          if (!ctx.cliSessionId && result.session_id) {
            ctx.cliSessionId = result.session_id
            sessionStore.updateCliSessionId(ctx.sessionId, result.session_id).catch(() => {})
          }

          // Turn completed
          ctx.lastActivityAt = Date.now()
          activeTurns.delete(ctx.sessionId)
          const turnResult = {
            success: true,
            summary: "Turn completed",
            costUsd: ctx.totalCostUsd,
            turnsUsed: ctx.totalTurnsUsed,
          }

          // Check for pipeline auto-advance
          if (ctx.stageState && ctx.pipelineId) {
            const pipeline = pipelineRegistry.getById(ctx.pipelineId)
            const currentStage = pipeline?.stages[ctx.stageState.currentStageIndex]
            if (currentStage?.transition === "auto") {
              await sessionStore.updateStatus(ctx.sessionId, "waiting_for_input", { result: turnResult })
              wsManager.emitToSession(ctx.sessionId, ctx.userId, {
                type: "result",
                sessionId: ctx.sessionId,
                result: turnResult,
              })
              // Auto-advance to next stage
              await doAdvanceStage(ctx)
              continue
            }
          }

          // No auto-advance — signal waiting_for_input
          await sessionStore.updateStatus(ctx.sessionId, "waiting_for_input", { result: turnResult })
          wsManager.emitToSession(ctx.sessionId, ctx.userId, {
            type: "session_update",
            sessionId: ctx.sessionId,
            status: "waiting_for_input",
          })
          wsManager.emitToSession(ctx.sessionId, ctx.userId, {
            type: "result",
            sessionId: ctx.sessionId,
            result: turnResult,
          })

          // Emit stage info if pipeline is active
          if (ctx.stageState && ctx.pipelineId) {
            emitStageUpdate(ctx)
          }
        } else if (sdkMsg.type === "system" && "subtype" in sdkMsg && sdkMsg.subtype === "init") {
          wsManager.emitToSession(ctx.sessionId, ctx.userId, {
            type: "output",
            sessionId: ctx.sessionId,
            text: "[System: init]",
            timestamp: new Date().toISOString(),
          })
        }
      }

      // Iterator finished — session process exited
      console.log(`[fleet] Session loop ended for ${ctx.sessionId}`)
      if (sessionContexts.has(ctx.sessionId)) {
        const finalResult = {
          success: true,
          summary: "Session completed",
          costUsd: ctx.totalCostUsd,
          turnsUsed: ctx.totalTurnsUsed,
        }
        await sessionStore.updateStatus(ctx.sessionId, "completed", { result: finalResult })
        wsManager.emitToSession(ctx.sessionId, ctx.userId, {
          type: "session_update",
          sessionId: ctx.sessionId,
          status: "completed",
        })
        wsManager.emitToSession(ctx.sessionId, ctx.userId, {
          type: "result",
          sessionId: ctx.sessionId,
          result: finalResult,
        })
        sessionContexts.delete(ctx.sessionId)
        await cleanupWorkspace(ctx.workspaceDir)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`[fleet] Session loop error for ${ctx.sessionId}: ${errorMessage}`)
      if (sessionContexts.has(ctx.sessionId)) {
        await sessionStore.updateStatus(ctx.sessionId, "failed", {
          result: { success: false, summary: `Error: ${errorMessage}` },
        })
        wsManager.emitToSession(ctx.sessionId, ctx.userId, {
          type: "session_update",
          sessionId: ctx.sessionId,
          status: "failed",
        })
        sessionContexts.delete(ctx.sessionId)
        await cleanupWorkspace(ctx.workspaceDir)
      }
    } finally {
      activeTurns.delete(ctx.sessionId)
    }
  }

  const executeTask = async (sessionId: string, userId: string, resumeCliSessionId?: string): Promise<void> => {
    const session = await sessionStore.findById(sessionId, userId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    if (sessionContexts.size >= env.MAX_CONCURRENT_TASKS) {
      throw new Error("Maximum concurrent tasks reached")
    }

    const workspaceDir = join(env.WORKSPACE_BASE_DIR, sessionId)

    try {
      await sessionStore.updateStatus(sessionId, "running")
      wsManager.emitToSession(sessionId, userId, {
        type: "session_update",
        sessionId,
        status: "running",
      })

      const gitToken = await getGitToken(userId)
      const anthropicKey = await getAnthropicKey(userId)

      // Resolve repos based on source mode
      const { repos, availableRepos } = await resolveRepos(
        session.repoSource,
        gitToken ?? "",
      )

      // Pre-clone repos for direct and org modes
      if (repos.length > 0) {
        await cloneRepos(repos, workspaceDir, gitToken)
      } else {
        await mkdir(workspaceDir, { recursive: true })
      }

      // Configure git credentials so Claude can clone additional repos
      if (gitToken) {
        await configureGitCredentials(workspaceDir, gitToken)
      }

      // Pre-configure Claude Code workspace
      const claudeSettingsDir = join(workspaceDir, ".claude")
      await mkdir(claudeSettingsDir, { recursive: true })

      // Default settings
      const defaultSettings = {
        permissions: {
          allow: [
            "Bash(*)",
            "Read(*)",
            "Write(*)",
            "Edit(*)",
            "WebFetch(*)",
            "Grep(*)",
            "Glob(*)",
          ],
        },
      }

      // Merge user settings over defaults
      const userSettingsRaw = await userStore.getClaudeSettings(userId)
      let finalSettings = defaultSettings
      if (userSettingsRaw) {
        try {
          const userSettings = JSON.parse(userSettingsRaw)
          finalSettings = { ...defaultSettings, ...userSettings }
          if (userSettings.permissions?.allow) {
            finalSettings = {
              ...finalSettings,
              permissions: {
                ...finalSettings.permissions,
                allow: [...new Set([...defaultSettings.permissions.allow, ...userSettings.permissions.allow])],
              },
            }
          }
        } catch {
          // Invalid JSON, use defaults
        }
      }

      await writeFile(join(claudeSettingsDir, "settings.json"), JSON.stringify(finalSettings))

      // Write CLAUDE.md with user rules
      const userRules = await userStore.getRules(userId)
      const claudeMdParts: string[] = []
      if (userRules?.trim()) {
        claudeMdParts.push(userRules.trim())
      }
      if (session.rules?.trim()) {
        claudeMdParts.push(session.rules.trim())
      }
      if (claudeMdParts.length > 0) {
        await writeFile(join(workspaceDir, "CLAUDE.md"), claudeMdParts.join("\n\n"))
      }

      // Build system prompt
      const systemPrompt = buildSystemPrompt(session.repoSource, availableRepos, userRules, session.rules)

      // Write kubeconfig if user has one configured
      const kubeconfig = await userStore.getKubeconfig(userId)
      if (kubeconfig) {
        const kubeDir = join(workspaceDir, ".kube")
        await mkdir(kubeDir, { recursive: true })
        await writeFile(join(kubeDir, "config"), kubeconfig, { mode: 0o600 })
      }

      // HOME is per-user for isolation — each user gets their own ~/.claude/
      const userHomeDir = join("/home/appuser", userId)
      await mkdir(join(userHomeDir, ".claude"), { recursive: true })

      const spawnEnv: Record<string, string | undefined> = {
        ...process.env,
        SHELL: "/bin/sh",
        HOME: userHomeDir,
        TMPDIR: workspaceDir,
        GIT_CONFIG_GLOBAL: join(workspaceDir, ".gitconfig"),
        KUBECONFIG: kubeconfig ? join(workspaceDir, ".kube", "config") : undefined,
        CLAUDE_AGENT_SDK_CLIENT_APP: "cc-fleet/0.3.0",
      }

      if (env.AUTH_MODE === "apiKey" && anthropicKey) {
        spawnEnv.ANTHROPIC_API_KEY = anthropicKey
      } else {
        delete spawnEnv.ANTHROPIC_API_KEY
      }

      // Map permission mode — SDK uses "bypassPermissions" differently
      const sdkPermissionMode = session.permissionMode === "bypassPermissions"
        ? "bypassPermissions" as const
        : session.permissionMode as "plan" | "acceptEdits"

      // Create input queue — keeps the SDK process alive until we close it
      const { stream: inputStream, queue: inputQueue } = createInputQueue()

      const sdkOptions = {
        cwd: workspaceDir,
        systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: systemPrompt },
        maxTurns: session.maxTurns,
        model: session.model === "opus" ? "claude-opus-4-6" : "claude-sonnet-4-6",
        permissionMode: sdkPermissionMode,
        allowedTools: [
          "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch",
        ],
        env: spawnEnv,
        abortController: new AbortController(),
      }

      let q: Query
      if (resumeCliSessionId) {
        // Resume mode: load conversation history, then wait for follow-up input
        console.log(`[fleet] Resuming SDK session ${resumeCliSessionId} for fleet session ${sessionId}`)
        q = query({
          prompt: inputStream,
          options: { ...sdkOptions, resume: resumeCliSessionId },
        })
        // Don't push initial message — the conversation history is loaded from the JSONL
        // Push a continuation prompt instead
        inputQueue.push({
          type: "user",
          message: { role: "user", content: "I'm back. Continue where we left off — what's the status and what should we do next?" },
          parent_tool_use_id: null,
          session_id: resumeCliSessionId,
        })
      } else {
        // New session: push the initial prompt
        console.log(`[fleet] Creating SDK query for session ${sessionId}, model=${session.model}, cwd=${workspaceDir}`)

        // If pipeline is active, prepend the first stage's system prompt
        let initialPrompt = session.prompt
        if (session.pipelineId) {
          const pipeline = pipelineRegistry.getById(session.pipelineId)
          const firstStage = pipeline?.stages[0]
          if (firstStage?.systemPromptAppend) {
            initialPrompt = `${firstStage.systemPromptAppend}\n\n---\n\nTask: ${session.prompt}`
          }
        }

        inputQueue.push({
          type: "user",
          message: { role: "user", content: initialPrompt },
          parent_tool_use_id: null,
          session_id: sessionId,
        })
        q = query({
          prompt: inputStream,
          options: sdkOptions,
        })
      }

      // Initialize pipeline stage state if pipelineId is set
      let stageState: StageState | null = null
      if (session.pipelineId) {
        const pipeline = pipelineRegistry.getById(session.pipelineId)
        if (pipeline) {
          stageState = {
            pipelineId: session.pipelineId,
            currentStageIndex: 0,
            stageResults: [],
            stageStartedAt: new Date().toISOString(),
          }
          await sessionStore.updateStageState(sessionId, stageState)
        }
      }

      // Create session context
      const ctx: SessionContext = {
        sessionId,
        userId,
        workspaceDir,
        query: q,
        inputQueue,
        cliSessionId: null,
        totalCostUsd: 0,
        totalTurnsUsed: 0,
        lastActivityAt: Date.now(),
        pipelineId: session.pipelineId ?? null,
        stageState,
      }
      sessionContexts.set(sessionId, ctx)

      // Run the session loop in the background — it handles all turns
      activeTurns.add(sessionId)
      runSessionLoop(ctx).catch((error) => {
        console.error(`[fleet] Background session loop failed for ${sessionId}: ${error}`)
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      await sessionStore.updateStatus(sessionId, "failed", {
        result: { success: false, summary: `Error: ${errorMessage}` },
      })
      wsManager.emitToSession(sessionId, userId, {
        type: "session_update",
        sessionId,
        status: "failed",
      })
      wsManager.emitToSession(sessionId, userId, {
        type: "result",
        sessionId,
        result: { success: false, summary: `Error: ${errorMessage}` },
      })

      // Cleanup on failure
      const ctx = sessionContexts.get(sessionId)
      if (ctx?.query) {
        try { ctx.query.close() } catch { /* already closed */ }
      }
      sessionContexts.delete(sessionId)
      await cleanupWorkspace(workspaceDir)
    }
  }

  const sendFollowUp = async (sessionId: string, userId: string, text: string): Promise<void> => {
    const ctx = sessionContexts.get(sessionId)
    if (!ctx) throw new Error(`No active session context for ${sessionId}`)
    if (!ctx.inputQueue) throw new Error(`Session ${sessionId} has no input queue`)
    if (activeTurns.has(sessionId)) throw new Error(`Session ${sessionId} already has a running turn`)

    ctx.lastActivityAt = Date.now()
    activeTurns.add(sessionId)

    // Update status
    await sessionStore.updateStatus(sessionId, "running")
    wsManager.emitToSession(sessionId, userId, {
      type: "session_update",
      sessionId,
      status: "running",
    })

    // Echo user message
    wsManager.emitToSession(sessionId, userId, {
      type: "output",
      sessionId,
      text: `**You:** ${text}`,
      timestamp: new Date().toISOString(),
    })
    await sessionStore.addMessage(sessionId, "user", text)

    // Push to the input queue — the background loop picks it up
    ctx.inputQueue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: ctx.cliSessionId ?? sessionId,
    })
  }

  const endSession = async (sessionId: string, userId: string): Promise<void> => {
    const ctx = sessionContexts.get(sessionId)

    // Close the input queue and query
    if (ctx?.inputQueue) {
      ctx.inputQueue.close()
    }
    if (ctx?.query) {
      try { ctx.query.close() } catch { /* already closed */ }
    }

    const result = ctx
      ? {
          success: true,
          summary: "Session ended by user",
          costUsd: ctx.totalCostUsd,
          turnsUsed: ctx.totalTurnsUsed,
        }
      : { success: true, summary: "Session ended by user" }

    await sessionStore.updateStatus(sessionId, "completed", { result })
    wsManager.emitToSession(sessionId, userId, {
      type: "session_update",
      sessionId,
      status: "completed",
    })
    wsManager.emitToSession(sessionId, userId, {
      type: "result",
      sessionId,
      result,
    })

    if (ctx) {
      sessionContexts.delete(sessionId)
      await cleanupWorkspace(ctx.workspaceDir)
    }
  }

  const cancelTask = (sessionId: string): boolean => {
    const ctx = sessionContexts.get(sessionId)
    if (!ctx) return false

    if (ctx.inputQueue) {
      ctx.inputQueue.close()
    }
    if (ctx.query) {
      try { ctx.query.close() } catch { /* already closed */ }
    }

    sessionContexts.delete(sessionId)
    cleanupWorkspace(ctx.workspaceDir).catch(() => {})

    return true
  }

  const killAllTasks = (): void => {
    for (const ctx of sessionContexts.values()) {
      if (ctx.query) {
        try { ctx.query.close() } catch { /* */ }
      }
    }
  }

  // Idle timeout checker
  const idleCheckTimer = setInterval(() => {
    const now = Date.now()
    for (const [sessionId, ctx] of sessionContexts) {
      if (!activeTurns.has(sessionId) && now - ctx.lastActivityAt > IDLE_TIMEOUT_MS) {
        endSession(sessionId, ctx.userId).catch(() => {})
      }
    }
  }, IDLE_CHECK_INTERVAL_MS)

  // Prevent timer from keeping process alive
  if (idleCheckTimer.unref) {
    idleCheckTimer.unref()
  }

  const advanceStage = async (sessionId: string): Promise<void> => {
    const ctx = sessionContexts.get(sessionId)
    if (!ctx) throw new Error(`No active session context for ${sessionId}`)
    if (!ctx.stageState || !ctx.pipelineId) throw new Error(`Session ${sessionId} has no active pipeline`)
    if (activeTurns.has(sessionId)) throw new Error(`Session ${sessionId} has a running turn — wait for it to complete`)

    await doAdvanceStage(ctx)
  }

  const skipStage = async (sessionId: string): Promise<void> => {
    const ctx = sessionContexts.get(sessionId)
    if (!ctx) throw new Error(`No active session context for ${sessionId}`)
    if (!ctx.stageState || !ctx.pipelineId) throw new Error(`Session ${sessionId} has no active pipeline`)
    if (activeTurns.has(sessionId)) throw new Error(`Session ${sessionId} has a running turn — wait for it to complete`)

    await doSkipStage(ctx)
  }

  return {
    executeTask,
    sendFollowUp,
    endSession,
    cancelTask,
    killAllTasks,
    advanceStage,
    skipStage,
    getActiveCount: () => sessionContexts.size,
  }
}

type TaskExecutor = ReturnType<typeof createTaskExecutor>

export { type TaskExecutor, createTaskExecutor }
