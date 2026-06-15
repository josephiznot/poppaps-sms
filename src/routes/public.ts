/** Public, read-only pages: standings (`/`), a game's winners (`/game/:id`),
 *  and season history (`/seasons`). First name + last initial only (ADR-0005 §3). */
import { Hono } from 'hono';
import type { Env, StandingRow } from '../types';
import { layout, esc, publicNav } from '../lib/html';
import { formatWhen } from '../lib/messages';
import { formatUs } from '../lib/phone';
import { privacyPage, termsPage } from '../views/policies';
import { rulesPage } from '../views/rules';
import { badgesForAll } from '../lib/badges';
import { cardForRank, seasonStats, placeOrdinal } from '../lib/points';
import { playerIdMap } from '../lib/playerId';
import * as db from '../lib/db';

export const publicRoutes = new Hono<{ Bindings: Env }>();

const footerLinks =
  `<p class="muted" style="margin-top:2rem"><a href="/rules">Game rules</a> · ` +
  `<a href="/terms">SMS terms</a> · <a href="/privacy">Privacy</a></p>`;

/** Plain 1-based rank number (standings Rank column + the profile header). */
export function rankBadge(i: number): string {
  return `${i + 1}`;
}

/** The top 4 get an exclusive face card by their name: 1st=A, 2nd=K, 3rd=Q, 4th=J. */
function faceCard(i: number): string {
  if (i > 3) return '';
  const r = cardForRank(i); // A, K, Q, J
  return r ? ` <span class="card sm" title="Top 4">${r}<small>♠</small></span>` : '';
}

function standingsTable(
  rows: StandingRow[],
  badges: Record<string, string[]> = {},
  idByPhone?: Map<string, string>,
): string {
  if (!rows.length) return `<p class="muted">No points yet this season — check back after the next game.</p>`;
  return (
    `<table><thead><tr><th>Rank</th><th>Player</th><th style="text-align:right">Pts</th></tr></thead><tbody>` +
    rows
      .map((r, i) => {
        const chips = (badges[r.phone] ?? []).map((b) => `<span class="chip">${b}</span>`).join('');
        const cls = i < 3 ? ` class="r${i + 1}"` : '';
        const name = esc(r.display_name ?? 'New player');
        const pid = idByPhone?.get(r.phone); // opaque hash id — never the phone (ADR-0005)
        const nameHtml = pid ? `<a class="player" href="/player/${esc(pid)}">${name}</a>` : name;
        const row =
          `<tr${cls}><td>${rankBadge(i)}</td><td>${nameHtml}${faceCard(i)}${chips}</td>` +
          `<td style="text-align:right">${r.total}</td></tr>`;
        // Tournament-qualification cut: a labelled line after the top 8 (only
        // when there's a 9th player to separate from).
        const cut =
          i === 7 && rows.length > 8
            ? `<tr class="cutline"><td colspan="3">Top 8 · Special Players tournament line</td></tr>`
            : '';
        return row + cut;
      })
      .join('') +
    `</tbody></table>`
  );
}


// ---- standings (current season) -------------------------------------------

publicRoutes.get('/', async (c) => {
  const since = await db.lastSeasonClose(c.env.DB);
  const rows = await db.standings(c.env.DB, since);
  const recent = await db.recentResults(c.env.DB, 10);
  const badges = badgesForAll(await db.attendanceHistory(c.env.DB));
  // Opaque profile-link ids for the players on the board (phone → id).
  const idMap = await playerIdMap(rows.map((r) => r.phone));
  const idByPhone = new Map([...idMap].map(([id, phone]) => [phone, id]));

  // Next-game banner — the auto-scheduler keeps the next biweekly game materialized.
  const next = await db.nextUpcomingGame(c.env.DB, new Date().toISOString());
  const joinLink =
    `<a href="sms:${c.env.TWILIO_FROM_NUMBER}?&amp;body=JOIN" style="color:#f7f1e3">` +
    `text JOIN to ${esc(formatUs(c.env.TWILIO_FROM_NUMBER))}</a>`;
  const nextBanner = next
    ? `<div class="hero"><span class="card">🗓</span>` +
      `<div><strong>Next game: ${esc(formatWhen(next.starts_at, c.env.TIMEZONE))}</strong>` +
      `${next.is_tournament ? ' <span class="pill">🏆 Special Players</span>' : ''}` +
      `<div class="muted">${esc(next.location)} — ${joinLink} for a reminder · ` +
      `msg &amp; data rates may apply · <a href="/terms" style="color:#f7f1e3">terms</a></div></div></div>`
    : '';

  // One-line race note above the table (the gold A♠ row crowns the leader itself).
  const leader = rows[0];
  const runnerUp = rows[1];
  let raceLine = '';
  if (leader && runnerUp) {
    const gap = leader.total - runnerUp.total;
    raceLine =
      `<p class="muted"><strong>${esc(leader.display_name ?? 'New player')}</strong> leads — ` +
      (gap === 0
        ? `tied with ${esc(runnerUp.display_name ?? 'New player')}.`
        : `${esc(runnerUp.display_name ?? 'New player')} is ${gap} back.`) +
      `</p>`;
  }

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
    ? `<ul class="legend">` +
      `<li><span class="chip">🔥 Hot</span> top-5 in their last two games</li>` +
      `<li><span class="chip">⚡ Comeback</span> back in the top 5 after a dry spell</li>` +
      `<li><span class="chip">🃏 Regular</span> played the last 3 games</li>` +
      `<li><a href="/rules">details</a></li>` +
      `</ul>`
    : '';

  const body =
    `<h1>${esc(c.env.PROGRAM_NAME)}</h1>` +
    nextBanner +
    `<h2>Current season standings</h2>` +
    raceLine +
    `${standingsTable(rows, badges, idByPhone)}${badgeLegend}` +
    `<p class="muted">Points reset after each Special Players tournament — see <a href="/seasons">past seasons</a>.</p>` +
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
        .map(
          (r) =>
            `<tr><td>${placeOrdinal(r.place)}</td><td>${esc(r.display_name ?? 'Player')}</td>` +
            `<td>${game.is_tournament ? '—' : r.points}</td></tr>`,
        )
        .join('') +
      `</tbody></table>`
    : `<p class="muted">No results recorded for this game yet.</p>`;

  const heading = game.is_tournament ? 'Final standings' : 'Winners';
  const body =
    `<h1>${when}${game.is_tournament ? ' <span class="pill">🏆 tournament</span>' : ''}</h1>` +
    `<p class="muted">${esc(game.location)}${game.is_tournament ? ' — no season points; bragging rights only' : ''}</p>` +
    `<h2>${heading}</h2>${table}` +
    `<p class="muted" style="margin-top:2rem"><a href="/">← Standings</a> · <a href="/seasons">Seasons</a></p>`;

  return layout(`Game ${when} — ${c.env.PROGRAM_NAME}`, body, publicNav);
});

// ---- a player's current-season profile --------------------------------------
// URL ids are opaque SHA-256 hashes (lib/playerId.ts) — phones never appear in
// public URLs or markup (privacy promise, ADR-0005 §3).

publicRoutes.get('/player/:id', async (c) => {
  const members = await db.listMembers(c.env.DB);
  const ids = await playerIdMap(members.map((m) => m.phone));
  const phone = ids.get(c.req.param('id'));
  const member = phone ? members.find((m) => m.phone === phone) : undefined;
  if (!phone || !member) {
    return layout('Not found', `<h1>Player not found</h1><p><a href="/">← Standings</a></p>`, publicNav);
  }

  const since = await db.lastSeasonClose(c.env.DB);
  const history = await db.playerSeasonHistory(c.env.DB, phone, since);
  const stats = seasonStats(history);
  const rank = (await db.standings(c.env.DB, since)).findIndex((r) => r.phone === phone);
  const chips = (badgesForAll(await db.attendanceHistory(c.env.DB))[phone] ?? [])
    .map((b) => `<span class="chip">${b}</span>`)
    .join('');

  const name = member.display_name ?? 'New player';
  const statStrip =
    `<div class="stats">` +
    `<div class="stat"><strong>${stats.games}</strong><span>Games</span></div>` +
    `<div class="stat"><strong>${stats.wins}</strong><span>Wins</span></div>` +
    `<div class="stat"><strong>${stats.top5Rate}%</strong><span>Top-5 rate</span></div>` +
    `<div class="stat"><strong>${stats.points}</strong><span>Points</span></div>` +
    `</div>`;

  const log = history.length
    ? `<table><thead><tr><th>Date</th><th>Result</th><th style="text-align:right">Pts</th></tr></thead><tbody>` +
      history
        .map((g) => {
          const pts = g.is_tournament ? 0 : (g.points ?? 0);
          return (
            `<tr><td><a href="/game/${esc(g.game_id)}">${esc(formatWhen(g.starts_at, c.env.TIMEZONE))}</a></td>` +
            `<td>${placeOrdinal(g.place)}${g.is_tournament ? ' <span class="pill">🏆 tournament</span>' : ''}</td>` +
            `<td style="text-align:right">${g.is_tournament ? '—' : pts}</td></tr>`
          );
        })
        .join('') +
      `</tbody></table>`
    : `<p class="muted">No games this season yet.</p>`;

  const body =
    `<h1>${rank >= 0 ? `${rankBadge(rank)} ` : ''}${esc(name)}${chips}</h1>` +
    statStrip +
    `<h2>Game log</h2>${log}` +
    `<p class="muted" style="margin-top:2rem">Season scope — resets at each Special Players tournament. ` +
    `<a href="/seasons">Past seasons</a></p>` +
    `<p class="muted"><a href="/">← Standings</a></p>`;

  return layout(`${name} — ${c.env.PROGRAM_NAME}`, body, publicNav);
});

// ---- season history --------------------------------------------------------

publicRoutes.get('/seasons', async (c) => {
  const since = await db.lastSeasonClose(c.env.DB);
  const current = await db.standings(c.env.DB, since);
  const seasons = (await db.listSeasons(c.env.DB)).map((s, i) => ({ ...s, n: i + 1 })); // n: chronological

  // The champion is the tournament's actual 1st-place finisher once results are
  // entered; until then we fall back to the top seed (points leader at close).
  const pastHtml = seasons.length
    ? (
        await Promise.all(
          seasons
            .slice()
            .reverse() // most recent first
            .map(async (s) => {
              const invited = s.snapshot.invited ?? [];
              const winner = s.snapshot.gameId ? await db.champion(c.env.DB, s.snapshot.gameId) : null;
              const champPhone = winner?.phone ?? invited[0]?.phone ?? null;
              const champName = winner?.name ?? invited[0]?.name ?? '—';
              const decided = !!winner;
              const list = invited.length
                ? `<ol>` +
                  invited
                    .map((p) => `<li>${p.phone === champPhone ? '🏆 ' : ''}${esc(p.name ?? 'Player')}</li>`)
                    .join('') +
                  `</ol>`
                : `<p class="muted">No players recorded.</p>`;
              const champLine = decided
                ? `<p>🏆 Champion: <strong>${esc(champName)}</strong></p>`
                : `<p>🏆 Top seed: <strong>${esc(champName)}</strong> <span class="muted">(tournament result not recorded)</span></p>`;
              return (
                `<h3>Season ${s.n} <span class="muted">— ended ${esc(formatWhen(s.closed_at, c.env.TIMEZONE))}</span></h3>` +
                champLine +
                `<p class="muted">Special Players (invited to the tournament):</p>${list}`
              );
            }),
        )
      ).join('')
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
