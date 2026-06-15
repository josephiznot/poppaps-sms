#!/usr/bin/env node
/**
 * Deploy wrapper that bakes the running git commit into the Worker as plain-text
 * vars (GIT_SHA / GIT_BRANCH / BUILT_AT). A Worker has no git at runtime, so
 * `/health` reads these to report which commit is live and how far behind `main`
 * it is. Cross-platform (Node ESM, spawnSync with an args array — no shell).
 */
import { execSync, spawnSync } from 'node:child_process';

const git = (args) => execSync(`git ${args}`, { encoding: 'utf8' }).trim();

const sha = git('rev-parse HEAD');
const branch = git('rev-parse --abbrev-ref HEAD');
const builtAt = new Date().toISOString();

// Args array (not a shell string) so the ISO timestamp's colons stay intact and
// nothing needs quoting. Forward any extra CLI args (e.g. --dry-run).
const args = [
  'wrangler',
  'deploy',
  '--var',
  `GIT_SHA:${sha}`,
  '--var',
  `GIT_BRANCH:${branch}`,
  '--var',
  `BUILT_AT:${builtAt}`,
  ...process.argv.slice(2),
];

console.log(`Deploying ${branch}@${sha.slice(0, 7)} (built ${builtAt})`);

const res = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(res.status ?? 1);
