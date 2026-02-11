import { describe, it, expect, vi, beforeEach } from "vitest"
import { createWsManager, parseRunnerMessage, parseDashboardMessage } from "./ws-manager.js"

// Minimal WebSocket mock that satisfies the ws.WebSocket interface used in the code
const createMockWs = (readyState = 1) => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  return {
    readyState,
    OPEN: 1,
    send: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const existing = listeners.get(event) ?? []
      existing.push(handler)
      listeners.set(event, existing)
    }),
    emit: (event: string, ...args: unknown[]) => {
      const handlers = listeners.get(event) ?? []
      handlers.forEach((h) => h(...args))
    },
  }
}

describe("createWsManager", () => {
  let manager: ReturnType<typeof createWsManager>

  beforeEach(() => {
    manager = createWsManager()
  })

  describe("registerRunner", () => {
    it("should register a runner connection by sessionId", () => {
      const ws = createMockWs()
      manager.registerRunner("session-1", ws as never)

      expect(manager.isRunnerConnected("session-1")).toBe(true)
    })

    it("should unregister runner on ws close", () => {
      const ws = createMockWs()
      manager.registerRunner("session-1", ws as never)

      expect(manager.isRunnerConnected("session-1")).toBe(true)

      // Simulate close
      ws.emit("close")
      expect(manager.isRunnerConnected("session-1")).toBe(false)
    })

    it("should overwrite a runner with the same sessionId", () => {
      const ws1 = createMockWs()
      const ws2 = createMockWs()
      manager.registerRunner("session-1", ws1 as never)
      manager.registerRunner("session-1", ws2 as never)

      manager.sendToRunner("session-1", { type: "cancel" })
      expect(ws2.send).toHaveBeenCalledOnce()
      expect(ws1.send).not.toHaveBeenCalled()
    })
  })

  describe("registerDashboard", () => {
    it("should register a dashboard connection and return the connection", () => {
      const ws = createMockWs()
      const conn = manager.registerDashboard("user-1", ws as never)

      expect(conn.userId).toBe("user-1")
      expect(conn.ws).toBe(ws)
      expect(conn.subscribedSessions.size).toBe(0)
    })

    it("should remove dashboard on ws close", () => {
      const ws = createMockWs()
      manager.registerDashboard("user-1", ws as never)

      // Before close, broadcast should reach it
      manager.broadcastToDashboards("s1", "user-1", {
        type: "session_update",
        sessionId: "s1",
        status: "running",
      })
      expect(ws.send).toHaveBeenCalledOnce()

      ws.send.mockClear()
      ws.emit("close")

      // After close, broadcast should not reach it
      manager.broadcastToDashboards("s1", "user-1", {
        type: "session_update",
        sessionId: "s1",
        status: "completed",
      })
      expect(ws.send).not.toHaveBeenCalled()
    })
  })

  describe("sendToRunner", () => {
    it("should send JSON message to the runner's ws", () => {
      const ws = createMockWs()
      manager.registerRunner("session-1", ws as never)

      manager.sendToRunner("session-1", { type: "cancel" })
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "cancel" }))
    })

    it("should not send if runner ws is not OPEN", () => {
      const ws = createMockWs(3) // CLOSED
      manager.registerRunner("session-1", ws as never)

      manager.sendToRunner("session-1", { type: "cancel" })
      expect(ws.send).not.toHaveBeenCalled()
    })

    it("should no-op if runner does not exist", () => {
      // Should not throw
      manager.sendToRunner("nonexistent", { type: "cancel" })
    })

    it("should send answer message to runner", () => {
      const ws = createMockWs()
      manager.registerRunner("session-1", ws as never)

      const msg = { type: "answer" as const, answers: { q1: "yes" } }
      manager.sendToRunner("session-1", msg)
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg))
    })
  })

  describe("broadcastToDashboards", () => {
    it("should broadcast to all dashboards matching userId", () => {
      const ws1 = createMockWs()
      const ws2 = createMockWs()
      manager.registerDashboard("user-1", ws1 as never)
      manager.registerDashboard("user-1", ws2 as never)

      const msg = { type: "session_update" as const, sessionId: "s1", status: "running" as const }
      manager.broadcastToDashboards("s1", "user-1", msg)

      expect(ws1.send).toHaveBeenCalledWith(JSON.stringify(msg))
      expect(ws2.send).toHaveBeenCalledWith(JSON.stringify(msg))
    })

    it("should not broadcast to dashboards of different userId", () => {
      const ws1 = createMockWs()
      const ws2 = createMockWs()
      manager.registerDashboard("user-1", ws1 as never)
      manager.registerDashboard("user-2", ws2 as never)

      manager.broadcastToDashboards("s1", "user-1", {
        type: "session_update",
        sessionId: "s1",
        status: "running",
      })

      expect(ws1.send).toHaveBeenCalledOnce()
      expect(ws2.send).not.toHaveBeenCalled()
    })

    it("should filter by subscribedSessions when non-empty", () => {
      const ws = createMockWs()
      const conn = manager.registerDashboard("user-1", ws as never)
      conn.subscribedSessions.add("s1")

      // Message for s1 should arrive
      manager.broadcastToDashboards("s1", "user-1", {
        type: "session_update",
        sessionId: "s1",
        status: "running",
      })
      expect(ws.send).toHaveBeenCalledOnce()

      ws.send.mockClear()

      // Message for s2 should not arrive (not subscribed)
      manager.broadcastToDashboards("s2", "user-1", {
        type: "session_update",
        sessionId: "s2",
        status: "running",
      })
      expect(ws.send).not.toHaveBeenCalled()
    })

    it("should broadcast all sessions when subscribedSessions is empty", () => {
      const ws = createMockWs()
      manager.registerDashboard("user-1", ws as never)

      manager.broadcastToDashboards("any-session", "user-1", {
        type: "session_update",
        sessionId: "any-session",
        status: "running",
      })
      expect(ws.send).toHaveBeenCalledOnce()
    })

    it("should skip dashboards with closed ws", () => {
      const ws = createMockWs(3) // CLOSED
      manager.registerDashboard("user-1", ws as never)

      manager.broadcastToDashboards("s1", "user-1", {
        type: "session_update",
        sessionId: "s1",
        status: "running",
      })
      expect(ws.send).not.toHaveBeenCalled()
    })
  })

  describe("getRunnerConnection", () => {
    it("should return the runner connection for a sessionId", () => {
      const ws = createMockWs()
      manager.registerRunner("session-1", ws as never)

      const conn = manager.getRunnerConnection("session-1")
      expect(conn).not.toBeNull()
      expect(conn?.sessionId).toBe("session-1")
      expect(conn?.ws).toBe(ws)
    })

    it("should return null for unknown sessionId", () => {
      const conn = manager.getRunnerConnection("nonexistent")
      expect(conn).toBeNull()
    })
  })

  describe("isRunnerConnected", () => {
    it("should return true when runner exists and ws is OPEN", () => {
      const ws = createMockWs(1) // OPEN
      manager.registerRunner("session-1", ws as never)
      expect(manager.isRunnerConnected("session-1")).toBe(true)
    })

    it("should return false when runner exists but ws is not OPEN", () => {
      const ws = createMockWs(3) // CLOSED
      manager.registerRunner("session-1", ws as never)
      expect(manager.isRunnerConnected("session-1")).toBe(false)
    })

    it("should return false when runner does not exist", () => {
      expect(manager.isRunnerConnected("nonexistent")).toBe(false)
    })
  })
})

describe("parseRunnerMessage", () => {
  it("should parse a valid sdk_message", () => {
    const raw = JSON.stringify({
      type: "sdk_message",
      message: {
        role: "assistant",
        content: "Hello world",
        timestamp: "2026-01-01T00:00:00Z",
      },
    })
    const result = parseRunnerMessage(raw)
    expect(result.type).toBe("sdk_message")
    if (result.type === "sdk_message") {
      expect(result.message.role).toBe("assistant")
      expect(result.message.content).toBe("Hello world")
    }
  })

  it("should parse sdk_message with optional toolName", () => {
    const raw = JSON.stringify({
      type: "sdk_message",
      message: {
        role: "tool",
        content: "File contents",
        toolName: "Read",
        timestamp: "2026-01-01T00:00:00Z",
      },
    })
    const result = parseRunnerMessage(raw)
    expect(result.type).toBe("sdk_message")
    if (result.type === "sdk_message") {
      expect(result.message.toolName).toBe("Read")
    }
  })

  it("should parse a valid question message", () => {
    const raw = JSON.stringify({
      type: "question",
      questions: [
        {
          id: "q1",
          question: "Allow file edit?",
          options: [
            { label: "Yes", value: "yes" },
            { label: "No", value: "no" },
          ],
          defaultAnswer: "yes",
        },
      ],
    })
    const result = parseRunnerMessage(raw)
    expect(result.type).toBe("question")
    if (result.type === "question") {
      expect(result.questions).toHaveLength(1)
      expect(result.questions[0].id).toBe("q1")
    }
  })

  it("should parse a valid status message with result", () => {
    const raw = JSON.stringify({
      type: "status",
      status: "completed",
      result: {
        success: true,
        summary: "All tasks done",
        prUrl: "https://github.com/org/repo/pull/1",
        costUsd: 1.23,
        turnsUsed: 15,
      },
    })
    const result = parseRunnerMessage(raw)
    expect(result.type).toBe("status")
    if (result.type === "status") {
      expect(result.status).toBe("completed")
      expect(result.result?.success).toBe(true)
      expect(result.result?.prUrl).toBe("https://github.com/org/repo/pull/1")
    }
  })

  it("should parse a status message without result", () => {
    const raw = JSON.stringify({
      type: "status",
      status: "running",
    })
    const result = parseRunnerMessage(raw)
    expect(result.type).toBe("status")
    if (result.type === "status") {
      expect(result.status).toBe("running")
      expect(result.result).toBeUndefined()
    }
  })

  it("should throw on invalid type", () => {
    const raw = JSON.stringify({ type: "invalid_type" })
    expect(() => parseRunnerMessage(raw)).toThrow()
  })

  it("should throw on missing required fields", () => {
    const raw = JSON.stringify({ type: "sdk_message" })
    expect(() => parseRunnerMessage(raw)).toThrow()
  })

  it("should throw on invalid JSON", () => {
    expect(() => parseRunnerMessage("not json")).toThrow()
  })

  it("should throw on invalid role in sdk_message", () => {
    const raw = JSON.stringify({
      type: "sdk_message",
      message: {
        role: "invalid_role",
        content: "Hello",
        timestamp: "2026-01-01T00:00:00Z",
      },
    })
    expect(() => parseRunnerMessage(raw)).toThrow()
  })

  it("should throw on invalid status value", () => {
    const raw = JSON.stringify({
      type: "status",
      status: "paused",
    })
    expect(() => parseRunnerMessage(raw)).toThrow()
  })
})

describe("parseDashboardMessage", () => {
  it("should parse a valid subscribe message", () => {
    const raw = JSON.stringify({
      type: "subscribe",
      sessionIds: ["s1", "s2"],
    })
    const result = parseDashboardMessage(raw)
    expect(result.type).toBe("subscribe")
    if (result.type === "subscribe") {
      expect(result.sessionIds).toEqual(["s1", "s2"])
    }
  })

  it("should parse a valid answer message", () => {
    const raw = JSON.stringify({
      type: "answer",
      sessionId: "session-1",
      answers: { q1: "yes", q2: "no" },
    })
    const result = parseDashboardMessage(raw)
    expect(result.type).toBe("answer")
    if (result.type === "answer") {
      expect(result.sessionId).toBe("session-1")
      expect(result.answers).toEqual({ q1: "yes", q2: "no" })
    }
  })

  it("should parse a valid cancel message", () => {
    const raw = JSON.stringify({
      type: "cancel",
      sessionId: "session-1",
    })
    const result = parseDashboardMessage(raw)
    expect(result.type).toBe("cancel")
    if (result.type === "cancel") {
      expect(result.sessionId).toBe("session-1")
    }
  })

  it("should throw on invalid type", () => {
    const raw = JSON.stringify({ type: "unknown" })
    expect(() => parseDashboardMessage(raw)).toThrow()
  })

  it("should throw on missing sessionIds in subscribe", () => {
    const raw = JSON.stringify({ type: "subscribe" })
    expect(() => parseDashboardMessage(raw)).toThrow()
  })

  it("should throw on missing sessionId in answer", () => {
    const raw = JSON.stringify({
      type: "answer",
      answers: { q1: "yes" },
    })
    expect(() => parseDashboardMessage(raw)).toThrow()
  })

  it("should throw on missing answers in answer", () => {
    const raw = JSON.stringify({
      type: "answer",
      sessionId: "s1",
    })
    expect(() => parseDashboardMessage(raw)).toThrow()
  })

  it("should throw on invalid JSON", () => {
    expect(() => parseDashboardMessage("{bad")).toThrow()
  })
})
