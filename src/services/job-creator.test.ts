import { describe, it, expect, vi, beforeEach } from "vitest"

// Use vi.hoisted so these are available inside the hoisted vi.mock factory
const { mockCreateNamespacedJob, mockDeleteNamespacedJob, mockReadNamespacedJob } = vi.hoisted(() => ({
  mockCreateNamespacedJob: vi.fn().mockResolvedValue({}),
  mockDeleteNamespacedJob: vi.fn().mockResolvedValue({}),
  mockReadNamespacedJob: vi.fn().mockResolvedValue({
    status: { active: 1, succeeded: 0, failed: 0 },
  }),
}))

vi.mock("@kubernetes/client-node", () => {
  const MockBatchV1Api = vi.fn()
  MockBatchV1Api.prototype.createNamespacedJob = mockCreateNamespacedJob
  MockBatchV1Api.prototype.deleteNamespacedJob = mockDeleteNamespacedJob
  MockBatchV1Api.prototype.readNamespacedJob = mockReadNamespacedJob

  const MockKubeConfig = vi.fn()
  MockKubeConfig.prototype.loadFromDefault = vi.fn()
  MockKubeConfig.prototype.makeApiClient = vi.fn(() => new MockBatchV1Api())

  return {
    KubeConfig: MockKubeConfig,
    BatchV1Api: MockBatchV1Api,
  }
})

import { createJobCreator } from "./job-creator.js"
import type { Env } from "../env.js"
import type { JobConfig } from "./job-creator.js"

const createMockEnv = (overrides: Partial<Env> = {}): Env => ({
  PORT: 3000,
  HOST: "0.0.0.0",
  DATABASE_URL: "postgresql://localhost/test",
  JWT_SECRET: "test-secret",
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: "private-key",
  GITHUB_APP_INSTALLATION_ID: "67890",
  RUNNER_IMAGE: "ghcr.io/bloomer-ab/claude-agent-runner:latest",
  RUNNER_NAMESPACE: "claude-platform",
  ANTHROPIC_API_KEY: "sk-ant-test",
  CORS_ORIGIN: "http://localhost:5173",
  ...overrides,
})

const createJobConfig = (overrides: Partial<JobConfig> = {}): JobConfig => ({
  sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
  userId: "user-1",
  prompt: "Fix the bug in auth.ts",
  repoUrl: "https://github.com/org/repo",
  maxTurns: 50,
  maxBudgetUsd: 5.0,
  deadlineSeconds: 3600,
  managerWsUrl: "ws://session-manager.claude-platform.svc.cluster.local:3000/ws/runner",
  githubToken: "ghs_test_token",
  ...overrides,
})

describe("createJobCreator", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("createRunnerJob", () => {
    it("should create a K8s Job with correct metadata", async () => {
      const env = createMockEnv()
      const creator = createJobCreator(env)
      const config = createJobConfig()

      const jobName = await creator.createRunnerJob(config)

      expect(jobName).toBe("claude-runner-abcdef12")
      expect(mockCreateNamespacedJob).toHaveBeenCalledOnce()

      const callArgs = mockCreateNamespacedJob.mock.calls[0][0]
      expect(callArgs.namespace).toBe("claude-platform")

      const job = callArgs.body
      expect(job.metadata.name).toBe("claude-runner-abcdef12")
      expect(job.metadata.namespace).toBe("claude-platform")
      expect(job.metadata.labels).toEqual({
        app: "claude-runner",
        "session-id": config.sessionId,
        "user-id": config.userId,
      })
    })

    it("should set correct Job spec fields", async () => {
      const env = createMockEnv()
      const creator = createJobCreator(env)
      const config = createJobConfig({ deadlineSeconds: 7200 })

      await creator.createRunnerJob(config)

      const job = mockCreateNamespacedJob.mock.calls[0][0].body
      expect(job.spec.activeDeadlineSeconds).toBe(7200)
      expect(job.spec.ttlSecondsAfterFinished).toBe(3600)
      expect(job.spec.backoffLimit).toBe(0)
      expect(job.spec.template.spec.restartPolicy).toBe("Never")
    })

    it("should configure init container to clone repo with token via env var", async () => {
      const env = createMockEnv()
      const creator = createJobCreator(env)
      const config = createJobConfig()

      await creator.createRunnerJob(config)

      const job = mockCreateNamespacedJob.mock.calls[0][0].body
      const initContainer = job.spec.template.spec.initContainers[0]

      expect(initContainer.name).toBe("clone-repo")
      expect(initContainer.image).toBe("alpine/git:latest")

      // Token should be in env var, not in the URL
      const gitTokenEnv = initContainer.env.find((e: { name: string }) => e.name === "GIT_TOKEN")
      expect(gitTokenEnv).toBeDefined()
      expect(gitTokenEnv.value).toBe("ghs_test_token")

      // The clone command should use $GIT_TOKEN, not the actual token
      const cloneArg = initContainer.args[0]
      expect(cloneArg).toContain("$GIT_TOKEN")
      expect(cloneArg).not.toContain("ghs_test_token")
    })

    it("should include branch arg when repoBranch is provided", async () => {
      const env = createMockEnv()
      const creator = createJobCreator(env)
      const config = createJobConfig({ repoBranch: "feature/test" })

      await creator.createRunnerJob(config)

      const job = mockCreateNamespacedJob.mock.calls[0][0].body
      const initContainer = job.spec.template.spec.initContainers[0]
      expect(initContainer.args[0]).toContain("--branch feature/test")
    })

    it("should not include branch arg when repoBranch is undefined", async () => {
      const env = createMockEnv()
      const creator = createJobCreator(env)
      const config = createJobConfig({ repoBranch: undefined })

      await creator.createRunnerJob(config)

      const job = mockCreateNamespacedJob.mock.calls[0][0].body
      const initContainer = job.spec.template.spec.initContainers[0]
      expect(initContainer.args[0]).not.toContain("--branch")
    })

    it("should configure runner container with correct env vars", async () => {
      const env = createMockEnv()
      const creator = createJobCreator(env)
      const config = createJobConfig()

      await creator.createRunnerJob(config)

      const job = mockCreateNamespacedJob.mock.calls[0][0].body
      const container = job.spec.template.spec.containers[0]

      expect(container.name).toBe("runner")
      expect(container.image).toBe("ghcr.io/bloomer-ab/claude-agent-runner:latest")

      const envMap = new Map(
        container.env
          .filter((e: { value?: string }) => e.value !== undefined)
          .map((e: { name: string; value: string }) => [e.name, e.value]),
      )

      expect(envMap.get("SESSION_ID")).toBe(config.sessionId)
      expect(envMap.get("PROMPT")).toBe(config.prompt)
      expect(envMap.get("MAX_TURNS")).toBe("50")
      expect(envMap.get("MAX_BUDGET_USD")).toBe("5")
      expect(envMap.get("MANAGER_WS_URL")).toBe(config.managerWsUrl)
      expect(envMap.get("REPO_URL")).toBe(config.repoUrl)
      expect(envMap.get("GITHUB_TOKEN")).toBe(config.githubToken)
    })

    it("should reference ANTHROPIC_API_KEY from a K8s secret", async () => {
      const env = createMockEnv()
      const creator = createJobCreator(env)
      const config = createJobConfig()

      await creator.createRunnerJob(config)

      const job = mockCreateNamespacedJob.mock.calls[0][0].body
      const container = job.spec.template.spec.containers[0]

      const apiKeyEnv = container.env.find(
        (e: { name: string }) => e.name === "ANTHROPIC_API_KEY",
      )
      expect(apiKeyEnv.valueFrom).toEqual({
        secretKeyRef: {
          name: "anthropic-api-key",
          key: "api-key",
        },
      })
    })

    it("should set correct resource limits", async () => {
      const env = createMockEnv()
      const creator = createJobCreator(env)
      const config = createJobConfig()

      await creator.createRunnerJob(config)

      const job = mockCreateNamespacedJob.mock.calls[0][0].body
      const container = job.spec.template.spec.containers[0]

      expect(container.resources).toEqual({
        requests: { cpu: "500m", memory: "512Mi" },
        limits: { cpu: "2", memory: "2Gi" },
      })
    })

    it("should use custom RUNNER_IMAGE from env", async () => {
      const env = createMockEnv({ RUNNER_IMAGE: "custom-registry.io/runner:v2" })
      const creator = createJobCreator(env)
      const config = createJobConfig()

      await creator.createRunnerJob(config)

      const job = mockCreateNamespacedJob.mock.calls[0][0].body
      const container = job.spec.template.spec.containers[0]
      expect(container.image).toBe("custom-registry.io/runner:v2")
    })

    it("should use custom RUNNER_NAMESPACE from env", async () => {
      const env = createMockEnv({ RUNNER_NAMESPACE: "custom-ns" })
      const creator = createJobCreator(env)
      const config = createJobConfig()

      await creator.createRunnerJob(config)

      const callArgs = mockCreateNamespacedJob.mock.calls[0][0]
      expect(callArgs.namespace).toBe("custom-ns")
      expect(callArgs.body.metadata.namespace).toBe("custom-ns")
    })

    it("should mount workspace volume in both containers", async () => {
      const env = createMockEnv()
      const creator = createJobCreator(env)
      const config = createJobConfig()

      await creator.createRunnerJob(config)

      const job = mockCreateNamespacedJob.mock.calls[0][0].body
      const initContainer = job.spec.template.spec.initContainers[0]
      const container = job.spec.template.spec.containers[0]

      expect(initContainer.volumeMounts).toEqual([
        { name: "workspace", mountPath: "/workspace" },
      ])
      expect(container.volumeMounts).toEqual([
        { name: "workspace", mountPath: "/workspace" },
      ])

      const volumes = job.spec.template.spec.volumes
      expect(volumes).toEqual([{ name: "workspace", emptyDir: {} }])
    })

    it("should set pod labels with app and session-id", async () => {
      const env = createMockEnv()
      const creator = createJobCreator(env)
      const config = createJobConfig()

      await creator.createRunnerJob(config)

      const job = mockCreateNamespacedJob.mock.calls[0][0].body
      expect(job.spec.template.metadata.labels).toEqual({
        app: "claude-runner",
        "session-id": config.sessionId,
      })
    })
  })

  describe("deleteJob", () => {
    it("should delete a K8s Job with Background propagation", async () => {
      const env = createMockEnv()
      const creator = createJobCreator(env)

      await creator.deleteJob("claude-runner-abcdef12")

      expect(mockDeleteNamespacedJob).toHaveBeenCalledOnce()
      expect(mockDeleteNamespacedJob).toHaveBeenCalledWith({
        name: "claude-runner-abcdef12",
        namespace: "claude-platform",
        body: { propagationPolicy: "Background" },
      })
    })
  })

  describe("getJobStatus", () => {
    it("should return job status counters", async () => {
      const env = createMockEnv()
      const creator = createJobCreator(env)

      mockReadNamespacedJob.mockResolvedValueOnce({
        status: { active: 0, succeeded: 1, failed: 0 },
      })

      const status = await creator.getJobStatus("claude-runner-abcdef12")
      expect(status).toEqual({ active: 0, succeeded: 1, failed: 0 })
    })

    it("should default missing status fields to 0", async () => {
      const env = createMockEnv()
      const creator = createJobCreator(env)

      mockReadNamespacedJob.mockResolvedValueOnce({
        status: {},
      })

      const status = await creator.getJobStatus("claude-runner-abcdef12")
      expect(status).toEqual({ active: 0, succeeded: 0, failed: 0 })
    })

    it("should handle undefined status", async () => {
      const env = createMockEnv()
      const creator = createJobCreator(env)

      mockReadNamespacedJob.mockResolvedValueOnce({})

      const status = await creator.getJobStatus("claude-runner-abcdef12")
      expect(status).toEqual({ active: 0, succeeded: 0, failed: 0 })
    })
  })
})
