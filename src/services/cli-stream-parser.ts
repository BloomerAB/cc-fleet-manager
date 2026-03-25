// Parses Claude CLI stream-json output into actions for the task executor.
// Each line from stdout is a JSON object. This module maps them to our domain.

interface TextBlock {
  readonly type: "text"
  readonly text: string
}

interface ToolUseBlock {
  readonly type: "tool_use"
  readonly id: string
  readonly name: string
  readonly input: unknown
}

type ContentBlock = TextBlock | ToolUseBlock

interface CliAssistantEvent {
  readonly type: "assistant"
  readonly message: {
    readonly content: readonly ContentBlock[]
  }
  readonly session_id: string
}

interface CliResultEvent {
  readonly type: "result"
  readonly subtype: string
  readonly is_error: boolean
  readonly result: string
  readonly session_id: string
  readonly total_cost_usd: number
  readonly num_turns: number
  readonly duration_ms: number
}

interface CliSystemEvent {
  readonly type: "system"
  readonly subtype: string
  readonly session_id?: string
  readonly [key: string]: unknown
}

type CliEvent = CliAssistantEvent | CliResultEvent | CliSystemEvent

// Parsed output actions
interface OutputAction {
  readonly kind: "output"
  readonly text: string
  readonly toolName?: string
}

interface ResultAction {
  readonly kind: "result"
  readonly success: boolean
  readonly summary: string
  readonly costUsd: number
  readonly turnsUsed: number
  readonly cliSessionId: string
}

interface SystemAction {
  readonly kind: "system"
  readonly text: string
  readonly cliSessionId?: string
}

type ParsedAction = OutputAction | ResultAction | SystemAction

const parseCliLine = (line: string): readonly ParsedAction[] => {
  const trimmed = line.trim()
  if (!trimmed) return []

  let event: CliEvent
  try {
    event = JSON.parse(trimmed) as CliEvent
  } catch {
    return []
  }

  if (!event.type) return []

  switch (event.type) {
    case "assistant": {
      const actions: ParsedAction[] = []
      for (const block of event.message.content) {
        if (block.type === "text" && "text" in block) {
          actions.push({ kind: "output", text: block.text })
        } else if (block.type === "tool_use") {
          actions.push({
            kind: "output",
            text: JSON.stringify(block.input),
            toolName: block.name,
          })
        }
      }
      return actions
    }

    case "result": {
      const success = event.subtype === "success" && !event.is_error
      return [{
        kind: "result",
        success,
        summary: success ? (event.result || "Task completed") : `Failed: ${event.result || event.subtype}`,
        costUsd: event.total_cost_usd,
        turnsUsed: event.num_turns,
        cliSessionId: event.session_id,
      }]
    }

    case "system": {
      return [{
        kind: "system",
        text: `[System: ${event.subtype}]`,
        cliSessionId: event.session_id,
      }]
    }

    default:
      return []
  }
}

export { parseCliLine }
export type { ParsedAction, OutputAction, ResultAction, SystemAction, CliEvent }
