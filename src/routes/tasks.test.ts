import { describe, it, expect } from "vitest"
import { z } from "zod"
import { isRepoAllowed, parseAllowedRepos } from "./tasks.js"

// Re-create the schemas from the source to test validation independently
const MAX_PROMPT_LENGTH = 10000
const MAX_TURNS_LIMIT = 200
const MIN_BUDGET_USD = 0.01
const MAX_BUDGET_USD = 50
const MAX_PAGE_SIZE = 100
const MAX_REPOS = 10

const repoSchema = z.object({
  url: z.string().url(),
  branch: z.string().optional(),
})

const createTaskSchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  repos: z.array(repoSchema).min(1).max(MAX_REPOS),
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
      repos: [{ url: "https://github.com/org/repo" }],
    })
    expect(result.prompt).toBe("Fix the bug")
    expect(result.repos).toHaveLength(1)
    expect(result.repos[0].url).toBe("https://github.com/org/repo")
    expect(result.maxTurns).toBeUndefined()
    expect(result.maxBudgetUsd).toBeUndefined()
  })

  it("should validate a fully-specified task with multiple repos", () => {
    const result = createTaskSchema.parse({
      prompt: "Fix the bug",
      repos: [
        { url: "https://github.com/org/repo1", branch: "main" },
        { url: "https://github.com/org/repo2", branch: "develop" },
      ],
      maxTurns: 100,
      maxBudgetUsd: 10,
    })
    expect(result.repos).toHaveLength(2)
    expect(result.repos[0].branch).toBe("main")
    expect(result.repos[1].branch).toBe("develop")
    expect(result.maxTurns).toBe(100)
    expect(result.maxBudgetUsd).toBe(10)
  })

  it("should accept repos with optional branch", () => {
    const result = createTaskSchema.parse({
      prompt: "Fix",
      repos: [{ url: "https://github.com/org/repo" }],
    })
    expect(result.repos[0].branch).toBeUndefined()
  })

  it("should reject empty prompt", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "",
        repos: [{ url: "https://github.com/org/repo" }],
      }),
    ).toThrow()
  })

  it("should reject prompt exceeding max length", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "x".repeat(10001),
        repos: [{ url: "https://github.com/org/repo" }],
      }),
    ).toThrow()
  })

  it("should accept prompt at max length", () => {
    const result = createTaskSchema.parse({
      prompt: "x".repeat(10000),
      repos: [{ url: "https://github.com/org/repo" }],
    })
    expect(result.prompt).toHaveLength(10000)
  })

  it("should reject empty repos array", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "Fix it",
        repos: [],
      }),
    ).toThrow()
  })

  it("should reject repos exceeding max count", () => {
    const repos = Array.from({ length: 11 }, (_, i) => ({
      url: `https://github.com/org/repo${i}`,
    }))
    expect(() =>
      createTaskSchema.parse({
        prompt: "Fix it",
        repos,
      }),
    ).toThrow()
  })

  it("should accept repos at max count", () => {
    const repos = Array.from({ length: 10 }, (_, i) => ({
      url: `https://github.com/org/repo${i}`,
    }))
    const result = createTaskSchema.parse({
      prompt: "Fix it",
      repos,
    })
    expect(result.repos).toHaveLength(10)
  })

  it("should reject invalid repo url", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "Fix it",
        repos: [{ url: "not-a-url" }],
      }),
    ).toThrow()
  })

  it("should reject missing repos", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "Fix it",
      }),
    ).toThrow()
  })

  it("should reject missing prompt", () => {
    expect(() =>
      createTaskSchema.parse({
        repos: [{ url: "https://github.com/org/repo" }],
      }),
    ).toThrow()
  })

  it("should reject maxTurns of 0", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "Fix",
        repos: [{ url: "https://github.com/org/repo" }],
        maxTurns: 0,
      }),
    ).toThrow()
  })

  it("should reject maxTurns exceeding 200", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "Fix",
        repos: [{ url: "https://github.com/org/repo" }],
        maxTurns: 201,
      }),
    ).toThrow()
  })

  it("should accept maxTurns at boundary values", () => {
    const min = createTaskSchema.parse({
      prompt: "Fix",
      repos: [{ url: "https://github.com/org/repo" }],
      maxTurns: 1,
    })
    expect(min.maxTurns).toBe(1)

    const max = createTaskSchema.parse({
      prompt: "Fix",
      repos: [{ url: "https://github.com/org/repo" }],
      maxTurns: 200,
    })
    expect(max.maxTurns).toBe(200)
  })

  it("should reject non-integer maxTurns", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "Fix",
        repos: [{ url: "https://github.com/org/repo" }],
        maxTurns: 5.5,
      }),
    ).toThrow()
  })

  it("should reject maxBudgetUsd below minimum", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "Fix",
        repos: [{ url: "https://github.com/org/repo" }],
        maxBudgetUsd: 0,
      }),
    ).toThrow()
  })

  it("should reject maxBudgetUsd exceeding 50", () => {
    expect(() =>
      createTaskSchema.parse({
        prompt: "Fix",
        repos: [{ url: "https://github.com/org/repo" }],
        maxBudgetUsd: 51,
      }),
    ).toThrow()
  })

  it("should accept maxBudgetUsd at boundary values", () => {
    const min = createTaskSchema.parse({
      prompt: "Fix",
      repos: [{ url: "https://github.com/org/repo" }],
      maxBudgetUsd: 0.01,
    })
    expect(min.maxBudgetUsd).toBe(0.01)

    const max = createTaskSchema.parse({
      prompt: "Fix",
      repos: [{ url: "https://github.com/org/repo" }],
      maxBudgetUsd: 50,
    })
    expect(max.maxBudgetUsd).toBe(50)
  })

  it("should accept decimal maxBudgetUsd", () => {
    const result = createTaskSchema.parse({
      prompt: "Fix",
      repos: [{ url: "https://github.com/org/repo" }],
      maxBudgetUsd: 2.5,
    })
    expect(result.maxBudgetUsd).toBe(2.5)
  })

  it("should strip unknown fields", () => {
    const result = createTaskSchema.parse({
      prompt: "Fix",
      repos: [{ url: "https://github.com/org/repo" }],
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

describe("parseAllowedRepos", () => {
  it("should return empty array for empty string", () => {
    expect(parseAllowedRepos("")).toEqual([])
  })

  it("should return empty array for whitespace-only string", () => {
    expect(parseAllowedRepos("   ")).toEqual([])
  })

  it("should parse comma-separated repos", () => {
    const result = parseAllowedRepos("github.com/org1/*,github.com/org2/*")
    expect(result).toEqual(["github.com/org1/*", "github.com/org2/*"])
  })

  it("should trim whitespace from entries", () => {
    const result = parseAllowedRepos(" github.com/org1/* , github.com/org2/* ")
    expect(result).toEqual(["github.com/org1/*", "github.com/org2/*"])
  })

  it("should filter empty entries", () => {
    const result = parseAllowedRepos("github.com/org1/*,,github.com/org2/*,")
    expect(result).toEqual(["github.com/org1/*", "github.com/org2/*"])
  })
})

describe("isRepoAllowed", () => {
  it("should allow any repo when patterns list is empty", () => {
    expect(isRepoAllowed("https://github.com/any/repo", [])).toBe(true)
  })

  it("should allow repo matching a glob pattern", () => {
    const patterns = ["github.com/bloomerab/*"]
    expect(isRepoAllowed("https://github.com/bloomerab/my-repo", patterns)).toBe(true)
  })

  it("should reject repo not matching any pattern", () => {
    const patterns = ["github.com/bloomerab/*"]
    expect(isRepoAllowed("https://github.com/other-org/repo", patterns)).toBe(false)
  })

  it("should strip protocol and .git suffix for matching", () => {
    const patterns = ["github.com/org/repo"]
    expect(isRepoAllowed("https://github.com/org/repo.git", patterns)).toBe(true)
  })

  it("should support multiple patterns", () => {
    const patterns = ["github.com/org1/*", "github.com/org2/*"]
    expect(isRepoAllowed("https://github.com/org1/repo", patterns)).toBe(true)
    expect(isRepoAllowed("https://github.com/org2/repo", patterns)).toBe(true)
    expect(isRepoAllowed("https://github.com/org3/repo", patterns)).toBe(false)
  })
})
