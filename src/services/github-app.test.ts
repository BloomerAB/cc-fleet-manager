import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createGitHubAppService } from "./github-app.js"
import type { Env } from "../env.js"
import crypto from "node:crypto"

// Generate a real RSA key pair for testing JWT signing
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
})

const createMockEnv = (overrides: Partial<Env> = {}): Env => ({
  PORT: 3000,
  HOST: "0.0.0.0",
  DATABASE_URL: "postgresql://localhost/test",
  JWT_SECRET: "test-secret",
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_APP_INSTALLATION_ID: "67890",
  RUNNER_IMAGE: "ghcr.io/bloomer-ab/claude-agent-runner:latest",
  RUNNER_NAMESPACE: "claude-platform",
  ANTHROPIC_API_KEY: "sk-ant-test",
  CORS_ORIGIN: "http://localhost:5173",
  ...overrides,
})

describe("createGitHubAppService", () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const mockFetchSuccess = (token: string, expiresAt: string) => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ token, expires_at: expiresAt }),
    })
  }

  const mockFetchFailure = (status: number, body: string) => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status,
      text: () => Promise.resolve(body),
    })
  }

  describe("getInstallationToken", () => {
    it("should fetch a new token when none is cached", async () => {
      const env = createMockEnv()
      const service = createGitHubAppService(env)

      // Token that expires in 1 hour
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      mockFetchSuccess("ghs_test_token_1", expiresAt)

      const token = await service.getInstallationToken()
      expect(token).toBe("ghs_test_token_1")
      expect(fetchSpy).toHaveBeenCalledOnce()

      // Verify the fetch call was made to the correct URL
      const [url, options] = fetchSpy.mock.calls[0]
      expect(url).toBe("https://api.github.com/app/installations/67890/access_tokens")
      expect(options.method).toBe("POST")
      expect(options.headers.Authorization).toMatch(/^Bearer /)
      expect(options.headers.Accept).toBe("application/vnd.github+json")
    })

    it("should return cached token if not near expiry", async () => {
      const env = createMockEnv()
      const service = createGitHubAppService(env)

      // Token that expires in 1 hour (well beyond the 15-minute buffer)
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      mockFetchSuccess("ghs_cached", expiresAt)

      const token1 = await service.getInstallationToken()
      const token2 = await service.getInstallationToken()

      expect(token1).toBe("ghs_cached")
      expect(token2).toBe("ghs_cached")
      expect(fetchSpy).toHaveBeenCalledOnce() // Only one fetch
    })

    it("should refresh token when near expiry (within 15-minute buffer)", async () => {
      const env = createMockEnv()
      const service = createGitHubAppService(env)

      // Token that expires in 10 minutes (within the 15-minute buffer)
      const nearExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString()
      mockFetchSuccess("ghs_short_lived", nearExpiry)

      const token1 = await service.getInstallationToken()
      expect(token1).toBe("ghs_short_lived")

      // Second call should fetch a new token because the cached one is near expiry
      const newExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      mockFetchSuccess("ghs_refreshed", newExpiry)

      const token2 = await service.getInstallationToken()
      expect(token2).toBe("ghs_refreshed")
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it("should deduplicate concurrent token requests (single-flight)", async () => {
      const env = createMockEnv()
      const service = createGitHubAppService(env)

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()

      // Use a delayed fetch response
      let resolveFetch: ((value: unknown) => void) | undefined
      fetchSpy.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFetch = resolve
        }),
      )

      // Fire two concurrent requests
      const p1 = service.getInstallationToken()
      const p2 = service.getInstallationToken()

      // Resolve the single fetch
      resolveFetch!({
        ok: true,
        json: () => Promise.resolve({ token: "ghs_deduped", expires_at: expiresAt }),
      })

      const [t1, t2] = await Promise.all([p1, p2])
      expect(t1).toBe("ghs_deduped")
      expect(t2).toBe("ghs_deduped")
      expect(fetchSpy).toHaveBeenCalledOnce() // Only one fetch for both
    })

    it("should throw on failed fetch", async () => {
      const env = createMockEnv()
      const service = createGitHubAppService(env)

      mockFetchFailure(401, "Bad credentials")

      await expect(service.getInstallationToken()).rejects.toThrow(
        "GitHub App token request failed: 401 Bad credentials",
      )
    })

    it("should retry after a failed request (pendingRequest is cleared)", async () => {
      const env = createMockEnv()
      const service = createGitHubAppService(env)

      // First call fails
      mockFetchFailure(500, "Server error")
      await expect(service.getInstallationToken()).rejects.toThrow()

      // Second call should make a new request (pendingRequest cleared via finally)
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      mockFetchSuccess("ghs_retry_success", expiresAt)

      const token = await service.getInstallationToken()
      expect(token).toBe("ghs_retry_success")
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it("should create a valid JWT with correct claims", async () => {
      const env = createMockEnv()
      const service = createGitHubAppService(env)

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      mockFetchSuccess("ghs_jwt_check", expiresAt)

      await service.getInstallationToken()

      const authHeader = fetchSpy.mock.calls[0][1].headers.Authorization as string
      const jwt = authHeader.replace("Bearer ", "")
      const parts = jwt.split(".")
      expect(parts).toHaveLength(3)

      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString())
      expect(header.alg).toBe("RS256")
      expect(header.typ).toBe("JWT")

      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString())
      expect(payload.iss).toBe("12345")
      expect(payload.exp).toBeGreaterThan(payload.iat)
      // iat should be 60 seconds before now (clock skew)
      const nowSec = Math.floor(Date.now() / 1000)
      expect(payload.iat).toBe(nowSec - 60)
      // exp should be 600 seconds after now
      expect(payload.exp).toBe(nowSec + 600)
    })
  })
})
