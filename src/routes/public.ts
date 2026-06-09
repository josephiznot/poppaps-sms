/** GET / — public, read-only season standings + recent winners (ADR-0005 §3). */
import { Hono } from 'hono';
import type { Env } from '../types';
import { layout, esc } from '../lib/html';
import { formatWhen } from '../lib/messages';
import { privacyPage, termsPage } from '../views/policies';
import { rulesPage } from '../views/rules';
import * as db from '../lib/db';

export const publicRoutes = new Hono<{ Bindings: Env }>();

publicRoutes.get('/', async (c) => {
  const since = await db.lastSeasonClose(c.env.DB);
  const rows = await db.standings(c.env.DB, since);
  const winners = await db.recentGameWinners(c.env.DB, 10);

  const standingsHtml = rows.length
    ? `<table><thead><tr><th>#</th><th>Player</th><th>Pts</th></tr></thead><tbody>` +
      rows
        .map(
          (r, i) =>
            `<tr><td>${i + 1}</td><td>${esc(r.display_name ?? 'New player')}</td><td>${r.total}</td></tr>`,
        )
        .join('') +
      `</tbody></table>`
    : `<p class="muted">No points yet this season. Check back after the next game.</p>`;

  const winnersHtml = winners.length
    ? `<ul>` +
      winners
        .map(
          (w) =>
            `<li>${esc(formatWhen(w.starts_at, c.env.TIMEZONE))} — ` +
            `<strong>${esc(w.display_name ?? 'New player')}</strong>` +
            `${w.is_tournament ? ' <span class="pill">🏆 tournament</span>' : ''}</li>`,
        )
        .join('') +
      `</ul>`
    : `<p class="muted">No games recorded yet.</p>`;

  const body =
    `<h1>${esc(c.env.PROGRAM_NAME)}</h1>` +
    `<p class="muted">Current season standings. Points reset after each Special Players tournament.</p>` +
    `<h2>Standings</h2>${standingsHtml}` +
    `<h2>Recent winners</h2>${winnersHtml}` +
    `<p class="muted" style="margin-top:2rem"><a href="/rules">Game rules</a> · <a href="/terms">Program terms</a> · <a href="/privacy">Privacy</a></p>`;

  return layout(`${c.env.PROGRAM_NAME} — Standings`, body);
});

publicRoutes.get('/rules', (c) => rulesPage(c.env));
publicRoutes.get('/privacy', (c) => privacyPage(c.env));
publicRoutes.get('/terms', (c) => termsPage(c.env));
