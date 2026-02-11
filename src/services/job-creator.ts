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

export function createJobCreator(env: Env) {
  const kc = new k8s.KubeConfig()
  kc.loadFromDefault()
  const batchApi = kc.makeApiClient(k8s.BatchV1Api)

  return {
    async createRunnerJob(config: JobConfig): Promise<string> {
      const jobName = `claude-runner-${config.sessionId.slice(0, 8)}`

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
          ttlSecondsAfterFinished: 3600,
          backoffLimit: 0,
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
                    `git clone --depth 1 ${config.repoBranch ? `--branch ${config.repoBranch}` : ""} https://x-access-token:${config.githubToken}@${config.repoUrl.replace("https://", "")} /workspace`,
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
                    {
                      name: "GITHUB_TOKEN",
                      value: config.githubToken,
                    },
                  ],
                  volumeMounts: [
                    { name: "workspace", mountPath: "/workspace" },
                  ],
                  resources: {
                    requests: { cpu: "500m", memory: "512Mi" },
                    limits: { cpu: "2", memory: "2Gi" },
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

    async deleteJob(jobName: string): Promise<void> {
      await batchApi.deleteNamespacedJob({
        name: jobName,
        namespace: env.RUNNER_NAMESPACE,
        body: { propagationPolicy: "Background" },
      })
    },

    async getJobStatus(jobName: string) {
      const response = await batchApi.readNamespacedJob({
        name: jobName,
        namespace: env.RUNNER_NAMESPACE,
      })
      const job = response
      return {
        active: job.status?.active ?? 0,
        succeeded: job.status?.succeeded ?? 0,
        failed: job.status?.failed ?? 0,
      }
    },
  }
}

export type JobCreator = ReturnType<typeof createJobCreator>
