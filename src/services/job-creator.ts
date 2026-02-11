import * as k8s from "@kubernetes/client-node"
import type { Env } from "../env.js"

interface JobConfig {
  readonly sessionId: string
  readonly userId: string
  readonly prompt: string
  readonly repoUrl: string
  readonly repoBranch?: string
  readonly maxTurns: number
  readonly maxBudgetUsd: number
  readonly deadlineSeconds: number
  readonly managerWsUrl: string
  readonly githubToken: string
}

const TTL_AFTER_FINISHED_SECONDS = 3600
const BACKOFF_LIMIT = 0
const CPU_REQUEST = "500m"
const MEMORY_REQUEST = "512Mi"
const CPU_LIMIT = "2"
const MEMORY_LIMIT = "2Gi"
const SESSION_ID_SLUG_LENGTH = 8

const createJobCreator = (env: Env) => {
  const kc = new k8s.KubeConfig()
  kc.loadFromDefault()
  const batchApi = kc.makeApiClient(k8s.BatchV1Api)

  return {
    createRunnerJob: async (config: JobConfig): Promise<string> => {
      const jobName = `claude-runner-${config.sessionId.slice(0, SESSION_ID_SLUG_LENGTH)}`
      const branchArg = config.repoBranch ? `--branch ${config.repoBranch}` : ""

      const job: k8s.V1Job = {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: jobName,
          namespace: env.RUNNER_NAMESPACE,
          labels: {
            app: "claude-runner",
            "session-id": config.sessionId,
            "user-id": config.userId,
          },
        },
        spec: {
          activeDeadlineSeconds: config.deadlineSeconds,
          ttlSecondsAfterFinished: TTL_AFTER_FINISHED_SECONDS,
          backoffLimit: BACKOFF_LIMIT,
          template: {
            metadata: {
              labels: {
                app: "claude-runner",
                "session-id": config.sessionId,
              },
            },
            spec: {
              restartPolicy: "Never",
              initContainers: [
                {
                  name: "clone-repo",
                  image: "alpine/git:latest",
                  command: ["sh", "-c"],
                  args: [
                    // Token passed via env var, not in URL
                    `git clone --depth 1 ${branchArg} https://x-access-token:$GIT_TOKEN@${config.repoUrl.replace("https://", "")} /workspace`,
                  ],
                  env: [
                    { name: "GIT_TOKEN", value: config.githubToken },
                  ],
                  volumeMounts: [
                    { name: "workspace", mountPath: "/workspace" },
                  ],
                },
              ],
              containers: [
                {
                  name: "runner",
                  image: env.RUNNER_IMAGE,
                  env: [
                    { name: "SESSION_ID", value: config.sessionId },
                    { name: "PROMPT", value: config.prompt },
                    { name: "MAX_TURNS", value: String(config.maxTurns) },
                    { name: "MAX_BUDGET_USD", value: String(config.maxBudgetUsd) },
                    { name: "MANAGER_WS_URL", value: config.managerWsUrl },
                    { name: "REPO_URL", value: config.repoUrl },
                    {
                      name: "ANTHROPIC_API_KEY",
                      valueFrom: {
                        secretKeyRef: {
                          name: "anthropic-api-key",
                          key: "api-key",
                        },
                      },
                    },
                    { name: "GITHUB_TOKEN", value: config.githubToken },
                  ],
                  volumeMounts: [
                    { name: "workspace", mountPath: "/workspace" },
                  ],
                  resources: {
                    requests: { cpu: CPU_REQUEST, memory: MEMORY_REQUEST },
                    limits: { cpu: CPU_LIMIT, memory: MEMORY_LIMIT },
                  },
                },
              ],
              volumes: [
                { name: "workspace", emptyDir: {} },
              ],
            },
          },
        },
      }

      await batchApi.createNamespacedJob({
        namespace: env.RUNNER_NAMESPACE,
        body: job,
      })

      return jobName
    },

    deleteJob: async (jobName: string): Promise<void> => {
      await batchApi.deleteNamespacedJob({
        name: jobName,
        namespace: env.RUNNER_NAMESPACE,
        body: { propagationPolicy: "Background" },
      })
    },

    getJobStatus: async (jobName: string) => {
      const response = await batchApi.readNamespacedJob({
        name: jobName,
        namespace: env.RUNNER_NAMESPACE,
      })
      return {
        active: response.status?.active ?? 0,
        succeeded: response.status?.succeeded ?? 0,
        failed: response.status?.failed ?? 0,
      }
    },
  }
}

type JobCreator = ReturnType<typeof createJobCreator>

export { type JobConfig, type JobCreator, createJobCreator }
