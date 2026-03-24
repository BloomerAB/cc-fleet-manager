import type { Client } from "cassandra-driver"

interface User {
  readonly id: string
  readonly githubLogin: string
  readonly name: string | null
  readonly email: string | null
  readonly avatarUrl: string | null
  readonly accessToken: string
  readonly tokenScopes: string
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

    return {
      ...input,
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
})

type UserStore = ReturnType<typeof createUserStore>

export { type User, type UpsertUserInput, type UserStore, createUserStore }
