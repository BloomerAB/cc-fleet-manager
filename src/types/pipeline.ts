import type { PermissionMode } from "./session.js"

export interface StageDefinition {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly systemPromptAppend: string
  readonly permissionMode: PermissionMode
  readonly transition: "auto" | "manual"
  readonly maxTurns?: number
}

export interface PipelineDefinition {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly stages: readonly StageDefinition[]
}

export interface StageState {
  readonly pipelineId: string
  currentStageIndex: number
  readonly stageResults: StageResult[]
  stageStartedAt: string | null
}

export interface StageResult {
  readonly stageId: string
  readonly status: "completed" | "skipped"
  readonly completedAt: string
}
