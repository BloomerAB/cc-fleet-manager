import type { Env } from "../env.js"

interface GitHubAppToken {
  readonly token: string
  readonly expiresAt: string
}

export function createGitHubAppService(env: Env) {
  let cachedToken: GitHubAppToken | null = null

  function createJwt(): string {
    // GitHub App JWT — iat, exp, iss
    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
    const payload = Buffer.from(
      JSON.stringify({
        iat: now - 60,
        exp: now + 600,
        iss: env.GITHUB_APP_ID,
      })
    ).toString("base64url")

    // Sign with private key using Node.js crypto
    const crypto = require("node:crypto")
    const sign = crypto.createSign("RSA-SHA256")
    sign.update(`${header}.${payload}`)
    const signature = sign.sign(env.GITHUB_APP_PRIVATE_KEY, "base64url")

    return `${header}.${payload}.${signature}`
  }

  return {
    async getInstallationToken(): Promise<string> {
      // Return cached token if still valid (refresh at 45 min)
      if (cachedToken) {
        const expiresAt = new Date(cachedToken.expiresAt).getTime()
        const refreshAt = expiresAt - 15 * 60 * 1000 // 15 min before expiry
        if (Date.now() < refreshAt) {
          return cachedToken.token
        }
      }

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
    },
  }
}

export type GitHubAppService = ReturnType<typeof createGitHubAppService>
