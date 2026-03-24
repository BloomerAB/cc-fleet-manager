import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { UserStore } from "../services/user-store.js"

interface JwtPayload {
  readonly sub: string
}

const updateSettingsSchema = z.object({
  anthropicApiKey: z.string().min(1).optional(),
})

const registerSettingsRoutes = (app: FastifyInstance, userStore: UserStore) => {
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
        hasAnthropicKey: dbUser?.anthropicApiKey !== null && dbUser?.anthropicApiKey !== undefined,
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
