import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { UserStore } from "../services/user-store.js"
import type { Env } from "../env.js"

interface JwtPayload {
  readonly sub: string
}

const updateSettingsSchema = z.object({
  anthropicApiKey: z.string().min(1).optional(),
  rules: z.string().max(10000).optional(),
  claudeSettings: z.string().max(10000).optional(),
  kubeconfig: z.string().max(50000).optional(),
})

const registerSettingsRoutes = (app: FastifyInstance, env: Env, userStore: UserStore) => {
  // Auth hook
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/settings")) {
      try {
        await request.jwtVerify()
      } catch {
        return reply.status(401).send({ success: false, error: "Unauthorized" })
      }
    }
  })

  // GET /api/settings — get current user settings
  app.get("/api/settings", async (request) => {
    const user = request.user as JwtPayload
    const dbUser = await userStore.findById(user.sub)

    return {
      success: true,
      data: {
        authMode: env.AUTH_MODE,
        hasAnthropicKey: dbUser?.anthropicApiKey !== null && dbUser?.anthropicApiKey !== undefined,
        rules: dbUser?.rules ?? "",
        claudeSettings: dbUser?.claudeSettings ?? "",
        hasKubeconfig: dbUser?.kubeconfig !== null && dbUser?.kubeconfig !== undefined,
      },
    }
  })

  // PUT /api/settings — update user settings
  app.put("/api/settings", async (request) => {
    const user = request.user as JwtPayload
    const body = updateSettingsSchema.parse(request.body)

    if (body.anthropicApiKey !== undefined) {
      await userStore.setAnthropicApiKey(user.sub, body.anthropicApiKey)
    }
    if (body.rules !== undefined) {
      await userStore.setRules(user.sub, body.rules || null)
    }
    if (body.claudeSettings !== undefined) {
      await userStore.setClaudeSettings(user.sub, body.claudeSettings || null)
    }
    if (body.kubeconfig !== undefined) {
      await userStore.setKubeconfig(user.sub, body.kubeconfig || null)
    }

    return { success: true }
  })

  // DELETE /api/settings/anthropic-key — remove user's Anthropic key
  app.delete("/api/settings/anthropic-key", async (request) => {
    const user = request.user as JwtPayload
    await userStore.setAnthropicApiKey(user.sub, null)
    return { success: true }
  })
}

export { registerSettingsRoutes }
