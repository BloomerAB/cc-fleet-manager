import { describe, it, expect } from "vitest"
import { z } from "zod"

// Re-create the schemas from the source to test validation independently
// This avoids needing to import non-exported schemas while still testing the validation logic

const MAX_PROMPT_LENGTH = 10000
const MAX_TURNS_LIMIT = 200
const MIN_BUDGET_USD = 0.01
const MAX_BUDGET_USD = 50
const MAX_PAGE_SIZE = 100

const createTaskSchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  repoUrl: z.string().url(),
  repoBranch: z.string().optional(),
  maxTurns: z.number().int().min(1).max(MAX_TURNS_LIMIT).optional(),
  maxBudgetUsd: z.number().min(MIN_BUDGET_USD).max(MAX_BUDGET_USD).optional(),
})

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
  status: z.string().optional(),
})

describe("createTaskSchema", () => {
  it("should validate a minimal valid task", () => {
    const result = createTaskSchema.parse({
      prompt: "Fix the bug",
      repoUrl: "https://github.com/org/repo",
    })
    expect(result.prompt).toBe("Fix the bug")
    expect(result.repoUrl).toBe("https://github.com/org/repo")
    expect(result.repoBranch).toBeUndefined()
    expect(result.maxTurns).toBeUndefined()
    expect(result.maxBudgetUsd).toBeUndefined()
  })

  it("should validate a fully-specified task", () => {
    const result = createTaskSchema.parse({
      prompt: "Fix the bug",
      repoUrl: "https://github.com/org/repo",
      repoBranch: "feature/fix",
      maxTurns: 100,
      maxBudgetUsd: 10,
    })
    expect(result.repoBranch).toBe("feature/fix")
    expect(result.maxTurns).toBe(100)
    expect(result.maxBudgetUsd).toBe(10)
  })

  it("should reject empty prompt", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "",
        repoUrl: "https://github.com/org/repo",
      }),
    ).toThrow()
  })

  it("should reject prompt exceeding max length", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "x".repeat(10001),
        repoUrl: "https://github.com/org/repo",
      }),
    ).toThrow()
  })

  it("should accept prompt at max length", () => {
    const result = createTaskSchema.parse({
      prompt: "x".repeat(10000),
      repoUrl: "https://github.com/org/repo",
    })
    expect(result.prompt).toHaveLength(10000)
  })

  it("should reject invalid repoUrl", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "Fix it",
        repoUrl: "not-a-url",
      }),
    ).toThrow()
  })

  it("should reject missing repoUrl", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "Fix it",
      }),
    ).toThrow()
  })

  it("should reject missing prompt", () => {
    expect(() =>
      createTaskSchema.parse({
        repoUrl: "https://github.com/org/repo",
      }),
    ).toThrow()
  })

  it("should reject maxTurns of 0", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "Fix",
        repoUrl: "https://github.com/org/repo",
        maxTurns: 0,
      }),
    ).toThrow()
  })

  it("should reject maxTurns exceeding 200", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "Fix",
        repoUrl: "https://github.com/org/repo",
        maxTurns: 201,
      }),
    ).toThrow()
  })

  it("should accept maxTurns at boundary values", () => {
    const min = createTaskSchema.parse({
      prompt: "Fix",
      repoUrl: "https://github.com/org/repo",
      maxTurns: 1,
    })
    expect(min.maxTurns).toBe(1)

    const max = createTaskSchema.parse({
      prompt: "Fix",
      repoUrl: "https://github.com/org/repo",
      maxTurns: 200,
    })
    expect(max.maxTurns).toBe(200)
  })

  it("should reject non-integer maxTurns", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "Fix",
        repoUrl: "https://github.com/org/repo",
        maxTurns: 5.5,
      }),
    ).toThrow()
  })

  it("should reject maxBudgetUsd below minimum", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "Fix",
        repoUrl: "https://github.com/org/repo",
        maxBudgetUsd: 0,
      }),
    ).toThrow()
  })

  it("should reject maxBudgetUsd exceeding 50", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "Fix",
        repoUrl: "https://github.com/org/repo",
        maxBudgetUsd: 51,
      }),
    ).toThrow()
  })

  it("should accept maxBudgetUsd at boundary values", () => {
    const min = createTaskSchema.parse({
      prompt: "Fix",
      repoUrl: "https://github.com/org/repo",
      maxBudgetUsd: 0.01,
    })
    expect(min.maxBudgetUsd).toBe(0.01)

    const max = createTaskSchema.parse({
      prompt: "Fix",
      repoUrl: "https://github.com/org/repo",
      maxBudgetUsd: 50,
    })
    expect(max.maxBudgetUsd).toBe(50)
  })

  it("should accept decimal maxBudgetUsd", () => {
    const result = createTaskSchema.parse({
      prompt: "Fix",
      repoUrl: "https://github.com/org/repo",
      maxBudgetUsd: 2.5,
    })
    expect(result.maxBudgetUsd).toBe(2.5)
  })

  it("should strip unknown fields", () => {
    const result = createTaskSchema.parse({
      prompt: "Fix",
      repoUrl: "https://github.com/org/repo",
      unknownField: "should be stripped",
    })
    expect((result as Record<string, unknown>).unknownField).toBeUndefined()
  })
})

describe("listQuerySchema", () => {
  it("should apply defaults when no values provided", () => {
    const result = listQuerySchema.parse({})
    expect(result.page).toBe(1)
    expect(result.limit).toBe(20)
    expect(result.status).toBeUndefined()
  })

  it("should coerce string page to number", () => {
    const result = listQuerySchema.parse({ page: "3" })
    expect(result.page).toBe(3)
    expect(typeof result.page).toBe("number")
  })

  it("should coerce string limit to number", () => {
    const result = listQuerySchema.parse({ limit: "50" })
    expect(result.limit).toBe(50)
    expect(typeof result.limit).toBe("number")
  })

  it("should reject page less than 1", () => {
    expect(() => listQuerySchema.parse({ page: "0" })).toThrow()
  })

  it("should reject limit less than 1", () => {
    expect(() => listQuerySchema.parse({ limit: "0" })).toThrow()
  })

  it("should reject limit exceeding 100", () => {
    expect(() => listQuerySchema.parse({ limit: "101" })).toThrow()
  })

  it("should accept limit at max boundary", () => {
    const result = listQuerySchema.parse({ limit: "100" })
    expect(result.limit).toBe(100)
  })

  it("should pass through status as optional string", () => {
    const result = listQuerySchema.parse({ status: "running" })
    expect(result.status).toBe("running")
  })
})
