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
import * as db from '../lib/db';
import { publicName } from '../lib/public-name';
import { listTournamentPlans } from '../lib/tournament';

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
  return r ? ` <span class="card sm" aria-hidden="true">${r}<small>♠</small></span>` : '';
}

function standingsTable(
  rows: StandingRow[],
  badges: Record<string, string[]> = {},
  idByPhone?: Map<string, string>,
): string {
  if (!rows.length) return `<p class="muted">No points yet this season — check back after the next game.</p>`;
  return (
    `<table><caption>Current points · qualification is provisional</caption><thead><tr><th scope="col">Position</th><th scope="col">Player</th><th scope="col" style="text-align:right">Points</th></tr></thead><tbody>` +
    rows
      .map((r, i) => {
        const chips = (badges[r.phone] ?? []).map((b) => `<span class="chip">${b}</span>`).join('');
        const cls = i < 3 ? ` class="r${i + 1}"` : '';
        const name = esc(publicName(r.display_name));
        const pid = idByPhone?.get(r.phone); // opaque hash id — never the phone (ADR-0005)
        const nameHtml = pid ? `<a class="player" href="/player/${esc(pid)}">${name}</a>` : name;
        const row =
          `<tr${cls}><td>${rankBadge(i)}</td><td>${nameHtml}${faceCard(i)}${chips ? `<span class="badges">${chips}</span>` : ''}</td>` +
          `<td style="text-align:right">${r.total}</td></tr>`;
        // Tournament-qualification cut: a labelled line after the top 8 (only
        // when there's a 9th player to separate from).
        const cut =
          i === 7 && rows.length > 8
            ? `<tr class="cutline"><td colspan="3">${rows[8]?.total === r.total ? 'Tie at the cutoff · host decision required' : 'Current top-eight qualification line'}</td></tr>`
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
  const idByPhone = new Map(rows.filter(r=>r.public_id).map(r=>[r.phone,r.public_id!]));

  // Next-game banner — the auto-scheduler keeps the next biweekly game
  // materialized. "Next game" is always the next REGULAR night (with the JOIN
  // nudge); an upcoming Special Players tournament gets its own invite-only
  // notice instead, so nobody shows up thinking it's open poker (ADR-0008).
  const nowIso = new Date().toISOString();
  const nextAny = await db.nextUpcomingGame(c.env.DB, nowIso);
  const next = nextAny?.is_tournament ? await db.nextUpcomingGame(c.env.DB, nowIso, true) : nextAny;
  const scheduled = (await listTournamentPlans(c.env.DB)).filter(p=>p.status!=='CANCELLED' && p.status!=='COMPLETED' && p.planned_starts_at>nowIso).sort((a,b)=>a.planned_starts_at.localeCompare(b.planned_starts_at))[0];
  const tournamentInfo = scheduled ? `<div class="season-note"><p><strong>Invitation-only tournament: ${esc(formatWhen(scheduled.planned_starts_at,c.env.TIMEZONE))}</strong></p>`+
    `<p>${scheduled.season_id ? 'Qualification closed' : 'Qualification closes'}: ${esc(formatWhen(scheduled.qualification_cutoff,c.env.TIMEZONE))}. `+
    `${scheduled.blocked_reason ? 'The host is resolving qualification details. ' : scheduled.season_id ? 'Invitations are being managed for the qualified players. ' : 'The top eight earn invitations; a tie for the final seats needs a host decision. '}`+
    `</p><details><summary>Invitation details</summary><p>If invited, reply CALL by ${esc(formatWhen(scheduled.confirmation_deadline,c.env.TIMEZONE))}, or FOLD to pass. STOP ends texts. Joining reminders does not reserve a tournament seat.</p></details></div>` : '';
  const joinLink =
    `<a href="sms:${c.env.TWILIO_FROM_NUMBER}?&amp;body=JOIN" style="color:#f7f1e3">` +
    `text JOIN to ${esc(formatUs(c.env.TWILIO_FROM_NUMBER))}</a>`;
  const tournamentBanner = nextAny?.is_tournament
    ? `<div class="hero tourney"><span class="card">🏆</span>` +
      `<div><strong>Special Players tournament: ${esc(formatWhen(nextAny.starts_at, c.env.TIMEZONE))}</strong>` +
      `<div class="muted">Invitation only — the season's top 8 play for the title. Not a regular game night` +
      `${next ? '; the next one is below' : ''}. <a href="/seasons" style="color:#f7f1e3">Past champions</a></div></div></div>`
    : '';
  const nextBanner = next
    ? `<div class="hero"><span class="card">🗓</span>` +
      `<div><strong>Next game night: ${esc(formatWhen(next.starts_at, c.env.TIMEZONE))}</strong>` +
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
      `<p class="muted"><strong>${esc(publicName(leader.display_name))}</strong> leads — ` +
      (gap === 0
        ? `tied on points with ${esc(publicName(runnerUp.display_name))}.`
        : `${esc(publicName(runnerUp.display_name))} is ${gap} point${gap===1 ? '' : 's'} back.`) +
      `</p>`;
  }

  const recentWinners = new Map(await Promise.all(recent.map(async g => [g.id, (await db.champions(c.env.DB,g.id)).map(w=>publicName(w.name)).join(' & ')] as const)));
  const recentHtml = recent.length
    ? `<ul>` +
      recent
        .map(
          (g) =>
            `<li><a href="/game/${esc(g.id)}">${esc(formatWhen(g.starts_at, c.env.TIMEZONE))}</a>` +
            `${g.is_tournament ? ' <span class="pill">🏆</span>' : ''}` +
            `${recentWinners.get(g.id) ? ` — won by <strong>${esc(recentWinners.get(g.id))}</strong>` : ''}</li>`,
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
    tournamentBanner +
    nextBanner +
    `<h2>Current season standings</h2>` +
    tournamentInfo +
    raceLine +
    `${standingsTable(rows, badges, idByPhone)}${badgeLegend}` +
    `<p class="muted">Regular games award <strong>5, 4, 3, 2, 1 points</strong> for places 1–5. ` +
    `The top eight at qualification close earn tournament invitations. Equal scores are displayed by earliest last scoring result; the host decides ties for the final seats. ` +
    `<a href="/rules#qualification">How qualification works</a>.</p>` +
    `<p class="muted">Points reset at qualification close, before the tournament. ${since ? `Current season began ${esc(formatWhen(since,c.env.TIMEZONE))}. ` : ''}<a href="/seasons">Past seasons</a>.</p>` +
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
            `<tr><td>${placeOrdinal(r.place)}</td><td>${esc(publicName(r.display_name))}</td>` +
            `<td>${game.is_tournament ? '—' : r.points}</td></tr>`,
        )
        .join('') +
      `</tbody></table>`
    : `<p class="muted">No results recorded for this game yet.</p>`;

  const heading = game.is_tournament ? 'Recorded tournament results · top five' : 'Recorded results · top five';
  const body =
    `<h1>${when}${game.is_tournament ? ' <span class="pill">🏆 tournament</span>' : ''}</h1>` +
    `<p class="muted">${esc(game.location)}${game.is_tournament ? ' — championship results; no season points' : ''}</p>` +
    `<h2>${heading}</h2>${table}` +
    `<p class="muted" style="margin-top:2rem"><a href="/">← Standings</a> · <a href="/seasons">Seasons</a></p>`;

  return layout(`Game ${when} — ${c.env.PROGRAM_NAME}`, body, publicNav);
});

// ---- a player's current-season profile --------------------------------------
// URL ids are opaque SHA-256 hashes (lib/playerId.ts) — phones never appear in
// public URLs or markup (privacy promise, ADR-0005 §3).

publicRoutes.get('/player/:id', async (c) => {
  const member = await c.env.DB.prepare('SELECT * FROM members WHERE public_id=?').bind(c.req.param('id')).first<import('../types').Member>();
  const phone = member?.phone;
  if (!phone || !member) {
    return layout('Not found', `<h1>Player not found</h1><p><a href="/">← Standings</a></p>`, publicNav);
  }

  const since = await db.lastSeasonClose(c.env.DB);
  const history = await db.playerSeasonHistory(c.env.DB, phone, since);
  const stats = seasonStats(history);
  const board = await db.standings(c.env.DB, since);
  const rank = board.findIndex((r) => r.phone === phone);
  const chips = (badgesForAll(await db.attendanceHistory(c.env.DB))[phone] ?? [])
    .map((b) => `<span class="chip">${b}</span>`)
    .join('');

  const name = publicName(member.display_name);
  const statStrip =
    `<div class="stats">` +
    `<div class="stat"><strong>${stats.games}</strong><span>Regular games</span></div>` +
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
            `<tr><td><a href="/game/${esc(g.game_id)}">${esc(new Intl.DateTimeFormat('en-US',{timeZone:c.env.TIMEZONE,month:'short',day:'numeric',year:'numeric'}).format(new Date(g.starts_at)))}</a></td>` +
            `<td>${placeOrdinal(g.place)}${g.is_tournament ? ' <span class="pill">🏆 tournament</span>' : ''}</td>` +
            `<td style="text-align:right">${g.is_tournament ? '—' : pts}</td></tr>`
          );
        })
        .join('') +
      `</tbody></table>`
    : `<p class="muted">No games this season yet.</p>`;

  const body =
    `<h1>${esc(name)}</h1><p>${rank >= 0 ? `Position ${rankBadge(rank)} · ${board[rank]?.total} points · ` : ''}` +
    `${rank < 0 ? 'No season points yet.' : board[7] && board[8]?.total === board[7].total && board[rank]?.total === board[7].total ? 'Tied at the qualification cutoff — host decision required.' : rank < 8 ? 'Currently inside the top eight.' : `${(board[7]?.total ?? 0) - (board[rank]?.total ?? 0)} points behind the current cutoff; matching it creates a tie.`}</p>${chips}` +
    `<p class="muted">Qualification is still open. Keep playing regular nights to earn points. If invited, reply CALL to confirm or FOLD to pass.</p>` +
    statStrip +
    `<h2>Game log</h2>${log}` +
    `<p class="muted" style="margin-top:2rem">Statistics cover regular games in the current season. Points reset at qualification close, before the tournament. ` +
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
              const winners = s.snapshot.gameId ? await db.champions(c.env.DB, s.snapshot.gameId) : [];
              const champPhones = new Set(winners.map(w=>w.phone));
              const champName = winners.map(w=>publicName(w.name)).join(' & ');
              const decided = winners.length > 0;
              const list = invited.length
                ? `<ol>` +
                  invited
                    .map((p) => `<li>${champPhones.has(p.phone) ? '🏆 ' : ''}${esc(publicName(p.name))}</li>`)
                    .join('') +
                  `</ol>`
                : `<p class="muted">No players recorded.</p>`;
              const champLine = decided
                ? `<p>🏆 ${winners.length > 1 ? 'Co-champions' : 'Champion'}: <strong>${esc(champName)}</strong></p>`
                : `<p class="muted">Tournament results not recorded yet.</p>`;
              return (
                `<h3>Season ${s.n} <span class="muted">— qualification closed ${esc(formatWhen(s.closed_at, c.env.TIMEZONE))}</span></h3>` +
                champLine +
                `${s.snapshot.gameId ? `<p><a href="/game/${esc(s.snapshot.gameId)}">Tournament results →</a></p>` : ''}` +
                `<p class="muted">Season qualifiers (the playing roster may include replacements):</p>${list}`
              );
            }),
        )
      ).join('')
    : `<p class="muted">No seasons completed yet.</p>`;

  const body =
    `<h1>Seasons</h1>` +
    `<p class="muted">Points reset when tournament qualification closes. The championship is played afterward and awards no season points.</p>` +
    `<p><a href="/">View current season standings →</a></p>` +
    `<h2>Past seasons</h2>${pastHtml}` +
    `<p class="muted" style="margin-top:2rem"><a href="/">← Standings</a></p>`;

  return layout(`Seasons — ${c.env.PROGRAM_NAME}`, body, publicNav);
});

// ---- static info pages -----------------------------------------------------

publicRoutes.get('/rules', (c) => rulesPage(c.env));
publicRoutes.get('/privacy', (c) => privacyPage(c.env));
publicRoutes.get('/terms', (c) => termsPage(c.env));
