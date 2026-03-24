import { describe, it, expect, vi, beforeEach } from "vitest"
import { types as cassandraTypes } from "cassandra-driver"
import { createSessionStore } from "./session-store.js"

const createMockClient = () => {
  const execute = vi.fn()
  return {
    client: { execute } as unknown as Parameters<typeof createSessionStore>[0],
    execute,
  }
}

const createMockRow = (data: Record<string, unknown>) => ({
  ...data,
  get: (key: string) => data[key],
})

describe("createSessionStore", () => {
  let mock: ReturnType<typeof createMockClient>
  let store: ReturnType<typeof createSessionStore>

  beforeEach(() => {
    mock = createMockClient()
    store = createSessionStore(mock.client)
  })

  describe("create", () => {
    it("should insert a session with provided values", async () => {
      mock.execute.mockResolvedValueOnce({})

      const result = await store.create({
        userId: "user-1",
        prompt: "Fix the bug",
        repoSource: { mode: "direct" as const, repos: [{ url: "https://github.com/org/repo" }] },
        maxTurns: 30,
        maxBudgetUsd: 3.0,
      })

      expect(mock.execute).toHaveBeenCalledOnce()
      expect(result.userId).toBe("user-1")
      expect(result.prompt).toBe("Fix the bug")
      expect(result.repos).toEqual([{ url: "https://github.com/org/repo" }])
      expect(result.repoSource).toEqual({ mode: "direct", repos: [{ url: "https://github.com/org/repo" }] })
      expect(result.maxTurns).toBe(30)
      expect(result.maxBudgetUsd).toBe(3.0)
      expect(result.status).toBe("queued")
      expect(result.id).toBeDefined()
    })

    it("should support multiple repos in direct mode", async () => {
      mock.execute.mockResolvedValueOnce({})

      const repos = [
        { url: "https://github.com/org/repo1", branch: "main" },
        { url: "https://github.com/org/repo2", branch: "develop" },
      ]

      const result = await store.create({
        userId: "user-1",
        prompt: "Fix across repos",
        repoSource: { mode: "direct" as const, repos },
      })

      expect(result.repos).toEqual(repos)
      // Verify repos are JSON-serialized in the CQL params
      const params = mock.execute.mock.calls[0][1]
      expect(params).toContain(JSON.stringify(repos))
    })

    it("should apply default maxTurns of 200 when not provided", async () => {
      mock.execute.mockResolvedValueOnce({})

      const result = await store.create({
        userId: "user-1",
        prompt: "Do something",
        repoSource: { mode: "direct" as const, repos: [{ url: "https://github.com/org/repo" }] },
      })

      expect(result.maxTurns).toBe(200)
    })

    it("should apply default maxBudgetUsd of 5.0 when not provided", async () => {
      mock.execute.mockResolvedValueOnce({})

      const result = await store.create({
        userId: "user-1",
        prompt: "Do something",
        repoSource: { mode: "direct" as const, repos: [{ url: "https://github.com/org/repo" }] },
      })

      expect(result.maxBudgetUsd).toBe(5.0)
    })

    it("should support repo with branch", async () => {
      mock.execute.mockResolvedValueOnce({})

      const result = await store.create({
        userId: "user-1",
        prompt: "Fix",
        repoSource: { mode: "direct" as const, repos: [{ url: "https://github.com/org/repo", branch: "feature/foo" }] },
      })

      expect(result.repos[0].branch).toBe("feature/foo")
    })

    it("should set result to null initially", async () => {
      mock.execute.mockResolvedValueOnce({})

      const result = await store.create({
        userId: "user-1",
        prompt: "Fix",
        repoSource: { mode: "direct" as const, repos: [{ url: "https://github.com/org/repo" }] },
      })

      expect(result.result).toBeNull()
      expect(result.startedAt).toBeNull()
      expect(result.completedAt).toBeNull()
    })
  })

  describe("findById", () => {
    it("should return session when found", async () => {
      const uuid = cassandraTypes.Uuid.random()
      mock.execute.mockResolvedValueOnce({
        first: () => createMockRow({
          id: uuid,
          user_id: "user-1",
          status: "running",
          prompt: "Fix bug",
          repo_source: JSON.stringify({ mode: "direct", repos: [{ url: "https://github.com/org/repo" }] }),
          repos: JSON.stringify([{ url: "https://github.com/org/repo" }]),
          max_turns: 50,
          max_budget_usd: 5.0,
          deadline_seconds: 3600,
          result: null,
          created_at: new Date(),
          updated_at: new Date(),
          started_at: new Date(),
          completed_at: null,
        }),
      })

      const result = await store.findById(uuid.toString(), "user-1")
      expect(result).not.toBeNull()
      expect(result!.id).toBe(uuid.toString())
      expect(result!.userId).toBe("user-1")
      expect(result!.status).toBe("running")
      expect(result!.repos).toEqual([{ url: "https://github.com/org/repo" }])
      expect(result!.repoSource.mode).toBe("direct")
    })

    it("should return null when not found", async () => {
      mock.execute.mockResolvedValueOnce({ first: () => null })

      const result = await store.findById("00000000-0000-0000-0000-000000000000", "user-1")
      expect(result).toBeNull()
    })
  })

  describe("findByIdUnsafe", () => {
    it("should return session without userId check", async () => {
      const uuid = cassandraTypes.Uuid.random()
      mock.execute.mockResolvedValueOnce({
        first: () => createMockRow({
          id: uuid,
          user_id: "user-1",
          status: "queued",
          prompt: "Fix",
          repos: JSON.stringify([{ url: "https://github.com/org/repo" }]),
          max_turns: 50,
          max_budget_usd: 5.0,
          deadline_seconds: 3600,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      })

      const result = await store.findByIdUnsafe(uuid.toString())
      expect(result).not.toBeNull()
      // Query should NOT contain user_id filter
      const query = mock.execute.mock.calls[0][0]
      expect(query).not.toContain("user_id")
    })

    it("should return null when not found", async () => {
      mock.execute.mockResolvedValueOnce({ first: () => null })

      const result = await store.findByIdUnsafe("00000000-0000-0000-0000-000000000000")
      expect(result).toBeNull()
    })
  })

  describe("findByUser", () => {
    it("should return sessions for a user", async () => {
      const uuid1 = cassandraTypes.Uuid.random()
      const uuid2 = cassandraTypes.Uuid.random()
      const now = new Date()
      mock.execute.mockResolvedValueOnce({
        rows: [
          createMockRow({
            id: uuid1, user_id: "user-1", status: "running",
            prompt: "Fix 1", repos: JSON.stringify([{ url: "https://github.com/org/repo" }]),
            max_turns: 50, max_budget_usd: 5.0, deadline_seconds: 3600,
            created_at: now, updated_at: now,
          }),
          createMockRow({
            id: uuid2, user_id: "user-1", status: "completed",
            prompt: "Fix 2", repos: JSON.stringify([{ url: "https://github.com/org/repo" }]),
            max_turns: 50, max_budget_usd: 5.0, deadline_seconds: 3600,
            created_at: now, updated_at: now,
          }),
        ],
      })

      const result = await store.findByUser("user-1")
      expect(result).toHaveLength(2)
    })

    it("should return empty array when user has no sessions", async () => {
      mock.execute.mockResolvedValueOnce({ rows: [] })

      const result = await store.findByUser("user-1")
      expect(result).toEqual([])
    })
  })

  describe("countByUser", () => {
    it("should return count for a user", async () => {
      mock.execute.mockResolvedValueOnce({
        first: () => ({ count: 5 }),
      })

      const result = await store.countByUser("user-1")
      expect(result).toBe(5)
    })

    it("should return 0 when no result", async () => {
      mock.execute.mockResolvedValueOnce({ first: () => null })

      const result = await store.countByUser("user-1")
      expect(result).toBe(0)
    })
  })

  describe("updateStatus", () => {
    it("should look up session then update", async () => {
      const uuid = cassandraTypes.Uuid.random()
      // First call: lookup session by id
      mock.execute.mockResolvedValueOnce({
        first: () => ({ user_id: "user-1", created_at: new Date() }),
      })
      // Second call: update
      mock.execute.mockResolvedValueOnce({})

      await store.updateStatus(uuid.toString(), "running")

      expect(mock.execute).toHaveBeenCalledTimes(2)
      const updateQuery = mock.execute.mock.calls[1][0]
      expect(updateQuery).toContain("UPDATE sessions SET")
      expect(updateQuery).toContain("status = ?")
    })

    it("should not update if session not found", async () => {
      mock.execute.mockResolvedValueOnce({ first: () => null })

      await store.updateStatus("00000000-0000-0000-0000-000000000000", "running")

      expect(mock.execute).toHaveBeenCalledTimes(1) // Only the lookup
    })

    it("should include result in update when provided", async () => {
      const uuid = cassandraTypes.Uuid.random()
      mock.execute.mockResolvedValueOnce({
        first: () => ({ user_id: "user-1", created_at: new Date() }),
      })
      mock.execute.mockResolvedValueOnce({})

      await store.updateStatus(uuid.toString(), "completed", {
        result: { success: true, summary: "Done" },
      })

      const updateQuery = mock.execute.mock.calls[1][0]
      expect(updateQuery).toContain("result = ?")
      expect(updateQuery).toContain("completed_at = ?")
    })

    it("should add started_at when status is running", async () => {
      const uuid = cassandraTypes.Uuid.random()
      mock.execute.mockResolvedValueOnce({
        first: () => ({ user_id: "user-1", created_at: new Date() }),
      })
      mock.execute.mockResolvedValueOnce({})

      await store.updateStatus(uuid.toString(), "running")

      const updateQuery = mock.execute.mock.calls[1][0]
      expect(updateQuery).toContain("started_at = ?")
    })

    it("should add completed_at when status is failed", async () => {
      const uuid = cassandraTypes.Uuid.random()
      mock.execute.mockResolvedValueOnce({
        first: () => ({ user_id: "user-1", created_at: new Date() }),
      })
      mock.execute.mockResolvedValueOnce({})

      await store.updateStatus(uuid.toString(), "failed")

      const updateQuery = mock.execute.mock.calls[1][0]
      expect(updateQuery).toContain("completed_at = ?")
    })
  })

  describe("addMessage", () => {
    it("should insert a message", async () => {
      mock.execute.mockResolvedValueOnce({})

      await store.addMessage("00000000-0000-0000-0000-000000000000", "assistant", "Hello")

      expect(mock.execute).toHaveBeenCalledOnce()
      const query = mock.execute.mock.calls[0][0]
      expect(query).toContain("INSERT INTO session_messages")
    })

    it("should insert a tool message with toolName", async () => {
      mock.execute.mockResolvedValueOnce({})

      await store.addMessage("00000000-0000-0000-0000-000000000000", "tool", "File contents", "Read")

      const params = mock.execute.mock.calls[0][1]
      expect(params).toContain("Read")
    })
  })

  describe("getMessages", () => {
    it("should return messages for a session", async () => {
      const sessionUuid = cassandraTypes.Uuid.random()
      const msgUuid1 = cassandraTypes.Uuid.random()
      const msgUuid2 = cassandraTypes.Uuid.random()
      const now = new Date()

      mock.execute.mockResolvedValueOnce({
        rows: [
          createMockRow({
            id: msgUuid1, session_id: sessionUuid, role: "assistant",
            content: "Hi", tool_name: null, created_at: now,
          }),
          createMockRow({
            id: msgUuid2, session_id: sessionUuid, role: "tool",
            content: "Result", tool_name: "Read", created_at: now,
          }),
        ],
      })

      const result = await store.getMessages(sessionUuid.toString())
      expect(result).toHaveLength(2)
      expect(result[0].role).toBe("assistant")
      expect(result[1].toolName).toBe("Read")
    })
  })
})
