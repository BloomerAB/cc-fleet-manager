import { readdir, readFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { Client } from "cassandra-driver"

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, "migrations")

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

const parseMigrationVersion = (filename: string): number | null => {
  const match = filename.match(/^(\d+)_/)
  return match ? parseInt(match[1], 10) : null
}

const runMigrations = async (client: Client): Promise<void> => {
  await ensureVersionTable(client)
  const applied = await getAppliedVersions(client)

  const files = await readdir(MIGRATIONS_DIR).catch(() => [] as string[])
  const cqlFiles = files.filter((f) => f.endsWith(".cql")).sort()

  for (const file of cqlFiles) {
    const version = parseMigrationVersion(file)
    if (version === null || applied.has(version)) continue

    const content = await readFile(join(MIGRATIONS_DIR, file), "utf-8")
    const statements = content
      .split(";")
      .map((s) => s.replace(/--.*$/gm, "").trim())
      .filter(Boolean)

    for (const statement of statements) {
      try {
        await client.execute(statement)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Safe to ignore "already exists" — migration may have partially applied
        if (!message.includes("already exists") && !message.includes("conflicts with")) {
          throw new Error(`Migration ${file} failed: ${message}`, { cause: error })
        }
      }
    }

    await client.execute(
      "INSERT INTO schema_version (version, filename, applied_at) VALUES (?, ?, ?)",
      [version, file, new Date()],
      { prepare: true },
    )
  }
}

export { runMigrations }
