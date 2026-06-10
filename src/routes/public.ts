/** Public, read-only pages: standings (`/`), a game's winners (`/game/:id`),
 *  and season history (`/seasons`). First name + last initial only (ADR-0005 §3). */
import { Hono } from 'hono';
import type { Env, StandingRow } from '../types';
import { layout, esc, publicNav } from '../lib/html';
import { formatWhen } from '../lib/messages';
import { privacyPage, termsPage } from '../views/policies';
import { rulesPage } from '../views/rules';
import { badgesForAll } from '../lib/badges';
import { cardForRank } from '../lib/points';
import * as db from '../lib/db';

export const publicRoutes = new Hono<{ Bindings: Env }>();

const footerLinks =
  `<p class="muted" style="margin-top:2rem"><a href="/rules">Game rules</a> · ` +
  `<a href="/terms">SMS terms</a> · <a href="/privacy">Privacy</a></p>`;

// Ranks 1–13 get a playing-card badge (A down to 2); 14th+ falls back to a plain number.
export function rankBadge(i: number): string {
  const r = cardForRank(i);
  return r ? `<span class="card">${r}<small>♠</small></span>` : `${i + 1}`;
}

function standingsTable(rows: StandingRow[], badges: Record<string, string[]> = {}): string {
  if (!rows.length) return `<p class="muted">No points yet this season — check back after the next game.</p>`;
  return (
    `<table><thead><tr><th>Rank</th><th>Player</th><th style="text-align:right">Pts</th></tr></thead><tbody>` +
    rows
      .map((r, i) => {
        const chips = (badges[r.phone] ?? []).map((b) => `<span class="chip">${b}</span>`).join('');
        const cls = i < 3 ? ` class="r${i + 1}"` : '';
        return (
          `<tr${cls}><td>${rankBadge(i)}</td><td>${esc(r.display_name ?? 'New player')}${chips}</td>` +
          `<td style="text-align:right">${r.total}</td></tr>`
        );
      })
      .join('') +
    `</tbody></table>`
  );
}

function placeLabel(points: number): string {
  return (({ 5: '1st', 4: '2nd', 3: '3rd', 2: '4th', 1: '5th' }) as Record<number, string>)[points] ?? '—';
}

// ---- standings (current season) -------------------------------------------

publicRoutes.get('/', async (c) => {
  const since = await db.lastSeasonClose(c.env.DB);
  const rows = await db.standings(c.env.DB, since);
  const recent = await db.recentResults(c.env.DB, 10);
  const badges = badgesForAll(await db.attendanceHistory(c.env.DB));

  const leader = rows[0];
  const hero = leader
    ? `<div class="hero"><span class="card">A<small>♠</small></span>` +
      `<div><strong>${esc(leader.display_name ?? 'New player')}</strong> leads the season` +
      `<div class="muted">${leader.total} pts — next game could change everything</div></div></div>`
    : '';

  const recentHtml = recent.length
    ? `<ul>` +
      recent
        .map(
          (g) =>
            `<li><a href="/game/${esc(g.id)}">${esc(formatWhen(g.starts_at, c.env.TIMEZONE))}</a>` +
            `${g.is_tournament ? ' <span class="pill">🏆</span>' : ''}` +
            `${g.winner ? ` — won by <strong>${esc(g.winner)}</strong>` : ''}</li>`,
        )
        .join('') +
      `</ul>`
    : `<p class="muted">No games recorded yet.</p>`;

  // Legend for the badge chips — only when at least one chip is actually on screen.
  const hasChips = rows.some((r) => (badges[r.phone] ?? []).length > 0);
  const badgeLegend = hasChips
    ? `<p class="muted">🔥 Hot = top-5 in their last two games · ⚡ Comeback = back in the top 5 after a dry spell · ` +
      `🃏 Regular = played the last 3 games · <a href="/rules">details</a></p>`
    : '';

  const body =
    `<h1>${esc(c.env.PROGRAM_NAME)}</h1>` +
    hero +
    `<p class="muted">Points reset after each Special Players tournament — see <a href="/seasons">past seasons</a>.</p>` +
    `<h2>Current season standings</h2>${standingsTable(rows, badges)}${badgeLegend}` +
    `<h2>Recent games</h2><p class="muted">Tap a game to see its winners.</p>${recentHtml}` +
    footerLinks;

  return layout(`${c.env.PROGRAM_NAME} — Standings`, body, publicNav);
});

// ---- a single game's winners ----------------------------------------------

publicRoutes.get('/game/:id', async (c) => {
  const game = await db.getGame(c.env.DB, c.req.param('id'));
  if (!game) {
    return layout('Not found', `<h1>Game not found</h1><p><a href="/">← Standings</a></p>`, publicNav);
  }
  const results = await db.gameResults(c.env.DB, game.id);
  const when = esc(formatWhen(game.starts_at, c.env.TIMEZONE));

  const table = results.length
    ? `<table><thead><tr><th>Place</th><th>Player</th><th>Pts</th></tr></thead><tbody>` +
      results
        .map((r) => `<tr><td>${placeLabel(r.points)}</td><td>${esc(r.display_name ?? 'Player')}</td><td>${r.points}</td></tr>`)
        .join('') +
      `</tbody></table>`
    : `<p class="muted">No results recorded for this game yet.</p>`;

  const body =
    `<h1>${when}${game.is_tournament ? ' <span class="pill">🏆 tournament</span>' : ''}</h1>` +
    `<p class="muted">${esc(game.location)}</p>` +
    `<h2>Winners</h2>${table}` +
    `<p class="muted" style="margin-top:2rem"><a href="/">← Standings</a> · <a href="/seasons">Seasons</a></p>`;

  return layout(`Game ${when} — ${c.env.PROGRAM_NAME}`, body, publicNav);
});

// ---- season history --------------------------------------------------------

publicRoutes.get('/seasons', async (c) => {
  const since = await db.lastSeasonClose(c.env.DB);
  const current = await db.standings(c.env.DB, since);
  const seasons = (await db.listSeasons(c.env.DB)).map((s, i) => ({ ...s, n: i + 1 })); // n: chronological

  const pastHtml = seasons.length
    ? seasons
        .slice()
        .reverse() // most recent first
        .map((s) => {
          const invited = s.snapshot.invited ?? [];
          const champ = invited[0]?.name ?? '—';
          const list = invited.length
            ? `<ol>` + invited.map((p, idx) => `<li>${idx === 0 ? '🏆 ' : ''}${esc(p.name ?? 'Player')}</li>`).join('') + `</ol>`
            : `<p class="muted">No players recorded.</p>`;
          return (
            `<h3>Season ${s.n} <span class="muted">— ended ${esc(formatWhen(s.closed_at, c.env.TIMEZONE))}</span></h3>` +
            `<p>🏆 Champion: <strong>${esc(champ)}</strong></p>` +
            `<p class="muted">Special Players (invited to the tournament):</p>${list}`
          );
        })
        .join('')
    : `<p class="muted">No seasons completed yet — the first one ends at your first Special Players tournament.</p>`;

  const body =
    `<h1>Seasons</h1>` +
    `<p class="muted">Each season runs until a Special Players tournament, then points reset.</p>` +
    `<h2>Current season (in progress)</h2>${standingsTable(current)}` +
    `<h2>Past seasons</h2>${pastHtml}` +
    `<p class="muted" style="margin-top:2rem"><a href="/">← Standings</a></p>`;

  return layout(`Seasons — ${c.env.PROGRAM_NAME}`, body, publicNav);
});

// ---- static info pages -----------------------------------------------------

publicRoutes.get('/rules', (c) => rulesPage(c.env));
publicRoutes.get('/privacy', (c) => privacyPage(c.env));
publicRoutes.get('/terms', (c) => termsPage(c.env));
