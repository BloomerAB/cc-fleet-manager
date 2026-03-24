import { execFile } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Env } from "../env.js"
import type { SessionStore, RepoConfig } from "./session-store.js"
import type { UserStore } from "./user-store.js"
import type { WsManager } from "./ws-manager.js"

const execFileAsync = promisify(execFile)

interface ActiveTask {
  readonly sessionId: string
  readonly userId: string
  readonly abortController: AbortController
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
      await cloneRepos(session.repos, workspaceDir, gitToken)

      // SDK reads ANTHROPIC_API_KEY from env
      process.env.ANTHROPIC_API_KEY = anthropicKey

      const result = query({
        prompt: session.prompt,
        options: {
          cwd: workspaceDir,
          maxTurns: session.maxTurns,
          abortController,
          permissionMode: "acceptEdits",
          systemPrompt:
            "You are running as an autonomous agent. Complete the task and create a PR if code changes are made.",
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
