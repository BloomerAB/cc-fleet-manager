import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import type { PipelineDefinition } from "../types/index.js"

const stageDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  systemPromptAppend: z.string(),
  permissionMode: z.enum(["plan", "acceptEdits", "bypassPermissions"]),
  transition: z.enum(["auto", "manual"]),
  maxTurns: z.number().int().min(1).optional(),
})

const pipelineDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  stages: z.array(stageDefinitionSchema).min(1),
})

const DEFAULT_PIPELINE_ID = "default"

const createPipelineRegistry = (
  pipelinesDir: string = join(import.meta.dirname, "../../pipelines"),
) => {
  const pipelines = new Map<string, PipelineDefinition>()

  const files = readdirSync(pipelinesDir).filter((f) => f.endsWith(".json"))

  for (const file of files) {
    const raw = readFileSync(join(pipelinesDir, file), "utf-8")
    const parsed = pipelineDefinitionSchema.parse(JSON.parse(raw))
    pipelines.set(parsed.id, parsed)
  }

  if (pipelines.size === 0) {
    throw new Error(`No pipeline definitions found in ${pipelinesDir}`)
  }

  return {
    getAll: (): readonly PipelineDefinition[] => [...pipelines.values()],

    getById: (id: string): PipelineDefinition | undefined => pipelines.get(id),

    getDefault: (): PipelineDefinition => {
      const def = pipelines.get(DEFAULT_PIPELINE_ID)
      if (!def) {
        // Fall back to first pipeline if no "default" exists
        return pipelines.values().next().value!
      }
      return def
    },
  }
}

type PipelineRegistry = ReturnType<typeof createPipelineRegistry>

export { type PipelineRegistry, createPipelineRegistry }
