import { describe, it, expect } from "vitest"
import { z } from "zod"
import { isRepoAllowed, parseAllowedRepos } from "./tasks.js"

// Re-create the schemas from the source to test validation independently
const MAX_PROMPT_LENGTH = 10000
const MAX_TURNS_LIMIT = 500
const MIN_BUDGET_USD = 0.01
const MAX_BUDGET_USD = 50
const MAX_PAGE_SIZE = 100
const MAX_REPOS = 10

const repoSchema = z.object({
  url: z.string().url(),
  branch: z.string().optional(),
})

const directSourceSchema = z.object({
  mode: z.literal("direct"),
  repos: z.array(repoSchema).min(1).max(MAX_REPOS),
})

const orgSourceSchema = z.object({
  mode: z.literal("org"),
  org: z.string().min(1),
  pattern: z.string().optional(),
})

const discoverySourceSchema = z.object({
  mode: z.literal("discovery"),
  org: z.string().min(1),
  hint: z.string().max(500).optional(),
})

const repoSourceSchema = z.discriminatedUnion("mode", [
  directSourceSchema,
  orgSourceSchema,
  discoverySourceSchema,
])

const createTaskSchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  repoSource: repoSourceSchema,
  maxTurns: z.number().int().min(1).max(MAX_TURNS_LIMIT).optional(),
  maxBudgetUsd: z.number().min(MIN_BUDGET_USD).max(MAX_BUDGET_USD).optional(),
})

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
  status: z.string().optional(),
})

describe("createTaskSchema", () => {
  describe("direct mode", () => {
    it("should validate a minimal direct task", () => {
      const result = createTaskSchema.parse({
        prompt: "Fix the bug",
        repoSource: {
          mode: "direct",
          repos: [{ url: "https://github.com/org/repo" }],
        },
      })
      expect(result.prompt).toBe("Fix the bug")
      expect(result.repoSource.mode).toBe("direct")
      if (result.repoSource.mode === "direct") {
        expect(result.repoSource.repos).toHaveLength(1)
        expect(result.repoSource.repos[0].url).toBe("https://github.com/org/repo")
      }
    })

    it("should validate multiple repos with branches", () => {
      const result = createTaskSchema.parse({
        prompt: "Fix the bug",
        repoSource: {
          mode: "direct",
          repos: [
            { url: "https://github.com/org/repo1", branch: "main" },
            { url: "https://github.com/org/repo2", branch: "develop" },
          ],
        },
        maxTurns: 100,
        maxBudgetUsd: 10,
      })
      if (result.repoSource.mode === "direct") {
        expect(result.repoSource.repos).toHaveLength(2)
        expect(result.repoSource.repos[0].branch).toBe("main")
        expect(result.repoSource.repos[1].branch).toBe("develop")
      }
    })

    it("should reject empty repos array", () => {
      expect(() =>
        createTaskSchema.parse({
          prompt: "Fix it",
          repoSource: { mode: "direct", repos: [] },
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
          repoSource: { mode: "direct", repos },
        }),
      ).toThrow()
    })

    it("should accept repos at max count", () => {
      const repos = Array.from({ length: 10 }, (_, i) => ({
        url: `https://github.com/org/repo${i}`,
      }))
      const result = createTaskSchema.parse({
        prompt: "Fix it",
        repoSource: { mode: "direct", repos },
      })
      if (result.repoSource.mode === "direct") {
        expect(result.repoSource.repos).toHaveLength(10)
      }
    })

    it("should reject invalid repo url", () => {
      expect(() =>
        createTaskSchema.parse({
          prompt: "Fix it",
          repoSource: { mode: "direct", repos: [{ url: "not-a-url" }] },
        }),
      ).toThrow()
    })
  })

  describe("org mode", () => {
    it("should validate org mode with pattern", () => {
      const result = createTaskSchema.parse({
        prompt: "Update all services",
        repoSource: { mode: "org", org: "BloomerAB", pattern: "service-*" },
      })
      expect(result.repoSource.mode).toBe("org")
      if (result.repoSource.mode === "org") {
        expect(result.repoSource.org).toBe("BloomerAB")
        expect(result.repoSource.pattern).toBe("service-*")
      }
    })

    it("should validate org mode without pattern", () => {
      const result = createTaskSchema.parse({
        prompt: "Update all",
        repoSource: { mode: "org", org: "BloomerAB" },
      })
      if (result.repoSource.mode === "org") {
        expect(result.repoSource.pattern).toBeUndefined()
      }
    })

    it("should reject org mode with empty org", () => {
      expect(() =>
        createTaskSchema.parse({
          prompt: "Fix",
          repoSource: { mode: "org", org: "" },
        }),
      ).toThrow()
    })
  })

  describe("discovery mode", () => {
    it("should validate discovery mode with hint", () => {
      const result = createTaskSchema.parse({
        prompt: "Find and fix security issues",
        repoSource: { mode: "discovery", org: "BloomerAB", hint: "focus on backend services" },
      })
      expect(result.repoSource.mode).toBe("discovery")
      if (result.repoSource.mode === "discovery") {
        expect(result.repoSource.org).toBe("BloomerAB")
        expect(result.repoSource.hint).toBe("focus on backend services")
      }
    })

    it("should validate discovery mode without hint", () => {
      const result = createTaskSchema.parse({
        prompt: "Audit",
        repoSource: { mode: "discovery", org: "BloomerAB" },
      })
      if (result.repoSource.mode === "discovery") {
        expect(result.repoSource.hint).toBeUndefined()
      }
    })
  })

  describe("common validation", () => {
    it("should reject empty prompt", () => {
      expect(() =>
        createTaskSchema.parse({
          prompt: "",
          repoSource: { mode: "org", org: "BloomerAB" },
        }),
      ).toThrow()
    })

    it("should reject prompt exceeding max length", () => {
      expect(() =>
        createTaskSchema.parse({
          prompt: "x".repeat(10001),
          repoSource: { mode: "org", org: "BloomerAB" },
        }),
      ).toThrow()
    })

    it("should reject maxTurns of 0", () => {
      expect(() =>
        createTaskSchema.parse({
          prompt: "Fix",
          repoSource: { mode: "org", org: "BloomerAB" },
          maxTurns: 0,
        }),
      ).toThrow()
    })

    it("should reject maxTurns exceeding 500", () => {
      expect(() =>
        createTaskSchema.parse({
          prompt: "Fix",
          repoSource: { mode: "org", org: "BloomerAB" },
          maxTurns: 501,
        }),
      ).toThrow()
    })

    it("should reject invalid mode", () => {
      expect(() =>
        createTaskSchema.parse({
          prompt: "Fix",
          repoSource: { mode: "invalid" },
        }),
      ).toThrow()
    })

    it("should reject missing repoSource", () => {
      expect(() =>
        createTaskSchema.parse({
          prompt: "Fix",
        }),
      ).toThrow()
    })
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
