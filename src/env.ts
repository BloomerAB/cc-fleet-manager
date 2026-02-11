import { z } from "zod"

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string(),
  GITHUB_CLIENT_ID: z.string(),
  GITHUB_CLIENT_SECRET: z.string(),
  GITHUB_APP_ID: z.string(),
  GITHUB_APP_PRIVATE_KEY: z.string(),
  GITHUB_APP_INSTALLATION_ID: z.string(),
  RUNNER_IMAGE: z.string().default("ghcr.io/bloomer-ab/claude-agent-runner:latest"),
  RUNNER_NAMESPACE: z.string().default("claude-platform"),
  ANTHROPIC_API_KEY: z.string(),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
})

type Env = z.infer<typeof envSchema>

const loadEnv = (): Env => {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join(".")).join(", ")
    throw new Error(`Missing environment variables: ${missing}`)
  }
  return result.data
}

export { type Env, loadEnv }
