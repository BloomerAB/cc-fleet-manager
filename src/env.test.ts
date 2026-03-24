import { describe, it, expect, vi, afterEach } from "vitest"
import { loadEnv } from "./env.js"

const REQUIRED_ENV_VARS = {
  JWT_SECRET: "test-secret",
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
}

const ALL_ENV_VARS = {
  ...REQUIRED_ENV_VARS,
  PORT: "3000",
  HOST: "0.0.0.0",
  SCYLLA_HOST: "scylla",
  SCYLLA_PORT: "9042",
  SCYLLA_DATACENTER: "datacenter1",
  SCYLLA_KEYSPACE: "cc_fleet",
  SCYLLA_USERNAME: "admin",
  SCYLLA_PASSWORD: "password",
  GITHUB_SCOPES: "read:user,repo",
  GIT_TOKEN: "ghp_test123",
  MAX_CONCURRENT_TASKS: "5",
  WORKSPACE_BASE_DIR: "/tmp/cc-fleet-workspaces",
  ALLOWED_REPOS: "github.com/bloomerab/*",
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
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
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
    expect(env.SCYLLA_KEYSPACE).toBe("cc_fleet")
  })

  it("should apply default GITHUB_SCOPES", () => {
    vi.stubGlobal("process", { ...process, env: { ...REQUIRED_ENV_VARS } })

    const env = loadEnv()
    expect(env.GITHUB_SCOPES).toBe("read:user,repo")
  })

  it("should apply default MAX_CONCURRENT_TASKS of 5", () => {
    vi.stubGlobal("process", { ...process, env: { ...REQUIRED_ENV_VARS } })

    const env = loadEnv()
    expect(env.MAX_CONCURRENT_TASKS).toBe(5)
  })

  it("should apply default WORKSPACE_BASE_DIR", () => {
    vi.stubGlobal("process", { ...process, env: { ...REQUIRED_ENV_VARS } })

    const env = loadEnv()
    expect(env.WORKSPACE_BASE_DIR).toBe("/tmp/cc-fleet-workspaces")
  })

  it("should apply default ALLOWED_REPOS as empty string", () => {
    vi.stubGlobal("process", { ...process, env: { ...REQUIRED_ENV_VARS } })

    const env = loadEnv()
    expect(env.ALLOWED_REPOS).toBe("")
  })

  it("should apply default CORS_ORIGIN", () => {
    vi.stubGlobal("process", { ...process, env: { ...REQUIRED_ENV_VARS } })

    const env = loadEnv()
    expect(env.CORS_ORIGIN).toBe("http://localhost:5173")
  })

  it("should leave GIT_TOKEN as undefined when not provided", () => {
    vi.stubGlobal("process", { ...process, env: { ...REQUIRED_ENV_VARS } })

    const env = loadEnv()
    expect(env.GIT_TOKEN).toBeUndefined()
  })

  it("should leave SCYLLA_USERNAME and SCYLLA_PASSWORD as undefined when not provided", () => {
    vi.stubGlobal("process", { ...process, env: { ...REQUIRED_ENV_VARS } })

    const env = loadEnv()
    expect(env.SCYLLA_USERNAME).toBeUndefined()
    expect(env.SCYLLA_PASSWORD).toBeUndefined()
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

  it("should coerce MAX_CONCURRENT_TASKS from string to number", () => {
    vi.stubGlobal("process", {
      ...process,
      env: { ...REQUIRED_ENV_VARS, MAX_CONCURRENT_TASKS: "10" },
    })

    const env = loadEnv()
    expect(env.MAX_CONCURRENT_TASKS).toBe(10)
    expect(typeof env.MAX_CONCURRENT_TASKS).toBe("number")
  })

  it("should override defaults when values are provided", () => {
    vi.stubGlobal("process", {
      ...process,
      env: {
        ...REQUIRED_ENV_VARS,
        PORT: "9090",
        HOST: "127.0.0.1",
        GITHUB_SCOPES: "read:user",
        GIT_TOKEN: "ghp_custom",
        MAX_CONCURRENT_TASKS: "10",
        WORKSPACE_BASE_DIR: "/data/workspaces",
        ALLOWED_REPOS: "github.com/myorg/*",
        CORS_ORIGIN: "https://app.example.com",
      },
    })

    const env = loadEnv()
    expect(env.PORT).toBe(9090)
    expect(env.HOST).toBe("127.0.0.1")
    expect(env.GITHUB_SCOPES).toBe("read:user")
    expect(env.GIT_TOKEN).toBe("ghp_custom")
    expect(env.MAX_CONCURRENT_TASKS).toBe(10)
    expect(env.WORKSPACE_BASE_DIR).toBe("/data/workspaces")
    expect(env.ALLOWED_REPOS).toBe("github.com/myorg/*")
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

  it("should leave ANTHROPIC_API_KEY as undefined when not provided", () => {
    vi.stubGlobal("process", { ...process, env: { ...REQUIRED_ENV_VARS } })

    const env = loadEnv()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it("should throw listing all missing vars when multiple are missing", () => {
    vi.stubGlobal("process", { ...process, env: {} })

    expect(() => loadEnv()).toThrow("Missing environment variables")
  })
})
