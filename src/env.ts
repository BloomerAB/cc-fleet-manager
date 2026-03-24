import { z } from "zod"

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  SCYLLA_HOST: z.string().default("scylla"),
  SCYLLA_PORT: z.coerce.number().default(9042),
  SCYLLA_DATACENTER: z.string().default("datacenter1"),
  SCYLLA_KEYSPACE: z.string().default("cc_fleet"),
  SCYLLA_USERNAME: z.string().optional(),
  SCYLLA_PASSWORD: z.string().optional(),
  JWT_SECRET: z.string(),
  GITHUB_CLIENT_ID: z.string(),
  GITHUB_CLIENT_SECRET: z.string(),
  GITHUB_SCOPES: z.string().default("read:user,repo"),
  GIT_TOKEN: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  MAX_CONCURRENT_TASKS: z.coerce.number().int().min(1).default(5),
  WORKSPACE_BASE_DIR: z.string().default("/tmp/cc-fleet-workspaces"),
  ALLOWED_REPOS: z.string().default(""),
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
