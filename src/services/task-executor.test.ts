import { describe, it, expect, vi, beforeEach } from "vitest"
import { createTaskExecutor } from "./task-executor.js"
import type { Env } from "../env.js"
import type { SessionStore } from "./session-store.js"
import type { UserStore } from "./user-store.js"
import type { WsManager } from "./ws-manager.js"

// Mock the SDK query function
const mockQuery = vi.fn()
const mockClose = vi.fn()
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

// Mock child_process (for git clone)
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
    cb(null)
  }),
}))

// Mock fs
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}))

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
  AUTH_MODE: "apiKey" as const,
  ...overrides,
})

const createMockSessionStore = (): SessionStore => ({
  create: vi.fn(),
  findById: vi.fn(),
  findByIdUnsafe: vi.fn(),
  findByUser: vi.fn(),
  countByUser: vi.fn(),
  updateStatus: vi.fn().mockResolvedValue(undefined),
  updateCliSessionId: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn(),
  addMessage: vi.fn().mockResolvedValue(undefined),
  getMessages: vi.fn(),
})

const createMockUserStore = (): UserStore => ({
  upsert: vi.fn(),
  findById: vi.fn(),
  getAccessToken: vi.fn().mockResolvedValue("gho_user_token"),
  getAnthropicApiKey: vi.fn().mockResolvedValue("sk-ant-user-key"),
  setAnthropicApiKey: vi.fn(),
  getRules: vi.fn().mockResolvedValue(null),
  setRules: vi.fn(),
  getClaudeSettings: vi.fn().mockResolvedValue(null),
  setClaudeSettings: vi.fn(),
})

const createMockWsManager = (): WsManager => ({
  registerDashboard: vi.fn(),
  emitToSession: vi.fn(),
})

/** Helper: create a mock query that yields SDK messages then returns */
const createMockQueryIterator = (messages: unknown[]) => {
  const iterator = {
    [Symbol.asyncIterator]: () => {
      let index = 0
      return {
        next: async () => {
          if (index < messages.length) {
            return { value: messages[index++], done: false }
          }
          return { value: undefined, done: true }
        },
      }
    },
    close: mockClose,
    interrupt: vi.fn(),
    setPermissionMode: vi.fn(),
    setModel: vi.fn(),
    setMaxThinkingTokens: vi.fn(),
    applyFlagSettings: vi.fn(),
    initializationResult: vi.fn(),
    supportedCommands: vi.fn(),
    supportedModels: vi.fn(),
    supportedAgents: vi.fn(),
    mcpServerStatus: vi.fn(),
    accountInfo: vi.fn(),
    rewindFiles: vi.fn(),
    seedReadState: vi.fn(),
    reconnectMcpServer: vi.fn(),
    toggleMcpServer: vi.fn(),
    setMcpServers: vi.fn(),
    streamInput: vi.fn(),
    stopTask: vi.fn(),
    next: vi.fn(),
    return: vi.fn(),
    throw: vi.fn(),
  }
  return iterator
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

  const baseSession = {
    id: "session-1",
    userId: "user-1",
    status: "queued" as const,
    prompt: "Fix bug",
    repoSource: { mode: "direct" as const, repos: [{ url: "https://github.com/org/repo" }] },
    repos: [{ url: "https://github.com/org/repo" }],
    rules: null,
    permissionMode: "acceptEdits" as const,
    model: "sonnet" as const,
    cliSessionId: null,
    maxTurns: 50,
    maxBudgetUsd: 5.0,
    deadlineSeconds: 3600,
    result: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: null,
    completedAt: null,
  }

  describe("executeTask", () => {
    it("should throw when session not found", async () => {
      vi.mocked(sessionStore.findById).mockResolvedValueOnce(null)

      await expect(executor.executeTask("session-1", "user-1"))
        .rejects.toThrow("Session session-1 not found")
    })

    it("should throw when max concurrent tasks reached", async () => {
      const limitedEnv = createMockEnv({ MAX_CONCURRENT_TASKS: 0 })
      const limitedExecutor = createTaskExecutor(limitedEnv, sessionStore, userStore, wsManager)

      vi.mocked(sessionStore.findById).mockResolvedValueOnce(baseSession)

      await expect(limitedExecutor.executeTask("session-1", "user-1"))
        .rejects.toThrow("Maximum concurrent tasks reached")
    })

    it("should create SDK query and process assistant messages", async () => {
      vi.mocked(sessionStore.findById).mockResolvedValueOnce(baseSession)

      const mockIter = createMockQueryIterator([
        {
          type: "system",
          subtype: "init",
          session_id: "cli-sess-1",
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "I found the bug" }] },
          session_id: "cli-sess-1",
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Task completed",
          session_id: "cli-sess-1",
          total_cost_usd: 0.5,
          num_turns: 3,
          duration_ms: 1000,
        },
      ])
      mockQuery.mockReturnValueOnce(mockIter)

      await executor.executeTask("session-1", "user-1")

      // Should have called SDK query
      expect(mockQuery).toHaveBeenCalledOnce()
      const params = mockQuery.mock.calls[0][0]
      expect(params.prompt).toBe("Fix bug")
      expect(params.options.permissionMode).toBe("acceptEdits")
      expect(params.options.model).toBe("claude-sonnet-4-6")
      expect(params.options.cwd).toContain("session-1")

      // Should have emitted output
      expect(wsManager.emitToSession).toHaveBeenCalledWith("session-1", "user-1", expect.objectContaining({
        type: "output",
        text: "I found the bug",
      }))

      // Should be waiting_for_input (interactive mode)
      expect(sessionStore.updateStatus).toHaveBeenCalledWith("session-1", "waiting_for_input")
    })

    it("should use opus model when specified", async () => {
      vi.mocked(sessionStore.findById).mockResolvedValueOnce({
        ...baseSession,
        model: "opus",
      })

      const mockIter = createMockQueryIterator([
        { type: "result", subtype: "success", session_id: "s1", total_cost_usd: 0, num_turns: 1 },
      ])
      mockQuery.mockReturnValueOnce(mockIter)

      await executor.executeTask("session-1", "user-1")

      const params = mockQuery.mock.calls[0][0]
      expect(params.options.model).toBe("claude-opus-4-6")
    })

    it("should pass bypassPermissions to SDK", async () => {
      vi.mocked(sessionStore.findById).mockResolvedValueOnce({
        ...baseSession,
        permissionMode: "bypassPermissions",
      })

      const mockIter = createMockQueryIterator([
        { type: "result", subtype: "success", session_id: "s1", total_cost_usd: 0, num_turns: 1 },
      ])
      mockQuery.mockReturnValueOnce(mockIter)

      await executor.executeTask("session-1", "user-1")

      const params = mockQuery.mock.calls[0][0]
      expect(params.options.permissionMode).toBe("bypassPermissions")
    })

    it("should set ANTHROPIC_API_KEY in apiKey mode", async () => {
      vi.mocked(sessionStore.findById).mockResolvedValueOnce(baseSession)

      const mockIter = createMockQueryIterator([
        { type: "result", subtype: "success", session_id: "s1", total_cost_usd: 0, num_turns: 1 },
      ])
      mockQuery.mockReturnValueOnce(mockIter)

      await executor.executeTask("session-1", "user-1")

      const params = mockQuery.mock.calls[0][0]
      expect(params.options.env.ANTHROPIC_API_KEY).toBe("sk-ant-user-key")
    })

    it("should handle SDK errors gracefully", async () => {
      vi.mocked(sessionStore.findById).mockResolvedValueOnce(baseSession)

      mockQuery.mockImplementationOnce(() => {
        throw new Error("SDK initialization failed")
      })

      await executor.executeTask("session-1", "user-1")

      expect(sessionStore.updateStatus).toHaveBeenCalledWith("session-1", "failed", expect.objectContaining({
        result: expect.objectContaining({
          success: false,
          summary: expect.stringContaining("SDK initialization failed"),
        }),
      }))
    })
  })

  describe("cancelTask", () => {
    it("should return false when task does not exist", () => {
      expect(executor.cancelTask("nonexistent")).toBe(false)
    })
  })

  describe("getActiveCount", () => {
    it("should return 0 when no tasks are running", () => {
      expect(executor.getActiveCount()).toBe(0)
    })
  })

  describe("endSession", () => {
    it("should handle ending a non-existent session gracefully", async () => {
      await executor.endSession("nonexistent", "user-1")

      expect(sessionStore.updateStatus).toHaveBeenCalledWith("nonexistent", "completed", expect.objectContaining({
        result: expect.objectContaining({ success: true }),
      }))
    })
  })
})
