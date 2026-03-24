-- Migration 001: Add repo_source column to sessions
-- Supports org-wide and discovery repo selection modes
ALTER TABLE sessions ADD repo_source TEXT;
