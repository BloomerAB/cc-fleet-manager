import { describe, it, expect, vi, beforeEach } from "vitest"
import { createTaskExecutor } from "./task-executor.js"
import type { Env } from "../env.js"
import type { SessionStore } from "./session-store.js"
import type { UserStore } from "./user-store.js"
import type { WsManager } from "./ws-manager.js"

// Mock the SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}))

// Mock fs and child_process
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
    cb(null)
  }),
}))

const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk")

const createMockEnv = (overrides?: Partial<Env>): Env => ({
  PORT: 3000,
  HOST: "0.0.0.0",
  SCYLLA_HOST: "scylla",
  SCYLLA_PORT: 9042,
  SCYLLA_DATACENTER: "datacenter1",
  SCYLLA_KEYSPACE: "claude_platform",
  JWT_SECRET: "test-secret",
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  GITHUB_SCOPES: "read:user,repo",
  ANTHROPIC_API_KEY: "sk-ant-test" as string | undefined,
  MAX_CONCURRENT_TASKS: 5,
  WORKSPACE_BASE_DIR: "/tmp/cc-fleet-workspaces",
  ALLOWED_REPOS: "",
  CORS_ORIGIN: "http://localhost:5173",
  ...overrides,
})

const createMockSessionStore = (): SessionStore => ({
  create: vi.fn(),
  findById: vi.fn(),
  findByIdUnsafe: vi.fn(),
  findByUser: vi.fn(),
  countByUser: vi.fn(),
  updateStatus: vi.fn().mockResolvedValue(undefined),
  addMessage: vi.fn().mockResolvedValue(undefined),
  getMessages: vi.fn(),
})

const createMockUserStore = (): UserStore => ({
  upsert: vi.fn(),
  findById: vi.fn(),
  getAccessToken: vi.fn().mockResolvedValue("gho_user_token"),
  getAnthropicApiKey: vi.fn().mockResolvedValue("sk-ant-user-key"),
  setAnthropicApiKey: vi.fn(),
})

const createMockWsManager = (): WsManager => ({
  registerDashboard: vi.fn(),
  emitToSession: vi.fn(),
})

// Helper to create an async generator from an array of messages
async function* asyncGenerator<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item
  }
}

describe("createTaskExecutor", () => {
  let env: Env
  let sessionStore: SessionStore
  let userStore: UserStore
  let wsManager: WsManager
  let executor: ReturnType<typeof createTaskExecutor>

  beforeEach(() => {
    vi.clearAllMocks()
    env = createMockEnv()
    sessionStore = createMockSessionStore()
    userStore = createMockUserStore()
    wsManager = createMockWsManager()
    executor = createTaskExecutor(env, sessionStore, userStore, wsManager)
  })

  describe("executeTask", () => {
    it("should throw when session not found", async () => {
      vi.mocked(sessionStore.findById).mockResolvedValueOnce(null)

      await expect(executor.executeTask("session-1", "user-1"))
        .rejects.toThrow("Session session-1 not found")
    })

    it("should throw when max concurrent tasks reached", async () => {
      const limitedEnv = createMockEnv({ MAX_CONCURRENT_TASKS: 0 })
      const limitedExecutor = createTaskExecutor(limitedEnv, sessionStore, userStore, wsManager)

      vi.mocked(sessionStore.findById).mockResolvedValueOnce({
        id: "session-1",
        userId: "user-1",
        status: "queued",
        prompt: "Fix bug",
        repos: [{ url: "https://github.com/org/repo" }],
        maxTurns: 50,
        maxBudgetUsd: 5.0,
        deadlineSeconds: 3600,
        result: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
      })

      await expect(limitedExecutor.executeTask("session-1", "user-1"))
        .rejects.toThrow("Maximum concurrent tasks reached")
    })

    it("should update status to running and execute SDK query", async () => {
      const session = {
        id: "session-1",
        userId: "user-1",
        status: "queued" as const,
        prompt: "Fix bug",
        repos: [{ url: "https://github.com/org/repo" }],
        maxTurns: 50,
        maxBudgetUsd: 5.0,
        deadlineSeconds: 3600,
        result: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
      }

      vi.mocked(sessionStore.findById).mockResolvedValueOnce(session)
      vi.mocked(mockQuery).mockReturnValueOnce(asyncGenerator([
        {
          type: "result",
          subtype: "success",
          result: "Task completed",
          total_cost_usd: 0.5,
          num_turns: 3,
          session_id: "sdk-session",
          is_error: false,
          duration_ms: 1000,
          duration_api_ms: 800,
        },
      ]))

      await executor.executeTask("session-1", "user-1")

      expect(sessionStore.updateStatus).toHaveBeenCalledWith("session-1", "running")
      expect(mockQuery).toHaveBeenCalledOnce()
      expect(wsManager.emitToSession).toHaveBeenCalledWith("session-1", "user-1", expect.objectContaining({
        type: "session_update",
        status: "running",
      }))
    })

    it("should handle assistant text messages from SDK", async () => {
      vi.mocked(sessionStore.findById).mockResolvedValueOnce({
        id: "session-1",
        userId: "user-1",
        status: "queued",
        prompt: "Fix bug",
        repos: [{ url: "https://github.com/org/repo" }],
        maxTurns: 50,
        maxBudgetUsd: 5.0,
        deadlineSeconds: 3600,
        result: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
      })

      vi.mocked(mockQuery).mockReturnValueOnce(asyncGenerator([
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "I found the bug" }],
          },
        },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          total_cost_usd: 0.1,
          num_turns: 1,
          session_id: "sdk-session",
          is_error: false,
          duration_ms: 500,
          duration_api_ms: 400,
        },
      ]))

      await executor.executeTask("session-1", "user-1")

      expect(wsManager.emitToSession).toHaveBeenCalledWith("session-1", "user-1", expect.objectContaining({
        type: "output",
        text: "I found the bug",
      }))
      expect(sessionStore.addMessage).toHaveBeenCalledWith("session-1", "assistant", "I found the bug")
    })

    it("should handle errors during execution", async () => {
      vi.mocked(sessionStore.findById).mockResolvedValueOnce({
        id: "session-1",
        userId: "user-1",
        status: "queued",
        prompt: "Fix bug",
        repos: [{ url: "https://github.com/org/repo" }],
        maxTurns: 50,
        maxBudgetUsd: 5.0,
        deadlineSeconds: 3600,
        result: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
      })

      vi.mocked(mockQuery).mockReturnValueOnce(asyncGenerator([]))
      vi.mocked(mockQuery).mockImplementationOnce(() => {
        throw new Error("SDK crash")
      })

      // Re-create with fresh mock that throws
      vi.mocked(sessionStore.findById).mockResolvedValueOnce({
        id: "session-2",
        userId: "user-1",
        status: "queued",
        prompt: "Fix bug",
        repos: [{ url: "https://github.com/org/repo" }],
        maxTurns: 50,
        maxBudgetUsd: 5.0,
        deadlineSeconds: 3600,
        result: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
      })

      // First execution succeeds (to clear the first mock)
      await executor.executeTask("session-1", "user-1")

      // Second execution should handle the error
      await executor.executeTask("session-2", "user-1")

      expect(sessionStore.updateStatus).toHaveBeenCalledWith("session-2", "failed", expect.objectContaining({
        result: expect.objectContaining({
          success: false,
          summary: expect.stringContaining("SDK crash"),
        }),
      }))
    })

    it("should use user access token for git clone", async () => {
      vi.mocked(sessionStore.findById).mockResolvedValueOnce({
        id: "session-1",
        userId: "user-1",
        status: "queued",
        prompt: "Fix bug",
        repos: [{ url: "https://github.com/org/repo" }],
        maxTurns: 50,
        maxBudgetUsd: 5.0,
        deadlineSeconds: 3600,
        result: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
      })

      vi.mocked(mockQuery).mockReturnValueOnce(asyncGenerator([
        {
          type: "result",
          subtype: "success",
          result: "Done",
          total_cost_usd: 0.1,
          num_turns: 1,
          session_id: "sdk-session",
          is_error: false,
          duration_ms: 500,
          duration_api_ms: 400,
        },
      ]))

      await executor.executeTask("session-1", "user-1")

      expect(userStore.getAccessToken).toHaveBeenCalledWith("user-1")
    })
  })

  describe("cancelTask", () => {
    it("should return false when task does not exist", () => {
      const result = executor.cancelTask("nonexistent")
      expect(result).toBe(false)
    })

    it("should return true and abort when task exists", async () => {
      vi.mocked(sessionStore.findById).mockResolvedValueOnce({
        id: "session-1",
        userId: "user-1",
        status: "queued",
        prompt: "Fix bug",
        repos: [{ url: "https://github.com/org/repo" }],
        maxTurns: 50,
        maxBudgetUsd: 5.0,
        deadlineSeconds: 3600,
        result: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
      })

      // Use a generator that waits so we can cancel mid-execution
      let aborted = false
      vi.mocked(mockQuery).mockReturnValueOnce((async function* () {
        await new Promise((resolve) => setTimeout(resolve, 50))
        if (!aborted) {
          yield {
            type: "result" as const,
            subtype: "success" as const,
            result: "Done",
            total_cost_usd: 0.1,
            num_turns: 1,
            session_id: "sdk-session",
            is_error: false,
            duration_ms: 500,
            duration_api_ms: 400,
          }
        }
      })() as never)

      // Start the task but don't await
      const taskPromise = executor.executeTask("session-1", "user-1")

      // Give it time to start
      await new Promise((resolve) => setTimeout(resolve, 10))

      const cancelled = executor.cancelTask("session-1")
      aborted = true
      expect(cancelled).toBe(true)

      await taskPromise
    })
  })

  describe("getActiveCount", () => {
    it("should return 0 when no tasks are running", () => {
      expect(executor.getActiveCount()).toBe(0)
    })
  })
})
