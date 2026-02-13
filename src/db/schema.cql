CREATE KEYSPACE IF NOT EXISTS claude_platform
WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 3};

USE claude_platform;

-- Sessions table: partitioned by user_id for efficient user-scoped queries
-- Clustering by created_at DESC for natural time ordering
CREATE TABLE IF NOT EXISTS sessions (
  user_id TEXT,
  id UUID,
  user_login TEXT,
  status TEXT,
  prompt TEXT,
  repo_url TEXT,
  repo_branch TEXT,
  max_turns INT,
  max_budget_usd FLOAT,
  deadline_seconds INT,
  job_name TEXT,
  result TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  PRIMARY KEY ((user_id), created_at, id)
) WITH CLUSTERING ORDER BY (created_at DESC, id ASC);

-- Secondary index for looking up sessions by id without knowing user_id
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
