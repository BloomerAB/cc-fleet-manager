import type { Client } from "cassandra-driver"

interface User {
  readonly id: string
  readonly githubLogin: string
  readonly name: string | null
  readonly email: string | null
  readonly avatarUrl: string | null
  readonly accessToken: string
  readonly tokenScopes: string
  readonly anthropicApiKey: string | null
  readonly rules: string | null
  readonly claudeSettings: string | null
  readonly kubeconfig: string | null
  readonly customPipelines: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface UpsertUserInput {
  readonly id: string
  readonly githubLogin: string
  readonly name: string | null
  readonly email: string | null
  readonly avatarUrl: string | null
  readonly accessToken: string
  readonly tokenScopes: string
}

const createUserStore = (client: Client) => ({
  upsert: async (input: UpsertUserInput): Promise<User> => {
    const now = new Date()

    // Use IF NOT EXISTS for anthropic_api_key to preserve existing value on re-login
    await client.execute(
      `INSERT INTO users (id, github_login, name, email, avatar_url, access_token, token_scopes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.githubLogin,
        input.name,
        input.email,
        input.avatarUrl,
        input.accessToken,
        input.tokenScopes,
        now,
        now,
      ],
      { prepare: true },
    )

    // Fetch to get current anthropic_api_key (preserved from previous session)
    const existing = await client.execute(
      "SELECT anthropic_api_key, rules, claude_settings, kubeconfig, custom_pipelines FROM users WHERE id = ?",
      [input.id],
      { prepare: true },
    )

    return {
      ...input,
      anthropicApiKey: existing.first()?.anthropic_api_key ?? null,
      rules: existing.first()?.rules ?? null,
      claudeSettings: existing.first()?.claude_settings ?? null,
      kubeconfig: existing.first()?.kubeconfig ?? null,
      customPipelines: existing.first()?.custom_pipelines ?? null,
      createdAt: now,
      updatedAt: now,
    }
  },

  findById: async (id: string): Promise<User | null> => {
    const result = await client.execute(
      "SELECT * FROM users WHERE id = ?",
      [id],
      { prepare: true },
    )
    const row = result.first()
    if (!row) return null

    return {
      id: row.id,
      githubLogin: row.github_login,
      name: row.name ?? null,
      email: row.email ?? null,
      avatarUrl: row.avatar_url ?? null,
      accessToken: row.access_token,
      tokenScopes: row.token_scopes,
      anthropicApiKey: row.anthropic_api_key ?? null,
      rules: row.rules ?? null,
      claudeSettings: row.claude_settings ?? null,
      kubeconfig: row.kubeconfig ?? null,
      customPipelines: row.custom_pipelines ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  },

  getAccessToken: async (userId: string): Promise<string | null> => {
    const result = await client.execute(
      "SELECT access_token FROM users WHERE id = ?",
      [userId],
      { prepare: true },
    )
    const row = result.first()
    return row?.access_token ?? null
  },

  getAnthropicApiKey: async (userId: string): Promise<string | null> => {
    const result = await client.execute(
      "SELECT anthropic_api_key FROM users WHERE id = ?",
      [userId],
      { prepare: true },
    )
    const row = result.first()
    return row?.anthropic_api_key ?? null
  },

  setAnthropicApiKey: async (userId: string, apiKey: string | null): Promise<void> => {
    await client.execute(
      "UPDATE users SET anthropic_api_key = ?, updated_at = ? WHERE id = ?",
      [apiKey, new Date(), userId],
      { prepare: true },
    )
  },

  getRules: async (userId: string): Promise<string | null> => {
    const result = await client.execute(
      "SELECT rules FROM users WHERE id = ?",
      [userId],
      { prepare: true },
    )
    const row = result.first()
    return row?.rules ?? null
  },

  setRules: async (userId: string, rules: string | null): Promise<void> => {
    await client.execute(
      "UPDATE users SET rules = ?, updated_at = ? WHERE id = ?",
      [rules, new Date(), userId],
      { prepare: true },
    )
  },

  getClaudeSettings: async (userId: string): Promise<string | null> => {
    const result = await client.execute(
      "SELECT claude_settings FROM users WHERE id = ?",
      [userId],
      { prepare: true },
    )
    const row = result.first()
    return row?.claude_settings ?? null
  },

  setClaudeSettings: async (userId: string, settings: string | null): Promise<void> => {
    await client.execute(
      "UPDATE users SET claude_settings = ?, updated_at = ? WHERE id = ?",
      [settings, new Date(), userId],
      { prepare: true },
    )
  },

  getKubeconfig: async (userId: string): Promise<string | null> => {
    const result = await client.execute(
      "SELECT kubeconfig FROM users WHERE id = ?",
      [userId],
      { prepare: true },
    )
    const row = result.first()
    return row?.kubeconfig ?? null
  },

  setKubeconfig: async (userId: string, kubeconfig: string | null): Promise<void> => {
    await client.execute(
      "UPDATE users SET kubeconfig = ?, updated_at = ? WHERE id = ?",
      [kubeconfig, new Date(), userId],
      { prepare: true },
    )
  },

  getCustomPipelines: async (userId: string): Promise<string | null> => {
    const result = await client.execute(
      "SELECT custom_pipelines FROM users WHERE id = ?",
      [userId],
      { prepare: true },
    )
    const row = result.first()
    return row?.custom_pipelines ?? null
  },

  setCustomPipelines: async (userId: string, pipelines: string | null): Promise<void> => {
    await client.execute(
      "UPDATE users SET custom_pipelines = ?, updated_at = ? WHERE id = ?",
      [pipelines, new Date(), userId],
      { prepare: true },
    )
  },
})

type UserStore = ReturnType<typeof createUserStore>

export { type User, type UpsertUserInput, type UserStore, createUserStore }
