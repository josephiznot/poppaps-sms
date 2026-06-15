/** Public `GET /health` — reports the git commit the live Worker is running and
 *  how many commits it is behind `main` on GitHub, so the host can see at a glance
 *  how current the deployed code is.
 *
 *  The running SHA is baked in at deploy time as a plain-text var (see
 *  scripts/deploy.mjs); a Worker has no git at runtime. Absent in `wrangler dev`,
 *  so the route degrades to "unknown (local dev)". The GitHub comparison is wrapped
 *  so a network error / rate-limit (403) / unknown-SHA (404) never 500s the route. */
import { Hono } from 'hono';
import type { Env } from '../types';

export const health = new Hono<{ Bindings: Env }>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

health.get('/', async (c) => {
  const sha = c.env.GIT_SHA;
  const branch = c.env.GIT_BRANCH || 'main';
  const repo = c.env.GITHUB_REPO;

  const out: Record<string, unknown> = {
    commit: sha ?? 'unknown (local dev)',
    shortCommit: sha ? sha.slice(0, 7) : 'unknown',
    branch,
    builtAt: c.env.BUILT_AT ?? 'unknown (local dev)',
    repo,
    latestCommit: null,
    commitsBehind: null,
    status: null,
    upToDate: null,
  };

  // No baked-in SHA → local dev (or a plain `wrangler deploy`). Skip the compare.
  if (!sha) {
    out.note = 'GIT_SHA not injected — running locally or deployed without scripts/deploy.mjs.';
    return json(out);
  }

  const headers: Record<string, string> = {
    'User-Agent': 'poppaps-health-check',
    Accept: 'application/vnd.github+json',
  };
  // Public repo → unauthenticated is fine (~60 req/hr/IP). Token only matters if
  // the repo is ever made private. Never echo it back in the response.
  if (c.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${c.env.GITHUB_TOKEN}`;

  try {
    const url = `https://api.github.com/repos/${repo}/compare/${sha}...${branch}`;
    // Cache briefly to soften GitHub's per-IP rate limit on this public endpoint.
    const res = await fetch(url, { headers, cf: { cacheTtl: 60, cacheEverything: true } });

    if (!res.ok) {
      const note =
        res.status === 404
          ? 'GitHub check unavailable — deployed commit not found on GitHub (not pushed yet?).'
          : res.status === 403
            ? 'GitHub check unavailable — rate limited (403).'
            : !c.env.GITHUB_TOKEN
              ? 'GitHub check unavailable — set GITHUB_TOKEN secret if the repo is private.'
              : `GitHub check unavailable — API responded ${res.status}.`;
      out.note = note;
      return json(out);
    }

    const data = (await res.json()) as {
      status?: string;
      ahead_by?: number;
      commits?: { sha: string }[];
    };
    const behind = data.ahead_by ?? 0;
    out.status = data.status ?? null;
    out.commitsBehind = behind;
    out.upToDate = behind === 0;
    // commits[] are the head's commits ahead of base; last one is the tip of `branch`.
    const commits = data.commits ?? [];
    out.latestCommit = commits.length ? commits[commits.length - 1]!.sha : sha;
  } catch (err) {
    out.error = `GitHub check failed: ${(err as Error).message}`;
  }

  return json(out);
});
