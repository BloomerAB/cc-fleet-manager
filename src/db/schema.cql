CREATE KEYSPACE IF NOT EXISTS cc_fleet
WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

USE cc_fleet;

-- Users table: stores GitHub OAuth tokens for git operations
CREATE TABLE IF NOT EXISTS users (
  id TEXT,
  github_login TEXT,
  name TEXT,
  email TEXT,
  avatar_url TEXT,
  access_token TEXT,
  token_scopes TEXT,
  anthropic_api_key TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS users_by_login ON users (github_login);

-- Sessions table: partitioned by user_id for efficient user-scoped queries
CREATE TABLE IF NOT EXISTS sessions (
  user_id TEXT,
  id UUID,
  status TEXT,
  prompt TEXT,
  repos TEXT,
  max_turns INT,
  max_budget_usd FLOAT,
  deadline_seconds INT,
  result TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  PRIMARY KEY ((user_id), created_at, id)
) WITH CLUSTERING ORDER BY (created_at DESC, id ASC);

CREATE INDEX IF NOT EXISTS sessions_by_id ON sessions (id);

-- Session messages: partitioned by session_id, clustered by created_at
CREATE TABLE IF NOT EXISTS session_messages (
  session_id UUID,
  id UUID,
  role TEXT,
  content TEXT,
  tool_name TEXT,
  created_at TIMESTAMP,
  PRIMARY KEY ((session_id), created_at, id)
) WITH CLUSTERING ORDER BY (created_at ASC, id ASC);
