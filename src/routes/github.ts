import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { minimatch } from "minimatch"
import type { UserStore } from "../services/user-store.js"
import type { GitHubOrg, GitHubRepo } from "../types/api.js"

const GITHUB_API = "https://api.github.com"
const PER_PAGE = 100

interface JwtPayload {
  readonly sub: string
  readonly login: string
}

interface GhOrg {
  readonly login: string
  readonly avatar_url: string
}

interface GhRepo {
  readonly name: string
  readonly full_name: string
  readonly html_url: string
  readonly description: string | null
  readonly language: string | null
  readonly default_branch: string
  readonly updated_at: string
  readonly archived: boolean
}

const reposQuerySchema = z.object({
  org: z.string().min(1),
  pattern: z.string().optional(),
  includeArchived: z.coerce.boolean().default(false),
})

const ghFetch = async <T>(path: string, token: string): Promise<T> => {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub API ${response.status}: ${body}`)
  }

  return response.json() as Promise<T>
}

const fetchAllPages = async <T>(basePath: string, token: string): Promise<readonly T[]> => {
  const results: T[] = []
  let page = 1

  while (true) {
    const separator = basePath.includes("?") ? "&" : "?"
    const items = await ghFetch<T[]>(`${basePath}${separator}per_page=${PER_PAGE}&page=${page}`, token)
    results.push(...items)
    if (items.length < PER_PAGE) break
    page++
  }

  return results
}

const toGitHubOrg = (org: GhOrg): GitHubOrg => ({
  login: org.login,
  avatarUrl: org.avatar_url,
})

const toGitHubRepo = (repo: GhRepo): GitHubRepo => ({
  name: repo.name,
  fullName: repo.full_name,
  url: repo.html_url,
  description: repo.description,
  language: repo.language,
  defaultBranch: repo.default_branch,
  updatedAt: repo.updated_at,
  archived: repo.archived,
})

const registerGitHubRoutes = (app: FastifyInstance, userStore: UserStore) => {
  // Auth hook for GitHub routes
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/github")) {
      try {
        await request.jwtVerify()
      } catch {
        return reply.status(401).send({ success: false, error: "Unauthorized" })
      }
    }
  })

  // GET /api/github/orgs — list user's GitHub orgs
  app.get("/api/github/orgs", async (request, reply) => {
    const user = request.user as JwtPayload
    const token = await userStore.getAccessToken(user.sub)

    if (!token) {
      return reply.status(400).send({ success: false, error: "No GitHub token found. Re-login required." })
    }

    try {
      const orgs = await fetchAllPages<GhOrg>("/user/orgs", token)

      // Also include the user's personal account as a source
      const userOrg: GitHubOrg = { login: user.login, avatarUrl: "" }

      return {
        success: true,
        data: [userOrg, ...orgs.map(toGitHubOrg)],
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.status(502).send({ success: false, error: `GitHub API error: ${message}` })
    }
  })

  // GET /api/github/repos?org=X&pattern=Y — list repos for an org
  app.get("/api/github/repos", async (request, reply) => {
    const query = reposQuerySchema.parse(request.query)
    const user = request.user as JwtPayload
    const token = await userStore.getAccessToken(user.sub)

    if (!token) {
      return reply.status(400).send({ success: false, error: "No GitHub token found. Re-login required." })
    }

    try {
      // Determine if it's a user or org
      const isPersonal = query.org === user.login
      const path = isPersonal
        ? "/user/repos?type=owner&sort=updated"
        : `/orgs/${encodeURIComponent(query.org)}/repos?sort=updated`

      const allRepos = await fetchAllPages<GhRepo>(path, token)

      const filtered = allRepos
        .filter((repo) => query.includeArchived || !repo.archived)
        .filter((repo) => !query.pattern || minimatch(repo.name, query.pattern))
        .map(toGitHubRepo)

      return {
        success: true,
        data: filtered,
        meta: { total: filtered.length },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.status(502).send({ success: false, error: `GitHub API error: ${message}` })
    }
  })
}

export { registerGitHubRoutes }
