import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { Env } from "../env.js"
import crypto from "node:crypto"

const callbackSchema = z.object({
  code: z.string(),
  state: z.string(),
})

// In-memory state store (sufficient for single-instance MVP; use Redis for multi-replica)
const pendingStates = new Map<string, { createdAt: number }>()

export function registerAuthRoutes(app: FastifyInstance, env: Env) {
  // Initiate GitHub OIDC login
  app.get("/api/auth/github", async (_request, reply) => {
    const state = crypto.randomBytes(16).toString("hex")
    pendingStates.set(state, { createdAt: Date.now() })

    // Clean up old states (> 10 min)
    const cutoff = Date.now() - 10 * 60 * 1000
    for (const [key, val] of pendingStates) {
      if (val.createdAt < cutoff) pendingStates.delete(key)
    }

    const params = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: `${env.CORS_ORIGIN}/auth/callback`,
      scope: "read:user",
      state,
    })

    return reply.redirect(`https://github.com/login/oauth/authorize?${params}`)
  })

  // GitHub OAuth callback — exchange code for token, fetch user, issue JWT
  app.post("/api/auth/github/callback", async (request, reply) => {
    const body = callbackSchema.parse(request.body)

    // Validate state
    if (!pendingStates.has(body.state)) {
      return reply.status(400).send({ success: false, error: "Invalid state parameter" })
    }
    pendingStates.delete(body.state)

    // Exchange code for GitHub access token
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code: body.code,
      }),
    })

    const tokenData = (await tokenResponse.json()) as {
      access_token?: string
      error?: string
    }

    if (!tokenData.access_token) {
      return reply.status(400).send({
        success: false,
        error: `GitHub OAuth failed: ${tokenData.error ?? "unknown"}`,
      })
    }

    // Fetch GitHub user profile
    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github+json",
      },
    })

    if (!userResponse.ok) {
      return reply.status(500).send({ success: false, error: "Failed to fetch GitHub user" })
    }

    const ghUser = (await userResponse.json()) as {
      id: number
      login: string
      avatar_url: string
    }

    // Issue our own JWT
    const token = app.jwt.sign(
      {
        sub: String(ghUser.id),
        login: ghUser.login,
        avatarUrl: ghUser.avatar_url,
      },
      { expiresIn: "7d" }
    )

    return {
      success: true,
      data: {
        token,
        user: {
          id: String(ghUser.id),
          login: ghUser.login,
          avatarUrl: ghUser.avatar_url,
        },
      },
    }
  })
}
