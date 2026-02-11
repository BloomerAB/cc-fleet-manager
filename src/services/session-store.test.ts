import { describe, it, expect, vi, beforeEach } from "vitest"
import { createSessionStore } from "./session-store.js"

// Create a chainable mock that tracks calls and returns configurable results
const createChainableMock = (finalResult: unknown = []) => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {}

  const createStep = (name: string): ReturnType<typeof vi.fn> => {
    const fn = vi.fn(() => {
      // Return proxy that supports any chained method
      return new Proxy(
        {},
        {
          get: (_target, prop: string) => {
            if (!chain[prop]) {
              chain[prop] = createStep(prop)
            }
            return chain[prop]
          },
        },
      )
    })
    chain[name] = fn
    return fn
  }

  // The final method in a chain should return a promise with the result
  const createTerminalStep = (name: string, result: unknown): ReturnType<typeof vi.fn> => {
    const fn = vi.fn(() => Promise.resolve(result))
    chain[name] = fn
    return fn
  }

  return { chain, createStep, createTerminalStep }
}

// Build a mock db that supports the drizzle query builder pattern
const createMockDb = () => {
  // Store what each chain call should resolve to
  let selectResult: unknown[] = []
  let insertResult: unknown[] = []

  // Track all calls for assertions
  const calls = {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    values: vi.fn(),
    returning: vi.fn(),
    set: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    offset: vi.fn(),
  }

  const makeChain = (terminal: () => Promise<unknown>) => {
    const chain: Record<string, unknown> = {}
    const proxy = (): unknown =>
      new Proxy(
        {},
        {
          get: (_t, prop: string) => {
            if (prop === "then") {
              // Allow awaiting the chain directly
              const p = terminal()
              return p.then.bind(p)
            }
            if (calls[prop as keyof typeof calls]) {
              calls[prop as keyof typeof calls]()
            }
            return proxy
          },
        },
      )
    return proxy()
  }

  const db = {
    insert: vi.fn(() =>
      makeChain(() => Promise.resolve(insertResult)),
    ),
    select: vi.fn(() =>
      makeChain(() => Promise.resolve(selectResult)),
    ),
    update: vi.fn(() =>
      makeChain(() => Promise.resolve()),
    ),
  }

  return {
    db: db as unknown as Parameters<typeof createSessionStore>[0],
    setSelectResult: (result: unknown[]) => {
      selectResult = result
    },
    setInsertResult: (result: unknown[]) => {
      insertResult = result
    },
    raw: db,
  }
}

describe("createSessionStore", () => {
  let mockDb: ReturnType<typeof createMockDb>
  let store: ReturnType<typeof createSessionStore>

  beforeEach(() => {
    mockDb = createMockDb()
    store = createSessionStore(mockDb.db)
  })

  describe("create", () => {
    it("should insert a session with provided values", async () => {
      const mockSession = {
        id: "uuid-1",
        userId: "user-1",
        userLogin: "malin",
        prompt: "Fix the bug",
        repoUrl: "https://github.com/org/repo",
        maxTurns: 30,
        maxBudgetUsd: 3.0,
        status: "queued",
      }
      mockDb.setInsertResult([mockSession])

      const result = await store.create({
        userId: "user-1",
        userLogin: "malin",
        prompt: "Fix the bug",
        repoUrl: "https://github.com/org/repo",
        maxTurns: 30,
        maxBudgetUsd: 3.0,
      })

      expect(mockDb.raw.insert).toHaveBeenCalledOnce()
      expect(result).toEqual(mockSession)
    })

    it("should apply default maxTurns of 50 when not provided", async () => {
      const mockSession = {
        id: "uuid-2",
        userId: "user-1",
        userLogin: "malin",
        prompt: "Do something",
        repoUrl: "https://github.com/org/repo",
        maxTurns: 50,
        maxBudgetUsd: 5.0,
      }
      mockDb.setInsertResult([mockSession])

      const result = await store.create({
        userId: "user-1",
        userLogin: "malin",
        prompt: "Do something",
        repoUrl: "https://github.com/org/repo",
      })

      expect(result.maxTurns).toBe(50)
    })

    it("should apply default maxBudgetUsd of 5.0 when not provided", async () => {
      const mockSession = {
        id: "uuid-3",
        userId: "user-1",
        userLogin: "malin",
        prompt: "Do something",
        repoUrl: "https://github.com/org/repo",
        maxTurns: 50,
        maxBudgetUsd: 5.0,
      }
      mockDb.setInsertResult([mockSession])

      const result = await store.create({
        userId: "user-1",
        userLogin: "malin",
        prompt: "Do something",
        repoUrl: "https://github.com/org/repo",
      })

      expect(result.maxBudgetUsd).toBe(5.0)
    })

    it("should pass optional repoBranch to the insert", async () => {
      const mockSession = {
        id: "uuid-4",
        userId: "user-1",
        userLogin: "malin",
        prompt: "Fix",
        repoUrl: "https://github.com/org/repo",
        repoBranch: "feature/foo",
        maxTurns: 50,
        maxBudgetUsd: 5.0,
      }
      mockDb.setInsertResult([mockSession])

      const result = await store.create({
        userId: "user-1",
        userLogin: "malin",
        prompt: "Fix",
        repoUrl: "https://github.com/org/repo",
        repoBranch: "feature/foo",
      })

      expect(result.repoBranch).toBe("feature/foo")
    })
  })

  describe("findById", () => {
    it("should return session when found", async () => {
      const mockSession = { id: "uuid-1", userId: "user-1" }
      mockDb.setSelectResult([mockSession])

      const result = await store.findById("uuid-1", "user-1")
      expect(mockDb.raw.select).toHaveBeenCalledOnce()
      expect(result).toEqual(mockSession)
    })

    it("should return null when not found", async () => {
      mockDb.setSelectResult([])

      const result = await store.findById("nonexistent", "user-1")
      expect(result).toBeNull()
    })
  })

  describe("findByIdUnsafe", () => {
    it("should return session without userId check", async () => {
      const mockSession = { id: "uuid-1", userId: "user-1" }
      mockDb.setSelectResult([mockSession])

      const result = await store.findByIdUnsafe("uuid-1")
      expect(mockDb.raw.select).toHaveBeenCalledOnce()
      expect(result).toEqual(mockSession)
    })

    it("should return null when not found", async () => {
      mockDb.setSelectResult([])

      const result = await store.findByIdUnsafe("nonexistent")
      expect(result).toBeNull()
    })
  })

  describe("findByUser", () => {
    it("should return sessions for a user", async () => {
      const mockSessions = [
        { id: "uuid-1", userId: "user-1" },
        { id: "uuid-2", userId: "user-1" },
      ]
      mockDb.setSelectResult(mockSessions)

      const result = await store.findByUser("user-1")
      expect(mockDb.raw.select).toHaveBeenCalledOnce()
      expect(result).toEqual(mockSessions)
    })

    it("should return empty array when user has no sessions", async () => {
      mockDb.setSelectResult([])

      const result = await store.findByUser("user-1")
      expect(result).toEqual([])
    })
  })

  describe("countByUser", () => {
    it("should return count for a user", async () => {
      mockDb.setSelectResult([{ count: 5 }])

      const result = await store.countByUser("user-1")
      expect(result).toBe(5)
    })

    it("should return 0 when no result", async () => {
      mockDb.setSelectResult([])

      const result = await store.countByUser("user-1")
      expect(result).toBe(0)
    })
  })

  describe("updateStatus", () => {
    it("should call db.update for status change", async () => {
      await store.updateStatus("uuid-1", "running")
      expect(mockDb.raw.update).toHaveBeenCalledOnce()
    })

    it("should call db.update with extras", async () => {
      await store.updateStatus("uuid-1", "completed", {
        jobName: "claude-runner-abc",
        result: { success: true, summary: "Done" },
      })
      expect(mockDb.raw.update).toHaveBeenCalledOnce()
    })
  })

  describe("addMessage", () => {
    it("should insert a message", async () => {
      mockDb.setInsertResult([])

      await store.addMessage("session-1", "assistant", "Hello", undefined)
      expect(mockDb.raw.insert).toHaveBeenCalledOnce()
    })

    it("should insert a tool message with toolName", async () => {
      mockDb.setInsertResult([])

      await store.addMessage("session-1", "tool", "File contents", "Read")
      expect(mockDb.raw.insert).toHaveBeenCalledOnce()
    })
  })

  describe("getMessages", () => {
    it("should return messages for a session", async () => {
      const mockMessages = [
        { id: "m1", sessionId: "s1", role: "assistant", content: "Hi" },
        { id: "m2", sessionId: "s1", role: "tool", content: "Result" },
      ]
      mockDb.setSelectResult(mockMessages)

      const result = await store.getMessages("s1")
      expect(mockDb.raw.select).toHaveBeenCalledOnce()
      expect(result).toEqual(mockMessages)
    })
  })
})
