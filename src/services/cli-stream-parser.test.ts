import { describe, it, expect } from "vitest"
import { parseCliLine } from "./cli-stream-parser.js"

describe("parseCliLine", () => {
  it("returns empty array for empty line", () => {
    expect(parseCliLine("")).toEqual([])
    expect(parseCliLine("  ")).toEqual([])
  })

  it("returns empty array for invalid JSON", () => {
    expect(parseCliLine("not json")).toEqual([])
  })

  it("returns empty array for JSON without type field", () => {
    expect(parseCliLine('{"foo":"bar"}')).toEqual([])
  })

  describe("assistant events", () => {
    it("parses text content block", () => {
      const event = JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello world" }],
        },
        session_id: "sess-1",
      })

      const actions = parseCliLine(event)
      expect(actions).toEqual([
        { kind: "output", text: "Hello world" },
      ])
    })

    it("parses tool_use content block", () => {
      const event = JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "npm test" },
          }],
        },
        session_id: "sess-1",
      })

      const actions = parseCliLine(event)
      expect(actions).toEqual([
        { kind: "output", text: '{"command":"npm test"}', toolName: "Bash" },
      ])
    })

    it("parses mixed text and tool_use blocks", () => {
      const event = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me check" },
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/foo.ts" } },
          ],
        },
        session_id: "sess-1",
      })

      const actions = parseCliLine(event)
      expect(actions).toHaveLength(2)
      expect(actions[0]).toEqual({ kind: "output", text: "Let me check" })
      expect(actions[1]).toEqual({
        kind: "output",
        text: '{"file_path":"/foo.ts"}',
        toolName: "Read",
      })
    })
  })

  describe("result events", () => {
    it("parses successful result", () => {
      const event = JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Task completed successfully",
        session_id: "sess-1",
        total_cost_usd: 0.42,
        num_turns: 5,
        duration_ms: 30000,
      })

      const actions = parseCliLine(event)
      expect(actions).toEqual([{
        kind: "result",
        success: true,
        summary: "Task completed successfully",
        costUsd: 0.42,
        turnsUsed: 5,
        cliSessionId: "sess-1",
      }])
    })

    it("parses failed result", () => {
      const event = JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        result: "Out of turns",
        session_id: "sess-1",
        total_cost_usd: 1.0,
        num_turns: 200,
        duration_ms: 60000,
      })

      const actions = parseCliLine(event)
      expect(actions).toEqual([{
        kind: "result",
        success: false,
        summary: "Failed: Out of turns",
        costUsd: 1.0,
        turnsUsed: 200,
        cliSessionId: "sess-1",
      }])
    })

    it("treats success with is_error=true as failure", () => {
      const event = JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Not logged in",
        session_id: "sess-1",
        total_cost_usd: 0,
        num_turns: 1,
        duration_ms: 20,
      })

      const actions = parseCliLine(event)
      expect(actions[0]).toMatchObject({ kind: "result", success: false })
    })
  })

  describe("system events", () => {
    it("parses init event", () => {
      const event = JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
        model: "claude-sonnet-4-6",
      })

      const actions = parseCliLine(event)
      expect(actions).toEqual([{
        kind: "system",
        text: "[System: init]",
        cliSessionId: "sess-1",
      }])
    })

    it("parses api_retry event", () => {
      const event = JSON.stringify({
        type: "system",
        subtype: "api_retry",
        attempt: 1,
      })

      const actions = parseCliLine(event)
      expect(actions).toEqual([{
        kind: "system",
        text: "[System: api_retry]",
        cliSessionId: undefined,
      }])
    })
  })

  it("handles real CLI init output", () => {
    // Actual output captured from `claude -p --output-format stream-json --verbose --bare`
    const line = '{"type":"system","subtype":"init","cwd":"/tmp","session_id":"39ef0c0e-5f64-4e4f-bbce-7e08051c0b07","tools":["Bash","Read","Edit"],"model":"claude-sonnet-4-6","permissionMode":"default"}'

    const actions = parseCliLine(line)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      kind: "system",
      text: "[System: init]",
      cliSessionId: "39ef0c0e-5f64-4e4f-bbce-7e08051c0b07",
    })
  })
})
