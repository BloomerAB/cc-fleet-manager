import { describe, it, expect, vi, beforeEach } from "vitest"
import { createUserStore } from "./user-store.js"

const createMockClient = () => {
  const execute = vi.fn()
  return {
    client: { execute } as unknown as Parameters<typeof createUserStore>[0],
    execute,
  }
}

const createMockRow = (data: Record<string, unknown>) => ({
  ...data,
  get: (key: string) => data[key],
})

describe("createUserStore", () => {
  let mock: ReturnType<typeof createMockClient>
  let store: ReturnType<typeof createUserStore>

  beforeEach(() => {
    mock = createMockClient()
    store = createUserStore(mock.client)
  })

  describe("upsert", () => {
    it("should insert a user and return it with timestamps", async () => {
      mock.execute.mockResolvedValueOnce({})

      const input = {
        id: "12345",
        githubLogin: "malin",
        name: "Malin",
        email: "malin@bloomer.se",
        avatarUrl: "https://avatars.githubusercontent.com/u/12345",
        accessToken: "gho_abc123",
        tokenScopes: "read:user,repo",
      }

      const result = await store.upsert(input)

      expect(mock.execute).toHaveBeenCalledOnce()
      expect(result.id).toBe("12345")
      expect(result.githubLogin).toBe("malin")
      expect(result.name).toBe("Malin")
      expect(result.email).toBe("malin@bloomer.se")
      expect(result.avatarUrl).toBe("https://avatars.githubusercontent.com/u/12345")
      expect(result.accessToken).toBe("gho_abc123")
      expect(result.tokenScopes).toBe("read:user,repo")
      expect(result.createdAt).toBeInstanceOf(Date)
      expect(result.updatedAt).toBeInstanceOf(Date)
    })

    it("should handle null optional fields", async () => {
      mock.execute.mockResolvedValueOnce({})

      const result = await store.upsert({
        id: "12345",
        githubLogin: "malin",
        name: null,
        email: null,
        avatarUrl: null,
        accessToken: "gho_abc123",
        tokenScopes: "read:user",
      })

      expect(result.name).toBeNull()
      expect(result.email).toBeNull()
      expect(result.avatarUrl).toBeNull()
    })

    it("should execute INSERT INTO users query", async () => {
      mock.execute.mockResolvedValueOnce({})

      await store.upsert({
        id: "12345",
        githubLogin: "malin",
        name: "Malin",
        email: null,
        avatarUrl: null,
        accessToken: "gho_abc123",
        tokenScopes: "read:user",
      })

      const query = mock.execute.mock.calls[0][0]
      expect(query).toContain("INSERT INTO users")
      expect(query).toContain("github_login")
      expect(query).toContain("access_token")
      expect(query).toContain("token_scopes")
    })

    it("should pass all fields as CQL params", async () => {
      mock.execute.mockResolvedValueOnce({})

      await store.upsert({
        id: "12345",
        githubLogin: "malin",
        name: "Malin",
        email: "malin@bloomer.se",
        avatarUrl: "https://example.com/avatar.png",
        accessToken: "gho_token",
        tokenScopes: "read:user,repo",
      })

      const params = mock.execute.mock.calls[0][1]
      expect(params).toContain("12345")
      expect(params).toContain("malin")
      expect(params).toContain("Malin")
      expect(params).toContain("malin@bloomer.se")
      expect(params).toContain("gho_token")
      expect(params).toContain("read:user,repo")
    })
  })

  describe("findById", () => {
    it("should return user when found", async () => {
      const now = new Date()
      mock.execute.mockResolvedValueOnce({
        first: () => createMockRow({
          id: "12345",
          github_login: "malin",
          name: "Malin",
          email: "malin@bloomer.se",
          avatar_url: "https://example.com/avatar.png",
          access_token: "gho_abc123",
          token_scopes: "read:user,repo",
          created_at: now,
          updated_at: now,
        }),
      })

      const result = await store.findById("12345")
      expect(result).not.toBeNull()
      expect(result!.id).toBe("12345")
      expect(result!.githubLogin).toBe("malin")
      expect(result!.name).toBe("Malin")
      expect(result!.email).toBe("malin@bloomer.se")
      expect(result!.avatarUrl).toBe("https://example.com/avatar.png")
      expect(result!.accessToken).toBe("gho_abc123")
      expect(result!.tokenScopes).toBe("read:user,repo")
      expect(result!.createdAt).toBe(now)
      expect(result!.updatedAt).toBe(now)
    })

    it("should return null when not found", async () => {
      mock.execute.mockResolvedValueOnce({ first: () => null })

      const result = await store.findById("nonexistent")
      expect(result).toBeNull()
    })

    it("should handle null optional fields from database", async () => {
      mock.execute.mockResolvedValueOnce({
        first: () => createMockRow({
          id: "12345",
          github_login: "malin",
          name: undefined,
          email: undefined,
          avatar_url: undefined,
          access_token: "gho_abc123",
          token_scopes: "read:user",
          created_at: new Date(),
          updated_at: new Date(),
        }),
      })

      const result = await store.findById("12345")
      expect(result!.name).toBeNull()
      expect(result!.email).toBeNull()
      expect(result!.avatarUrl).toBeNull()
    })

    it("should query by id only", async () => {
      mock.execute.mockResolvedValueOnce({ first: () => null })

      await store.findById("12345")

      const query = mock.execute.mock.calls[0][0]
      expect(query).toContain("WHERE id = ?")
      const params = mock.execute.mock.calls[0][1]
      expect(params).toEqual(["12345"])
    })
  })

  describe("getAccessToken", () => {
    it("should return the access token when user exists", async () => {
      mock.execute.mockResolvedValueOnce({
        first: () => createMockRow({ access_token: "gho_abc123" }),
      })

      const result = await store.getAccessToken("12345")
      expect(result).toBe("gho_abc123")
    })

    it("should return null when user not found", async () => {
      mock.execute.mockResolvedValueOnce({ first: () => null })

      const result = await store.getAccessToken("nonexistent")
      expect(result).toBeNull()
    })

    it("should query only access_token column", async () => {
      mock.execute.mockResolvedValueOnce({ first: () => null })

      await store.getAccessToken("12345")

      const query = mock.execute.mock.calls[0][0]
      expect(query).toContain("SELECT access_token FROM users")
    })
  })
})
