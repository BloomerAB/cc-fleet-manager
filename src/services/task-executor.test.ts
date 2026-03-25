import { describe, it, expect, vi, beforeEach } from "vitest"
import { createTaskExecutor } from "./task-executor.js"
import type { Env } from "../env.js"
import type { SessionStore } from "./session-store.js"
import type { UserStore } from "./user-store.js"
import type { WsManager } from "./ws-manager.js"
import { EventEmitter, Readable } from "node:stream"

// Mock child_process spawn
const mockSpawn = vi.fn()
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
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
})

const createMockWsManager = (): WsManager => ({
  registerDashboard: vi.fn(),
  emitToSession: vi.fn(),
})

// Helper to create a mock child process
const createMockProcess = () => {
  const stdout = new Readable({ read() {} })
  const stderr = new Readable({ read() {} })
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable
    stderr: Readable
    kill: ReturnType<typeof vi.fn>
    exitCode: number | null
    pid: number
  }
  proc.stdout = stdout
  proc.stderr = stderr
  proc.kill = vi.fn()
  proc.exitCode = null
  proc.pid = 12345
  return proc
}

// Helper to emit lines on stdout and close process
const emitLinesAndClose = (proc: ReturnType<typeof createMockProcess>, lines: string[], exitCode = 0) => {
  setTimeout(() => {
    for (const line of lines) {
      proc.stdout.push(line + "\n")
    }
    proc.stdout.push(null) // EOF
    proc.exitCode = exitCode
    proc.emit("close", exitCode)
  }, 5)
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

    it("should spawn claude CLI and process output", async () => {
      vi.mocked(sessionStore.findById).mockResolvedValueOnce(baseSession)

      const proc = createMockProcess()
      mockSpawn.mockReturnValueOnce(proc)

      emitLinesAndClose(proc, [
        JSON.stringify({ type: "system", subtype: "init", session_id: "cli-sess-1" }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "I found the bug" }] },
          session_id: "cli-sess-1",
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Task completed",
          session_id: "cli-sess-1",
          total_cost_usd: 0.5,
          num_turns: 3,
          duration_ms: 1000,
        }),
      ])

      await executor.executeTask("session-1", "user-1")

      // Should have spawned claude
      expect(mockSpawn).toHaveBeenCalledOnce()
      const spawnArgs = mockSpawn.mock.calls[0]
      expect(spawnArgs[0]).toBe("claude")

      // Check CLI args include key flags
      const cliArgs = spawnArgs[1] as string[]
      expect(cliArgs).toContain("-p")
      expect(cliArgs).toContain("--output-format")
      expect(cliArgs).toContain("stream-json")
      expect(cliArgs).toContain("--bare")
      expect(cliArgs).toContain("--permission-mode")
      expect(cliArgs).toContain("acceptEdits")

      // Should have emitted output
      expect(wsManager.emitToSession).toHaveBeenCalledWith("session-1", "user-1", expect.objectContaining({
        type: "output",
        text: "I found the bug",
      }))

      // Should have updated status to completed
      expect(sessionStore.updateStatus).toHaveBeenCalledWith("session-1", "completed", expect.objectContaining({
        result: expect.objectContaining({ success: true }),
      }))
    })

    it("should pass bypassPermissions as --dangerously-skip-permissions", async () => {
      vi.mocked(sessionStore.findById).mockResolvedValueOnce({
        ...baseSession,
        permissionMode: "bypassPermissions",
      })

      const proc = createMockProcess()
      mockSpawn.mockReturnValueOnce(proc)
      emitLinesAndClose(proc, [
        JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done", session_id: "s1", total_cost_usd: 0, num_turns: 1, duration_ms: 10 }),
      ])

      await executor.executeTask("session-1", "user-1")

      const cliArgs = mockSpawn.mock.calls[0][1] as string[]
      expect(cliArgs).toContain("--dangerously-skip-permissions")
      expect(cliArgs).not.toContain("--permission-mode")
    })

    it("should set ANTHROPIC_API_KEY in apiKey mode", async () => {
      vi.mocked(sessionStore.findById).mockResolvedValueOnce(baseSession)

      const proc = createMockProcess()
      mockSpawn.mockReturnValueOnce(proc)
      emitLinesAndClose(proc, [
        JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done", session_id: "s1", total_cost_usd: 0, num_turns: 1, duration_ms: 10 }),
      ])

      await executor.executeTask("session-1", "user-1")

      const spawnOpts = mockSpawn.mock.calls[0][2] as { env: Record<string, string> }
      expect(spawnOpts.env.ANTHROPIC_API_KEY).toBe("sk-ant-user-key")
    })

    it("should not set ANTHROPIC_API_KEY in subscription mode", async () => {
      const subEnv = createMockEnv({ AUTH_MODE: "subscription" as const })
      const subExecutor = createTaskExecutor(subEnv, sessionStore, userStore, wsManager)

      vi.mocked(sessionStore.findById).mockResolvedValueOnce(baseSession)

      const proc = createMockProcess()
      mockSpawn.mockReturnValueOnce(proc)
      emitLinesAndClose(proc, [
        JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done", session_id: "s1", total_cost_usd: 0, num_turns: 1, duration_ms: 10 }),
      ])

      await subExecutor.executeTask("session-1", "user-1")

      const spawnOpts = mockSpawn.mock.calls[0][2] as { env: Record<string, string> }
      expect(spawnOpts.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(spawnOpts.env.HOME).toBe("/home/appuser")
    })

    it("should handle process exit without result event", async () => {
      vi.mocked(sessionStore.findById).mockResolvedValueOnce(baseSession)

      const proc = createMockProcess()
      mockSpawn.mockReturnValueOnce(proc)

      // Exit with no result event
      setTimeout(() => {
        proc.stderr.push("Something went wrong\n")
        proc.stdout.push(null)
        proc.stderr.push(null)
        proc.exitCode = 1
        proc.emit("close", 1)
      }, 5)

      await executor.executeTask("session-1", "user-1")

      expect(sessionStore.updateStatus).toHaveBeenCalledWith("session-1", "failed", expect.objectContaining({
        result: expect.objectContaining({
          success: false,
          summary: expect.stringContaining("Something went wrong"),
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
})
