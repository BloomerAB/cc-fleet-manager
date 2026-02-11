import crypto from "node:crypto"
import type { Env } from "../env.js"

interface GitHubAppToken {
  readonly token: string
  readonly expiresAt: string
}

const REFRESH_BUFFER_MS = 15 * 60 * 1000
const JWT_CLOCK_SKEW_SECONDS = 60
const JWT_EXPIRY_SECONDS = 600

const createGitHubAppService = (env: Env) => {
  let cachedToken: GitHubAppToken | null = null
  let pendingRequest: Promise<string> | null = null

  const createJwt = (): string => {
    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
    const payload = Buffer.from(
      JSON.stringify({
        iat: now - JWT_CLOCK_SKEW_SECONDS,
        exp: now + JWT_EXPIRY_SECONDS,
        iss: env.GITHUB_APP_ID,
      })
    ).toString("base64url")

    const sign = crypto.createSign("RSA-SHA256")
    sign.update(`${header}.${payload}`)
    const signature = sign.sign(env.GITHUB_APP_PRIVATE_KEY, "base64url")

    return `${header}.${payload}.${signature}`
  }

  const fetchToken = async (): Promise<string> => {
    const jwt = createJwt()
    const response = await fetch(
      `https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    )

    if (!response.ok) {
      throw new Error(`GitHub App token request failed: ${response.status} ${await response.text()}`)
    }

    const data = (await response.json()) as { token: string; expires_at: string }
    cachedToken = { token: data.token, expiresAt: data.expires_at }
    return data.token
  }

  return {
    getInstallationToken: async (): Promise<string> => {
      if (cachedToken) {
        const expiresAt = new Date(cachedToken.expiresAt).getTime()
        const refreshAt = expiresAt - REFRESH_BUFFER_MS
        if (Date.now() < refreshAt) {
          return cachedToken.token
        }
      }

      // Single-flight: deduplicate concurrent token requests
      if (pendingRequest) {
        return pendingRequest
      }

      pendingRequest = fetchToken().finally(() => {
        pendingRequest = null
      })

      return pendingRequest
    },
  }
}

type GitHubAppService = ReturnType<typeof createGitHubAppService>

export { type GitHubAppService, createGitHubAppService }
