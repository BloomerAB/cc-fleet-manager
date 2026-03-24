import { execFile } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Env } from "../env.js"
import type { SessionStore } from "./session-store.js"
import type { UserStore } from "./user-store.js"
import type { WsManager } from "./ws-manager.js"
import type { RepoConfig, RepoSource } from "../types/index.js"
import { minimatch } from "minimatch"

const execFileAsync = promisify(execFile)

const GITHUB_API = "https://api.github.com"
const PER_PAGE = 100

interface ActiveTask {
  readonly sessionId: string
  readonly userId: string
  readonly abortController: AbortController
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

  const getAnthropicKey = async (userId: string): Promise<string> => {
    const userKey = await userStore.getAnthropicApiKey(userId)
    if (userKey) return userKey
    if (env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY
    throw new Error("No Anthropic API key configured. Set your key in Settings.")
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
        // Try as user repos if org fetch fails (personal account)
        if (page === 1) {
          return fetchUserRepos(token)
        }
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
    // Write a .gitconfig and credential helper so Claude can clone repos
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

  const buildSystemPrompt = (
    repoSource: RepoSource,
    availableRepos: readonly GhRepo[] | null,
  ): string => {
    const parts = [
      "You are running as an autonomous agent via CC Fleet.",
      "Complete the task. Create a PR if code changes are made.",
      "Use `git push` after committing — the credentials are pre-configured.",
    ]

    if (repoSource.mode === "direct") {
      // Nothing extra needed — repos are pre-cloned
    } else if (repoSource.mode === "org" && availableRepos) {
      parts.push(
        "",
        `## Available repositories (${repoSource.org})`,
        "",
        "These repos matched the filter. They are NOT yet cloned.",
        "Clone only the repos you need to complete the task using `git clone <url>`.",
        "",
        ...availableRepos.map(
          (r) => `- **${r.name}** (${r.language ?? "unknown"}) — ${r.description ?? "no description"} → ${r.clone_url}`,
        ),
      )
    } else if (repoSource.mode === "discovery" && availableRepos) {
      parts.push(
        "",
        `## Repository discovery mode (${repoSource.org})`,
        "",
        "Below is the full list of repos in this org. Analyze the task and decide which repos are relevant.",
        "Clone only what you need. If unsure, start with the most likely candidates.",
        repoSource.hint ? `\nHint from user: ${repoSource.hint}` : "",
        "",
        ...availableRepos.map(
          (r) => `- **${r.name}** (${r.language ?? "unknown"}) — ${r.description ?? "no description"} → ${r.clone_url}`,
        ),
      )
    }

    return parts.join("\n")
  }

  const cleanupWorkspace = async (workspaceDir: string): Promise<void> => {
    try {
      await rm(workspaceDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup
    }
  }

  const handleSdkMessage = (
    message: SDKMessage,
    sessionId: string,
    userId: string,
  ): void => {
    switch (message.type) {
      case "assistant": {
        for (const block of message.message.content) {
          if (block.type === "text" && "text" in block) {
            wsManager.emitToSession(sessionId, userId, {
              type: "output",
              sessionId,
              text: block.text,
              timestamp: new Date().toISOString(),
            })
            sessionStore.addMessage(sessionId, "assistant", block.text).catch(() => {})
          } else if (block.type === "tool_use") {
            const text = JSON.stringify(block.input)
            wsManager.emitToSession(sessionId, userId, {
              type: "output",
              sessionId,
              text,
              toolName: block.name,
              timestamp: new Date().toISOString(),
            })
            sessionStore.addMessage(sessionId, "assistant", text, block.name).catch(() => {})
          }
        }
        break
      }
      case "result": {
        const success = message.subtype === "success"
        const result = {
          success,
          summary: success
            ? (message.result ?? "Task completed")
            : `Failed: ${message.subtype}`,
          costUsd: message.total_cost_usd,
          turnsUsed: message.num_turns,
        }
        const status = success ? "completed" as const : "failed" as const
        sessionStore.updateStatus(sessionId, status, { result }).catch(() => {})
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
          text: `[System: ${message.subtype}]`,
          timestamp: new Date().toISOString(),
        })
        break
      }
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

        // For org mode with pattern: pre-clone matching repos (user explicitly selected these)
        const repos = filtered.map((r) => ({
          url: r.clone_url,
          branch: r.default_branch,
        }))

        return { repos, availableRepos: filtered }
      }

      case "discovery": {
        // Discovery mode: don't clone anything upfront — Claude decides
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
    const abortController = new AbortController()

    activeTasks.set(sessionId, { sessionId, userId, abortController })

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

      // SDK reads ANTHROPIC_API_KEY from env
      process.env.ANTHROPIC_API_KEY = anthropicKey

      const systemPrompt = buildSystemPrompt(session.repoSource, availableRepos)

      const result = query({
        prompt: session.prompt,
        options: {
          cwd: workspaceDir,
          maxTurns: session.maxTurns,
          abortController,
          permissionMode: "acceptEdits",
          systemPrompt,
          env: {
            ...process.env,
            HOME: workspaceDir,
            GIT_CONFIG_GLOBAL: join(workspaceDir, ".gitconfig"),
          },
        },
      })

      for await (const message of result) {
        if (abortController.signal.aborted) break
        handleSdkMessage(message, sessionId, userId)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (!abortController.signal.aborted) {
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
    task.abortController.abort()
    return true
  }

  return {
    executeTask,
    cancelTask,
    getActiveCount: () => activeTasks.size,
  }
}

type TaskExecutor = ReturnType<typeof createTaskExecutor>

export { type TaskExecutor, createTaskExecutor }
