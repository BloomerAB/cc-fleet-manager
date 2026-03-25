import { execFile, spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type { Env } from "../env.js"
import type { SessionStore } from "./session-store.js"
import type { UserStore } from "./user-store.js"
import type { WsManager } from "./ws-manager.js"
import type { RepoConfig, RepoSource, PermissionMode } from "../types/index.js"
import { parseCliLine } from "./cli-stream-parser.js"
import { minimatch } from "minimatch"

const execFileAsync = promisify(execFile)

const GITHUB_API = "https://api.github.com"
const PER_PAGE = 100
const KILL_TIMEOUT_MS = 5000

interface ActiveTask {
  readonly sessionId: string
  readonly userId: string
  readonly process: ChildProcess
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
) => {
  const activeTasks = new Map<string, ActiveTask>()

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

  const buildCliArgs = (
    prompt: string,
    systemPrompt: string,
    sessionId: string,
    permissionMode: PermissionMode,
    model: string,
    maxTurns: number,
  ): readonly string[] => {
    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--append-system-prompt", systemPrompt,
      "--max-turns", String(maxTurns),
      "--session-id", sessionId,
      "--strict-mcp-config",
      "--model", model,
    ]

    // --bare for apiKey mode (faster startup, skips OAuth)
    if (env.AUTH_MODE === "apiKey") {
      args.push("--bare")
    }

    // Permission mode
    if (permissionMode === "bypassPermissions") {
      args.push("--dangerously-skip-permissions")
    } else {
      args.push("--permission-mode", permissionMode)
    }

    return args
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

  const executeTask = async (sessionId: string, userId: string): Promise<void> => {
    const session = await sessionStore.findById(sessionId, userId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    if (activeTasks.size >= env.MAX_CONCURRENT_TASKS) {
      throw new Error("Maximum concurrent tasks reached")
    }

    const workspaceDir = join(env.WORKSPACE_BASE_DIR, sessionId)
    let killed = false

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

      // Default settings — user can override via Settings page
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
          // Deep merge permissions.allow if user provides it
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

      // Write CLAUDE.md with user rules (Claude Code reads this natively)
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

      // Build system prompt with platform rules and repo context
      const systemPrompt = buildSystemPrompt(session.repoSource, availableRepos, userRules, session.rules)

      // Build CLI arguments
      const args = buildCliArgs(
        session.prompt,
        systemPrompt,
        sessionId,
        session.permissionMode,
        session.model,
        session.maxTurns,
      )

      // Build environment for the CLI process
      const spawnEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        SHELL: "/bin/sh",
        GIT_CONFIG_GLOBAL: join(workspaceDir, ".gitconfig"),
      }

      if (env.AUTH_MODE === "apiKey" && anthropicKey) {
        spawnEnv.ANTHROPIC_API_KEY = anthropicKey
        spawnEnv.HOME = workspaceDir
      } else {
        // subscription mode: HOME stays at /home/appuser (PVC mount with credentials)
        // Explicitly remove any stale API key so CLI uses OAuth
        delete spawnEnv.ANTHROPIC_API_KEY
        spawnEnv.HOME = "/home/appuser"
      }

      // Spawn the Claude CLI process
      const proc = spawn("claude", args as string[], {
        cwd: workspaceDir,
        env: spawnEnv,
        stdio: ["ignore", "pipe", "pipe"],
      })

      activeTasks.set(sessionId, { sessionId, userId, process: proc })

      // Collect stderr for error reporting
      let stderr = ""
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      // Parse stdout line-by-line
      let gotResult = false
      const rl = createInterface({ input: proc.stdout! })

      for await (const line of rl) {
        if (killed) break

        const actions = parseCliLine(line)
        for (const action of actions) {
          switch (action.kind) {
            case "output": {
              wsManager.emitToSession(sessionId, userId, {
                type: "output",
                sessionId,
                text: action.text,
                toolName: action.toolName,
                timestamp: new Date().toISOString(),
              })
              sessionStore.addMessage(sessionId, "assistant", action.text, action.toolName).catch(() => {})
              break
            }
            case "result": {
              gotResult = true
              const result = {
                success: action.success,
                summary: action.summary,
                costUsd: action.costUsd,
                turnsUsed: action.turnsUsed,
              }
              const status = action.success ? "completed" as const : "failed" as const
              sessionStore.updateStatus(sessionId, status, { result }).catch(() => {})
              sessionStore.updateCliSessionId(sessionId, action.cliSessionId).catch(() => {})
              wsManager.emitToSession(sessionId, userId, {
                type: "session_update",
                sessionId,
                status,
              })
              wsManager.emitToSession(sessionId, userId, {
                type: "result",
                sessionId,
                result,
              })
              break
            }
            case "system": {
              wsManager.emitToSession(sessionId, userId, {
                type: "output",
                sessionId,
                text: action.text,
                timestamp: new Date().toISOString(),
              })
              break
            }
          }
        }
      }

      // Wait for process to exit
      await new Promise<void>((resolve) => {
        if (proc.exitCode !== null) {
          resolve()
          return
        }
        proc.on("close", () => resolve())
      })

      // If no result event was received and process exited non-zero, mark as failed
      if (!gotResult && !killed) {
        const errorMsg = stderr.trim() || `Process exited with code ${proc.exitCode}`
        await sessionStore.updateStatus(sessionId, "failed", {
          result: { success: false, summary: `Error: ${errorMsg}` },
        })
        wsManager.emitToSession(sessionId, userId, {
          type: "session_update",
          sessionId,
          status: "failed",
        })
        wsManager.emitToSession(sessionId, userId, {
          type: "result",
          sessionId,
          result: { success: false, summary: `Error: ${errorMsg}` },
        })
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (!killed) {
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
      }
    } finally {
      activeTasks.delete(sessionId)
      await cleanupWorkspace(workspaceDir)
    }
  }

  const cancelTask = (sessionId: string): boolean => {
    const task = activeTasks.get(sessionId)
    if (!task) return false

    task.process.kill("SIGTERM")

    // Force kill after timeout
    setTimeout(() => {
      try {
        task.process.kill("SIGKILL")
      } catch {
        // Already exited
      }
    }, KILL_TIMEOUT_MS)

    return true
  }

  const killAllTasks = (): void => {
    for (const task of activeTasks.values()) {
      try {
        task.process.kill("SIGTERM")
      } catch {
        // Already exited
      }
    }
  }

  return {
    executeTask,
    cancelTask,
    killAllTasks,
    getActiveCount: () => activeTasks.size,
  }
}

type TaskExecutor = ReturnType<typeof createTaskExecutor>

export { type TaskExecutor, createTaskExecutor }
