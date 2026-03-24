import { describe, it, expect, vi, afterEach } from "vitest"
import { loadEnv } from "./env.js"

const REQUIRED_ENV_VARS = {
  JWT_SECRET: "test-secret",
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: "private-key",
  GITHUB_APP_INSTALLATION_ID: "67890",
  ANTHROPIC_SECRET_NAME: "anthropic-api-key",
  ANTHROPIC_SECRET_KEY: "api-key",
}

const ALL_ENV_VARS = {
  ...REQUIRED_ENV_VARS,
  PORT: "3000",
  HOST: "0.0.0.0",
  SCYLLA_HOST: "scylla",
  SCYLLA_PORT: "9042",
  SCYLLA_DATACENTER: "datacenter1",
  SCYLLA_KEYSPACE: "claude_platform",
  RUNNER_IMAGE: "ghcr.io/bloomerab/claude-agent-runner:latest",
  RUNNER_NAMESPACE: "claude-platform",
  CORS_ORIGIN: "http://localhost:5173",
}

describe("loadEnv", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("should load all required environment variables", () => {
    vi.stubGlobal("process", { ...process, env: { ...ALL_ENV_VARS } })

    const env = loadEnv()
    expect(env.JWT_SECRET).toBe("test-secret")
    expect(env.GITHUB_CLIENT_ID).toBe("client-id")
    expect(env.GITHUB_CLIENT_SECRET).toBe("client-secret")
    expect(env.GITHUB_APP_ID).toBe("12345")
    expect(env.GITHUB_APP_PRIVATE_KEY).toBe("private-key")
    expect(env.GITHUB_APP_INSTALLATION_ID).toBe("67890")
    expect(env.ANTHROPIC_SECRET_NAME).toBe("anthropic-api-key")
    expect(env.ANTHROPIC_SECRET_KEY).toBe("api-key")
  })

  it("should apply default PORT of 3000", () => {
    vi.stubGlobal("process", { ...process, env: { ...REQUIRED_ENV_VARS } })

    const env = loadEnv()
    expect(env.PORT).toBe(3000)
  })

  it("should apply default HOST of 0.0.0.0", () => {
    vi.stubGlobal("process", { ...process, env: { ...REQUIRED_ENV_VARS } })

    const env = loadEnv()
    expect(env.HOST).toBe("0.0.0.0")
  })

  it("should apply default RUNNER_IMAGE", () => {
    vi.stubGlobal("process", { ...process, env: { ...REQUIRED_ENV_VARS } })

    const env = loadEnv()
    expect(env.RUNNER_IMAGE).toBe("ghcr.io/bloomerab/claude-agent-runner:latest")
  })

  it("should apply default SCYLLA_HOST", () => {
    vi.stubGlobal("process", { ...process, env: { ...REQUIRED_ENV_VARS } })

    const env = loadEnv()
    expect(env.SCYLLA_HOST).toBe("scylla")
  })

  it("should apply default SCYLLA_PORT", () => {
    vi.stubGlobal("process", { ...process, env: { ...REQUIRED_ENV_VARS } })

    const env = loadEnv()
    expect(env.SCYLLA_PORT).toBe(9042)
  })

  it("should apply default SCYLLA_KEYSPACE", () => {
    vi.stubGlobal("process", { ...process, env: { ...REQUIRED_ENV_VARS } })

    const env = loadEnv()
    expect(env.SCYLLA_KEYSPACE).toBe("claude_platform")
  })

  it("should apply default RUNNER_NAMESPACE", () => {
    vi.stubGlobal("process", { ...process, env: { ...REQUIRED_ENV_VARS } })

    const env = loadEnv()
    expect(env.RUNNER_NAMESPACE).toBe("claude-platform")
  })

  it("should apply default CORS_ORIGIN", () => {
    vi.stubGlobal("process", { ...process, env: { ...REQUIRED_ENV_VARS } })

    const env = loadEnv()
    expect(env.CORS_ORIGIN).toBe("http://localhost:5173")
  })

  it("should coerce PORT from string to number", () => {
    vi.stubGlobal("process", {
      ...process,
      env: { ...REQUIRED_ENV_VARS, PORT: "8080" },
    })

    const env = loadEnv()
    expect(env.PORT).toBe(8080)
    expect(typeof env.PORT).toBe("number")
  })

  it("should override defaults when values are provided", () => {
    vi.stubGlobal("process", {
      ...process,
      env: {
        ...REQUIRED_ENV_VARS,
        PORT: "9090",
        HOST: "127.0.0.1",
        RUNNER_IMAGE: "custom:v2",
        RUNNER_NAMESPACE: "my-ns",
        CORS_ORIGIN: "https://app.example.com",
      },
    })

    const env = loadEnv()
    expect(env.PORT).toBe(9090)
    expect(env.HOST).toBe("127.0.0.1")
    expect(env.RUNNER_IMAGE).toBe("custom:v2")
    expect(env.RUNNER_NAMESPACE).toBe("my-ns")
    expect(env.CORS_ORIGIN).toBe("https://app.example.com")
  })

  it("should throw when JWT_SECRET is missing", () => {
    const { JWT_SECRET, ...rest } = REQUIRED_ENV_VARS
    vi.stubGlobal("process", { ...process, env: { ...rest } })

    expect(() => loadEnv()).toThrow("Missing environment variables")
    expect(() => loadEnv()).toThrow("JWT_SECRET")
  })

  it("should throw when GITHUB_CLIENT_ID is missing", () => {
    const { GITHUB_CLIENT_ID, ...rest } = REQUIRED_ENV_VARS
    vi.stubGlobal("process", { ...process, env: { ...rest } })

    expect(() => loadEnv()).toThrow("Missing environment variables")
  })

  it("should throw listing all missing vars when multiple are missing", () => {
    vi.stubGlobal("process", { ...process, env: {} })

    expect(() => loadEnv()).toThrow("Missing environment variables")
  })

  it("should throw when GITHUB_APP_PRIVATE_KEY is missing", () => {
    const { GITHUB_APP_PRIVATE_KEY, ...rest } = REQUIRED_ENV_VARS
    vi.stubGlobal("process", { ...process, env: { ...rest } })

    expect(() => loadEnv()).toThrow("Missing environment variables")
  })
})
