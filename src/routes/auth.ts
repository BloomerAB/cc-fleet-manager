import type { FastifyInstance } from "fastify"
import crypto from "node:crypto"
import type { Env } from "../env.js"
import type { UserStore } from "../services/user-store.js"

const STATE_TTL_MS = 10 * 60 * 1000
const STATE_BYTES = 16
const JWT_EXPIRY = "7d"

const pendingStates = new Map<string, { readonly createdAt: number }>()

const cleanupExpiredStates = () => {
  const cutoff = Date.now() - STATE_TTL_MS
  for (const [key, val] of pendingStates) {
    if (val.createdAt < cutoff) pendingStates.delete(key)
  }
}

const registerAuthRoutes = (app: FastifyInstance, env: Env, userStore: UserStore) => {
  // Initiate GitHub OAuth login
  app.get("/api/auth/login", async (_request, reply) => {
    const state = crypto.randomBytes(STATE_BYTES).toString("hex")
    pendingStates.set(state, { createdAt: Date.now() })
    cleanupExpiredStates()

    const params = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: `${env.CORS_ORIGIN}/api/auth/callback`,
      scope: env.GITHUB_SCOPES,
      state,
    })

    return reply.redirect(`https://github.com/login/oauth/authorize?${params}`)
  })

  // GitHub OAuth callback — exchange code, store tokens, redirect with JWT
  app.get("/api/auth/callback", async (request, reply) => {
    const { code, state } = request.query as Record<string, string>

    if (!code || !state || !pendingStates.has(state)) {
      return reply.redirect("/#error=invalid_state")
    }
    pendingStates.delete(state)

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
        code,
      }),
    })

    const tokenData = (await tokenResponse.json()) as {
      access_token?: string
      scope?: string
      error?: string
    }

    if (!tokenData.access_token) {
      return reply.redirect("/#error=github_auth_failed")
    }

    // Fetch GitHub user profile
    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github+json",
      },
    })

    if (!userResponse.ok) {
      return reply.redirect("/#error=github_user_fetch_failed")
    }

    const ghUser = (await userResponse.json()) as {
      id: number
      login: string
      name: string | null
      email: string | null
      avatar_url: string
    }

    // Store/update user with access token
    await userStore.upsert({
      id: String(ghUser.id),
      githubLogin: ghUser.login,
      name: ghUser.name,
      email: ghUser.email,
      avatarUrl: ghUser.avatar_url,
      accessToken: tokenData.access_token,
      tokenScopes: tokenData.scope ?? "",
    })

    // Issue app JWT
    const token = app.jwt.sign(
      {
        sub: String(ghUser.id),
        login: ghUser.login,
        name: ghUser.name ?? ghUser.login,
        picture: ghUser.avatar_url,
      },
      { expiresIn: JWT_EXPIRY },
    )

    return reply.redirect(`/#token=${token}`)
  })

  // Logout — stateless JWT, client clears token
  app.post("/api/auth/logout", async () => {
    return { success: true }
  })
}

export { registerAuthRoutes }
