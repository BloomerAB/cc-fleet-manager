// Runner → Session Manager
export type RunnerMessage =
  | RunnerSdkMessage
  | RunnerQuestionMessage
  | RunnerStatusMessage

export interface RunnerSdkMessage {
  readonly type: "sdk_message"
  readonly message: SdkMessage
}

export interface RunnerQuestionMessage {
  readonly type: "question"
  readonly questions: readonly Question[]
}

export interface RunnerStatusMessage {
  readonly type: "status"
  readonly status: "running" | "completed" | "failed"
  readonly result?: RunnerResult
}

export interface SdkMessage {
  readonly role: "assistant" | "tool"
  readonly content: string
  readonly toolName?: string
  readonly timestamp: string
}

export interface Question {
  readonly id: string
  readonly question: string
  readonly options?: readonly QuestionOption[]
  readonly defaultAnswer?: string
}

export interface QuestionOption {
  readonly label: string
  readonly value: string
}

export interface RunnerResult {
  readonly success: boolean
  readonly summary: string
  readonly prUrl?: string
  readonly costUsd?: number
  readonly turnsUsed?: number
}

// Session Manager → Runner
export type ManagerToRunnerMessage =
  | ManagerAnswerMessage
  | ManagerCancelMessage

export interface ManagerAnswerMessage {
  readonly type: "answer"
  readonly answers: Readonly<Record<string, string>>
}

export interface ManagerCancelMessage {
  readonly type: "cancel"
}

// Session Manager → Dashboard
export type ManagerToDashboardMessage =
  | DashboardSessionUpdate
  | DashboardOutputMessage
  | DashboardQuestionMessage
  | DashboardResultMessage

export interface DashboardSessionUpdate {
  readonly type: "session_update"
  readonly sessionId: string
  readonly status: import("./session.js").SessionStatus
}

export interface DashboardOutputMessage {
  readonly type: "output"
  readonly sessionId: string
  readonly text: string
  readonly toolName?: string
  readonly timestamp: string
}

export interface DashboardQuestionMessage {
  readonly type: "question"
  readonly sessionId: string
  readonly questions: readonly Question[]
}

export interface DashboardResultMessage {
  readonly type: "result"
  readonly sessionId: string
  readonly result: RunnerResult
}

// Dashboard → Session Manager
export type DashboardToManagerMessage =
  | DashboardAnswerMessage
  | DashboardCancelMessage
  | DashboardSubscribeMessage
  | DashboardFollowUpMessage
  | DashboardEndSessionMessage

export interface DashboardAnswerMessage {
  readonly type: "answer"
  readonly sessionId: string
  readonly answers: Readonly<Record<string, string>>
}

export interface DashboardCancelMessage {
  readonly type: "cancel"
  readonly sessionId: string
}

export interface DashboardSubscribeMessage {
  readonly type: "subscribe"
  readonly sessionIds: readonly string[]
}

export interface DashboardFollowUpMessage {
  readonly type: "follow_up"
  readonly sessionId: string
  readonly text: string
}

export interface DashboardEndSessionMessage {
  readonly type: "end_session"
  readonly sessionId: string
}
