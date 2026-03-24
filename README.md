# CC Fleet Manager

The core server for [CC Fleet](https://github.com/BloomerAB/cc-fleet-chart) — a platform for running Claude Code sessions across multiple repositories.

## What It Does

- **REST API** — Create, list, cancel tasks. GitHub OAuth login.
- **WebSocket** — Real-time streaming of Claude output to the dashboard.
- **Claude SDK** — Runs `@anthropic-ai/claude-agent-sdk` in-process. No separate runner pods.
- **Multi-repo** — Each task can work across multiple git repos in a shared workspace.
- **Dashboard SPA** — Serves the [cc-fleet-ui](https://github.com/BloomerAB/cc-fleet-ui) React app via `@fastify/static`.

## Architecture

```
cc-fleet-manager (single process)
├── Fastify HTTP server
│   ├── /api/auth/*     GitHub OAuth login
│   ├── /api/tasks/*    Task CRUD (JWT-protected)
│   ├── /ws/dashboard   WebSocket (real-time output)
│   ├── /health         K8s probes
│   └── /*              Dashboard SPA fallback
├── Task Executor
│   ├── Clones repos into temp workspace
│   ├── Runs Claude Agent SDK query()
│   ├── Streams output to dashboard via WS
│   └── Cleans up workspace on completion
└── ScyllaDB
    ├── users (GitHub tokens for git access)
    ├── sessions (task state)
    └── session_messages (output history)
```

## Related Repos

| Repo | What | Dependency |
|------|------|-----------|
| [cc-fleet-ui](https://github.com/BloomerAB/cc-fleet-ui) | React dashboard | Built into this image at Docker build time |
| [cc-fleet-types](https://github.com/BloomerAB/cc-fleet-types) | Shared TypeScript types | npm: `@bloomerab/cc-fleet-types` |
| [cc-fleet-chart](https://github.com/BloomerAB/cc-fleet-chart) | Helm chart | Deploys this + ScyllaDB |

## Development

```bash
# Prerequisites: Node 24+, ScyllaDB running on localhost:9042

# Install dependencies
npm install

# Run schema
cqlsh -f src/db/schema.cql

# Start dev server
npm run dev

# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | yes | — | JWT signing secret |
| `GITHUB_CLIENT_ID` | yes | — | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | yes | — | GitHub OAuth client secret |
| `ANTHROPIC_API_KEY` | yes | — | Anthropic API key |
| `SCYLLA_HOST` | no | `scylla` | ScyllaDB host |
| `SCYLLA_PORT` | no | `9042` | ScyllaDB port |
| `SCYLLA_KEYSPACE` | no | `cc_fleet` | Keyspace name |
| `GITHUB_SCOPES` | no | `read:user,repo` | GitHub OAuth scopes |
| `GIT_TOKEN` | no | — | Fallback git token |
| `MAX_CONCURRENT_TASKS` | no | `5` | Max parallel sessions |
| `WORKSPACE_BASE_DIR` | no | `/tmp/cc-fleet-workspaces` | Temp workspace root |
| `ALLOWED_REPOS` | no | `""` | Comma-separated glob patterns |
| `CORS_ORIGIN` | no | `http://localhost:3000` | CORS origin |
