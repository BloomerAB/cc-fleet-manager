#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from "node:fs"
import { join, basename } from "node:path"
import { homedir } from "node:os"

// Config file at ~/.config/cc-fleet/config.json
const CONFIG_PATH = join(homedir(), ".config", "cc-fleet", "config.json")

interface FleetConfig {
  readonly url: string
  readonly token: string
}

const loadConfig = (): FleetConfig | null => {
  try {
    if (!existsSync(CONFIG_PATH)) return null
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as FleetConfig
  } catch {
    return null
  }
}

const fleetRequest = async (config: FleetConfig, path: string, options: RequestInit = {}): Promise<Response> => {
  const response = await fetch(`${config.url}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${config.token}`,
      ...(options.headers as Record<string, string> ?? {}),
    },
  })
  return response
}

// Find the current Claude Code session ID from the CWD
const findCurrentSessionId = (): string | null => {
  const claudeDir = join(homedir(), ".claude", "projects")
  if (!existsSync(claudeDir)) return null

  const cwd = process.cwd()
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-")

  const projectDir = join(claudeDir, encoded)
  if (!existsSync(projectDir)) return null

  // Find the most recently modified JSONL file
  const files = readdirSync(projectDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      name: f,
      path: join(projectDir, f),
      mtime: statSync(join(projectDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)

  if (files.length === 0) return null
  return basename(files[0].name, ".jsonl")
}

const findSessionJsonl = (sessionId: string): string | null => {
  const claudeDir = join(homedir(), ".claude", "projects")
  if (!existsSync(claudeDir)) return null

  for (const dir of readdirSync(claudeDir)) {
    const jsonlPath = join(claudeDir, dir, `${sessionId}.jsonl`)
    if (existsSync(jsonlPath)) {
      return jsonlPath
    }
  }
  return null
}

const server = new McpServer({
  name: "cc-fleet",
  version: "0.1.0",
})

// Tool: Configure Fleet connection
server.tool(
  "fleet_configure",
  "Configure the Fleet connection. Run this first before using other Fleet tools.",
  {
    url: z.string().describe("Fleet URL, e.g. https://fleet.bloomer.se"),
    token: z.string().describe("API token from Fleet Settings page"),
  },
  async ({ url, token }) => {
    const configDir = join(homedir(), ".config", "cc-fleet")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify({ url: url.replace(/\/$/, ""), token }, null, 2))
    return { content: [{ type: "text", text: `Fleet configured: ${url}` }] }
  },
)

// Tool: List Fleet sessions
server.tool(
  "fleet_list",
  "List sessions on CC Fleet",
  {},
  async () => {
    const config = loadConfig()
    if (!config) {
      return { content: [{ type: "text", text: "Fleet not configured. Use fleet_configure first." }] }
    }

    const response = await fleetRequest(config, "/api/tasks?page=1&limit=20")
    if (!response.ok) {
      return { content: [{ type: "text", text: `Failed: ${response.status}` }] }
    }

    const data = await response.json() as { data: readonly { id: string; prompt: string; status: string; cliSessionId: string | null }[] }
    const lines = data.data.map((s) =>
      `${s.id.slice(0, 8)} [${s.status}] ${s.prompt.slice(0, 80)}${s.cliSessionId ? ` (cli: ${s.cliSessionId.slice(0, 8)})` : ""}`,
    )

    return { content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No sessions found" }] }
  },
)

// Tool: Push current session to Fleet
server.tool(
  "fleet_push",
  "Push the current local Claude Code session to CC Fleet so you can continue it there",
  {
    sessionId: z.string().optional().describe("Session ID to push. If omitted, pushes the most recent session in the current directory."),
  },
  async ({ sessionId }) => {
    const config = loadConfig()
    if (!config) {
      return { content: [{ type: "text", text: "Fleet not configured. Use fleet_configure first." }] }
    }

    const id = sessionId ?? findCurrentSessionId()
    if (!id) {
      return { content: [{ type: "text", text: "No session found in current directory. Specify a sessionId." }] }
    }

    const jsonlPath = findSessionJsonl(id)
    if (!jsonlPath) {
      return { content: [{ type: "text", text: `Session file not found for ${id}` }] }
    }

    const jsonl = readFileSync(jsonlPath, "utf-8")

    const response = await fleetRequest(config, "/api/tasks/import", {
      method: "POST",
      body: JSON.stringify({ jsonl }),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({})) as { error?: string }
      return { content: [{ type: "text", text: `Push failed: ${err.error ?? response.status}` }] }
    }

    const result = await response.json() as { data: { id: string; cliSessionId: string } }
    return {
      content: [{
        type: "text",
        text: `Session pushed to Fleet.\nFleet session: ${result.data.id}\nOpen: ${config.url}/tasks/${result.data.id}\n\nYou can resume this session on Fleet.`,
      }],
    }
  },
)

// Tool: Pull a Fleet session to local
server.tool(
  "fleet_pull",
  "Pull a session from CC Fleet to continue it locally",
  {
    sessionId: z.string().describe("Fleet session ID (short or full UUID) to pull"),
  },
  async ({ sessionId }) => {
    const config = loadConfig()
    if (!config) {
      return { content: [{ type: "text", text: "Fleet not configured. Use fleet_configure first." }] }
    }

    // Get the session to find the CLI session ID
    const taskResponse = await fleetRequest(config, `/api/tasks/${sessionId}`)
    if (!taskResponse.ok) {
      return { content: [{ type: "text", text: `Session not found: ${sessionId}` }] }
    }

    const task = await taskResponse.json() as { data: { cliSessionId: string | null } }
    if (!task.data.cliSessionId) {
      return { content: [{ type: "text", text: "Session has no CLI session ID — can't pull" }] }
    }

    // Export the JSONL
    const exportResponse = await fleetRequest(config, `/api/tasks/${sessionId}/export`)
    if (!exportResponse.ok) {
      const err = await exportResponse.json().catch(() => ({})) as { error?: string }
      return { content: [{ type: "text", text: `Export failed: ${err.error ?? exportResponse.status}` }] }
    }

    const jsonl = await exportResponse.text()

    // Save to local Claude projects dir
    const cwd = process.cwd()
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-")
    const projectDir = join(homedir(), ".claude", "projects", encoded)
    mkdirSync(projectDir, { recursive: true })

    const jsonlPath = join(projectDir, `${task.data.cliSessionId}.jsonl`)
    writeFileSync(jsonlPath, jsonl)

    return {
      content: [{
        type: "text",
        text: `Session pulled from Fleet.\nSaved to: ${jsonlPath}\n\nResume with:\n  claude --resume ${task.data.cliSessionId}`,
      }],
    }
  },
)

const main = async () => {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error("Fatal:", error)
  process.exit(1)
})
