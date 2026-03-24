import { describe, it, expect, vi, beforeEach } from "vitest"
import { createWsManager, parseDashboardMessage } from "./ws-manager.js"

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

      // Before close, emitToSession should reach it
      manager.emitToSession("s1", "user-1", {
        type: "session_update",
        sessionId: "s1",
        status: "running",
      })
      expect(ws.send).toHaveBeenCalledOnce()

      ws.send.mockClear()
      ws.emit("close")

      // After close, emitToSession should not reach it
      manager.emitToSession("s1", "user-1", {
        type: "session_update",
        sessionId: "s1",
        status: "completed",
      })
      expect(ws.send).not.toHaveBeenCalled()
    })
  })

  describe("emitToSession", () => {
    it("should emit to all dashboards matching userId", () => {
      const ws1 = createMockWs()
      const ws2 = createMockWs()
      manager.registerDashboard("user-1", ws1 as never)
      manager.registerDashboard("user-1", ws2 as never)

      const msg = { type: "session_update" as const, sessionId: "s1", status: "running" as const }
      manager.emitToSession("s1", "user-1", msg)

      expect(ws1.send).toHaveBeenCalledWith(JSON.stringify(msg))
      expect(ws2.send).toHaveBeenCalledWith(JSON.stringify(msg))
    })

    it("should not emit to dashboards of different userId", () => {
      const ws1 = createMockWs()
      const ws2 = createMockWs()
      manager.registerDashboard("user-1", ws1 as never)
      manager.registerDashboard("user-2", ws2 as never)

      manager.emitToSession("s1", "user-1", {
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
      manager.emitToSession("s1", "user-1", {
        type: "session_update",
        sessionId: "s1",
        status: "running",
      })
      expect(ws.send).toHaveBeenCalledOnce()

      ws.send.mockClear()

      // Message for s2 should not arrive (not subscribed)
      manager.emitToSession("s2", "user-1", {
        type: "session_update",
        sessionId: "s2",
        status: "running",
      })
      expect(ws.send).not.toHaveBeenCalled()
    })

    it("should emit all sessions when subscribedSessions is empty", () => {
      const ws = createMockWs()
      manager.registerDashboard("user-1", ws as never)

      manager.emitToSession("any-session", "user-1", {
        type: "session_update",
        sessionId: "any-session",
        status: "running",
      })
      expect(ws.send).toHaveBeenCalledOnce()
    })

    it("should skip dashboards with closed ws", () => {
      const ws = createMockWs(3) // CLOSED
      manager.registerDashboard("user-1", ws as never)

      manager.emitToSession("s1", "user-1", {
        type: "session_update",
        sessionId: "s1",
        status: "running",
      })
      expect(ws.send).not.toHaveBeenCalled()
    })
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
