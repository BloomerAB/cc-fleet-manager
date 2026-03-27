import type { Client } from "cassandra-driver"

interface Migration {
  readonly version: number
  readonly name: string
  readonly statements: readonly string[]
}

// Add new migrations at the end. Never modify or remove existing ones.
const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "001_add_repo_source",
    statements: ["ALTER TABLE sessions ADD repo_source TEXT"],
  },
  {
    version: 2,
    name: "002_add_rules",
    statements: [
      "ALTER TABLE users ADD rules TEXT",
      "ALTER TABLE sessions ADD rules TEXT",
    ],
  },
  {
    version: 3,
    name: "003_add_permission_mode_and_model",
    statements: [
      "ALTER TABLE sessions ADD permission_mode TEXT",
      "ALTER TABLE sessions ADD model TEXT",
      "ALTER TABLE sessions ADD cli_session_id TEXT",
    ],
  },
  {
    version: 4,
    name: "004_add_claude_settings",
    statements: [
      "ALTER TABLE users ADD claude_settings TEXT",
    ],
  },
  {
    version: 5,
    name: "005_add_kubeconfig",
    statements: [
      "ALTER TABLE users ADD kubeconfig TEXT",
    ],
  },
  {
    version: 6,
    name: "006_add_pipeline_stage",
    statements: [
      "ALTER TABLE sessions ADD pipeline_id TEXT",
      "ALTER TABLE sessions ADD stage_state TEXT",
    ],
  },
]

const ensureVersionTable = async (client: Client): Promise<void> => {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INT,
      filename TEXT,
      applied_at TIMESTAMP,
      PRIMARY KEY (version)
    )
  `)
}

const getAppliedVersions = async (client: Client): Promise<ReadonlySet<number>> => {
  const result = await client.execute("SELECT version FROM schema_version")
  return new Set(result.rows.map((row) => row.version as number))
}

const runMigrations = async (client: Client): Promise<void> => {
  await ensureVersionTable(client)
  const applied = await getAppliedVersions(client)

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue

    for (const statement of migration.statements) {
      try {
        await client.execute(statement)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes("already exists") && !message.includes("conflicts with")) {
          throw new Error(`Migration ${migration.name} failed: ${message}`, { cause: error })
        }
      }
    }

    await client.execute(
      "INSERT INTO schema_version (version, filename, applied_at) VALUES (?, ?, ?)",
      [migration.version, migration.name, new Date()],
      { prepare: true },
    )
  }
}

export { runMigrations }
