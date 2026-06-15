/** /admin/* — host web app behind password auth (ADR-0005 §2). */
import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import type { Env, Member } from '../types';
import { layout, adminNav, esc } from '../lib/html';
import { formatWhen, formatDateOnly } from '../lib/messages';
import { pointsForPlace } from '../lib/points';
import { setSession, requireAuth } from '../lib/auth';
import { broadcast, awardRewardsForAttendees } from '../lib/jobs';
import { tournamentInvite, seatOpenedInvite } from '../lib/messages';
import { RECURRING, zonedToUtcIso, gameLocalDates } from '../lib/schedule';
import * as db from '../lib/db';

export const admin = new Hono<{ Bindings: Env }>();

// Auth gate for everything except the login/logout endpoints.
admin.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/admin/login' || path === '/admin/logout') return next();
  return requireAuth(c, next);
});

// ---- login / logout -------------------------------------------------------

admin.get('/login', (c) =>
  layout(
    'Admin login',
    `<h1>Admin login</h1><form class="stack" method="post" action="/admin/login">` +
      `<label>Password<input type="password" name="password" autofocus></label>` +
      `<button class="primary" type="submit">Sign in</button></form>`,
  ),
);

admin.post('/login', async (c) => {
  const form = new URLSearchParams(await c.req.text());
  if (form.get('password') === c.env.ADMIN_PASSWORD && c.env.ADMIN_PASSWORD) {
    await setSession(c);
    return c.redirect('/admin/games');
  }
  return layout(
    'Admin login',
    `<h1>Admin login</h1><p class="warn">Wrong password.</p>` +
      `<form class="stack" method="post" action="/admin/login">` +
      `<label>Password<input type="password" name="password" autofocus></label>` +
      `<button class="primary" type="submit">Sign in</button></form>`,
  );
});

admin.get('/logout', (c) => {
  deleteCookie(c, 'pp_session', { path: '/' });
  return c.redirect('/admin/login');
});

admin.get('/', (c) => c.redirect('/admin/games'));

// ---- games + scheduling ---------------------------------------------------

admin.get('/games', async (c) => {
  const games = await db.listGames(c.env.DB);
  const now = new Date().toISOString();
  const list = games.length
    ? `<table><thead><tr><th>Date</th><th></th></tr></thead><tbody>` +
      games
        .map((g) => {
          const tag = g.cancelled
            ? ' <span class="pill warn">cancelled</span>'
            : g.is_tournament
              ? ' <span class="pill">🏆</span>'
              : '';
          const primary = g.cancelled
            ? `<span class="muted">—</span>`
            : `<a href="/admin/games/${esc(g.id)}">Results →</a>`;
          const skip =
            !g.cancelled && g.starts_at > now
              ? `<form method="post" action="/admin/games/${esc(g.id)}/cancel">` +
                `<button type="submit">Skip</button></form>`
              : '';
          const del =
            `<form method="post" action="/admin/games/${esc(g.id)}/delete" ` +
            `onsubmit="return confirm('Delete this game and its results? This cannot be undone.')">` +
            `<button type="submit" class="danger">Delete</button></form>`;
          const menu =
            `<details class="menu"><summary aria-label="More actions">⋯</summary>` +
            `<div class="menu-body">${skip}${del}</div></details>`;
          return (
            `<tr><td>${esc(formatDateOnly(g.starts_at, c.env.TIMEZONE))}${tag}</td>` +
            `<td>${primary} ${menu}</td></tr>`
          );
        })
        .join('') +
      `</tbody></table>`
    : `<p class="muted">No games yet.</p>`;

  const form =
    `<h2>Schedule a game</h2>` +
    `<form class="stack" method="post" action="/admin/games">` +
    `<label>Date<input type="date" name="date" required></label>` +
    `<label class="row"><input type="checkbox" name="is_tournament" value="1"> Special Players tournament</label>` +
    `<button class="primary" type="submit">Schedule</button>` +
    `<p class="muted">Every game uses these standard details ` +
    `(change in <code>src/lib/schedule.ts</code> if they ever do):<br>` +
    `🕡 ${to12h(RECURRING.time)} ${esc(c.env.TIMEZONE)} · 📍 ${esc(RECURRING.location)} · ` +
    `🚬 ${esc(RECURRING.buyIn)} · 🃏 ${esc(RECURRING.description)}<br>` +
    `Past dates are allowed (backfill).</p>` +
    `</form>`;

  const dup =
    c.req.query('err') === 'dup'
      ? `<p class="warn">⚠️ A game already exists on that date — only one game per day. Delete the existing one if you need to replace it.</p>`
      : '';
  return layout('Games', `<h1>Games</h1>${dup}${list}${form}`, adminNav);
});

admin.post('/games', async (c) => {
  const f = new URLSearchParams(await c.req.text());
  const date = f.get('date') ?? '';
  if (!date) return c.redirect('/admin/games');

  // One game per day — reject if a non-cancelled game is already on that date.
  const occupied = gameLocalDates(await db.listGames(c.env.DB), c.env.TIMEZONE);
  if (occupied.has(date)) return c.redirect('/admin/games?err=dup');

  // Only date + tournament flag are chosen; time/place/buy-in/game are the
  // standard values from src/lib/schedule.ts.
  await db.createGame(
    c.env.DB,
    {
      starts_at: zonedToUtcIso(`${date}T${RECURRING.time}`, c.env.TIMEZONE),
      location: RECURRING.location,
      is_tournament: f.get('is_tournament') === '1',
      description: RECURRING.description,
      buy_in: RECURRING.buyIn,
    },
    new Date().toISOString(),
  );
  return c.redirect('/admin/games');
});

admin.post('/games/:id/cancel', async (c) => {
  await db.cancelGame(c.env.DB, c.req.param('id'));
  return c.redirect('/admin/games');
});

admin.post('/games/:id/delete', async (c) => {
  await db.deleteGame(c.env.DB, c.req.param('id'));
  return c.redirect('/admin/games');
});

// ---- post-game: attendance + winners --------------------------------------

admin.get('/games/:id', async (c) => {
  const game = await db.getGame(c.env.DB, c.req.param('id'));
  if (!game) return layout('Not found', `<p>Game not found.</p>`, adminNav);

  const when = esc(formatWhen(game.starts_at, c.env.TIMEZONE));
  const members = await db.listMembers(c.env.DB);
  if (members.length === 0) {
    return layout(
      'Post-game',
      `<h1>${when}</h1><p class="warn">No members yet — players must text JOIN first.</p>`,
      adminNav,
    );
  }

  // Prefill from any existing result so this screen also edits past games.
  // Tournament games now prefill too — their ranks are stored with 0 points.
  const existing = await db.pointsForGame(c.env.DB, game.id);
  const placePhone: Record<number, string> = {};
  for (const row of existing) if (row.place) placePhone[row.place] = row.member_phone;
  const attended = new Set(await db.attendeesForGame(c.env.DB, game.id));
  const editing = existing.length > 0;

  const options = (sel = '') =>
    `<option value="">—</option>` +
    members.map((m) => `<option value="${esc(m.phone)}"${m.phone === sel ? ' selected' : ''}>${esc(m.display_name ?? m.phone)}</option>`).join('');

  const winnerSelects = [1, 2, 3, 4, 5]
    .map((p) => `<label>${ordinal(p)} place<select name="place${p}">${options(placePhone[p] ?? '')}</select></label>`)
    .join('');

  const attendanceRows = members
    .map(
      (m) =>
        `<label class="row"><input type="checkbox" name="attend" value="${esc(m.phone)}"${attended.has(m.phone) ? ' checked' : ''}> ${esc(m.display_name ?? m.phone)}</label>`,
    )
    .join('');

  const title = editing ? 'Edit results' : 'Post-game';
  const note = editing
    ? `<p class="muted">Re-saving <strong>replaces</strong> this game's recorded result (winners + attendance).</p>`
    : '';
  const body =
    `<h1>${title} — ${when}</h1>${note}` +
    `<form class="stack" method="post" action="/admin/games/${esc(game.id)}/result">` +
    `<h2>Top 5 (5·4·3·2·1 pts)</h2>${winnerSelects}` +
    `<h2>Who attended?</h2><p class="muted">Winners count automatically.</p>${attendanceRows}` +
    `<label class="row"><input type="checkbox" name="is_tournament" value="1"${game.is_tournament ? ' checked' : ''}> 🏆 Special Players tournament <span class="muted">(no season points)</span></label>` +
    `<button class="primary" type="submit">Save results</button></form>`;

  return layout(title, body, adminNav);
});

admin.post('/games/:id/result', async (c) => {
  const game = await db.getGame(c.env.DB, c.req.param('id'));
  if (!game) return c.redirect('/admin/games');

  const f = new URLSearchParams(await c.req.text());
  const now = new Date().toISOString();
  const isTournament = f.get('is_tournament') === '1';

  // Re-entry replaces this game's result wholesale, so edits are clean (ADR-0002).
  await db.clearGameResults(c.env.DB, game.id);
  await db.clearAttendanceForGame(c.env.DB, game.id);

  // Record the finishing place for every filled slot so the result is preserved
  // for ANY game. Points follow the ACTUAL place selected (place 1 = 5 pts …
  // place 5 = 1 pt). **Special Players tournament games award NO season points**
  // (D5/ADR-0007): the rank is still saved (so the champion + finishing order
  // are kept) but with 0 points, so standings are untouched. Dedup keeps a
  // player's highest place if listed twice.
  const winners: string[] = [];
  for (const p of [1, 2, 3, 4, 5]) {
    const phone = f.get(`place${p}`);
    if (phone && !winners.includes(phone)) {
      winners.push(phone);
      await db.recordPlacement(c.env.DB, phone, game.id, p, isTournament ? 0 : pointsForPlace(p - 1), now);
    }
  }

  // Attendance = checked ∪ winners.
  const attendees = new Set<string>([...f.getAll('attend'), ...winners]);
  for (const phone of attendees) await db.markAttendance(c.env.DB, phone, game.id, now);

  await db.setGameTournament(c.env.DB, game.id, isTournament);
  await awardRewardsForAttendees(c.env, [...attendees], now);
  return c.redirect('/admin/standings');
});

// ---- standings ------------------------------------------------------------

admin.get('/standings', async (c) => {
  const since = await db.lastSeasonClose(c.env.DB);
  const rows = await db.standings(c.env.DB, since);
  const table = rows.length
    ? `<table><thead><tr><th>#</th><th>Player</th><th>Pts</th></tr></thead><tbody>` +
      rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.display_name ?? r.phone)}</td><td>${r.total}</td></tr>`).join('') +
      `</tbody></table>`
    : `<p class="muted">No points this season yet.</p>`;
  return layout('Standings', `<h1>Standings (this season)</h1>${table}`, adminNav);
});

// ---- tournament: pick 8, invite, reset ------------------------------------

/**
 * RSVP tracker for the latest tournament (ADR-0006): who confirmed (replied
 * IN), who hasn't, who's next in line on the CLOSED season's leaderboard with
 * a one-click backfill invite. Returns '' once the tournament has happened
 * (or after 45 days if no game was ever attached).
 */
async function rsvpTrackerHtml(env: Env, members: Member[]): Promise<string> {
  const season = await db.latestSeason(env.DB);
  if (!season) return '';
  const rsvps = await db.rsvpsForSeason(env.DB, season.id);
  if (rsvps.length === 0) return ''; // pre-RSVP season close (or nobody texted)

  const nowIso = new Date().toISOString();
  const game = season.snapshot.gameId ? await db.getGame(env.DB, season.snapshot.gameId) : null;
  const staleNoGame = !game && Date.now() - new Date(season.closed_at).getTime() > 45 * 86400_000;
  if ((game && game.starts_at <= nowIso) || staleNoGame) return '';

  const nameByPhone = new Map(members.map((m) => [m.phone, m.display_name]));
  const statusByPhone = new Map(members.map((m) => [m.phone, m.status]));
  const snapshotInvited = season.snapshot.invited ?? [];
  const nameOf = (phone: string) =>
    nameByPhone.get(phone) ?? snapshotInvited.find((i) => i.phone === phone)?.name ?? phone;

  // Snapshot order first (the original top 8), then backfills in invite order.
  const rsvpByPhone = new Map(rsvps.map((r) => [r.member_phone, r]));
  const ordered = [
    ...snapshotInvited.map((i) => i.phone),
    ...rsvps.map((r) => r.member_phone).filter((p) => !snapshotInvited.some((i) => i.phone === p)),
  ];

  let confirmed = 0;
  const rows = ordered
    .map((phone) => {
      const rsvp = rsvpByPhone.get(phone);
      let status: string;
      if (!rsvp) {
        status = `<span class="pill">🚫</span> <span class="muted">opted out — not texted</span>`;
      } else if (rsvp.confirmed_at) {
        confirmed++;
        status = `<span class="pill">✅</span> confirmed ${esc(formatDateOnly(rsvp.confirmed_at, env.TIMEZONE))}`;
      } else {
        status = `<span class="pill">⏳</span> <span class="muted">no reply yet</span>`;
      }
      return `<tr><td>${esc(nameOf(phone))}</td><td>${status}</td></tr>`;
    })
    .join('');

  // Next in line = the closed season's standings below the already-invited.
  const prevClose = await db.seasonCloseBefore(env.DB, season.closed_at);
  const closedStandings = await db.standings(env.DB, prevClose, season.closed_at);
  const alreadyInvited = new Set(ordered);
  const nextUp = closedStandings
    .map((r, i) => ({ ...r, rank: i + 1 }))
    .filter((r) => !alreadyInvited.has(r.phone))
    .slice(0, 5);

  const nextRows = nextUp.length
    ? nextUp
        .map((r) => {
          const optedOut = statusByPhone.get(r.phone) !== 'SUBSCRIBED';
          const action = optedOut
            ? `<span class="muted">🚫 opted out</span>`
            : `<form method="post" action="/admin/tournament/backfill">` +
              `<input type="hidden" name="phone" value="${esc(r.phone)}">` +
              `<button type="submit">Send invite</button></form>`;
          return `<tr><td>#${r.rank} ${esc(r.display_name ?? r.phone)} <span class="muted">(${r.total} pts)</span></td><td>${action}</td></tr>`;
        })
        .join('')
    : `<tr><td colspan="2" class="muted">Nobody left on last season's board.</td></tr>`;

  const when = game ? ` — ${esc(formatWhen(game.starts_at, env.TIMEZONE))}` : '';
  return (
    `<h2>Seat confirmations${when}</h2>` +
    `<p class="muted">${confirmed} of ${ordered.length} confirmed. Invitees reply <strong>IN</strong> to lock their seat. ` +
    `When you decide a seat has gone unclaimed, invite the next player below — the system never gives a seat away on its own.</p>` +
    `<table><tbody>${rows}</tbody></table>` +
    `<h3>Next in line (last season's board)</h3>` +
    `<table><tbody>${nextRows}</tbody></table>`
  );
}

admin.get('/tournament', async (c) => {
  const since = await db.lastSeasonClose(c.env.DB);
  const rows = await db.standings(c.env.DB, since);
  const games = (await db.listGames(c.env.DB)).filter((g) => g.is_tournament === 1);
  const members = await db.listMembers(c.env.DB);
  const statusByPhone = new Map(members.map((m) => [m.phone, m.status]));
  const tracker = await rsvpTrackerHtml(c.env, members);

  // Opted-out players stay checkable (they earned their snapshot seat) — the
  // 🚫 is informational only; the backend guarantees no text goes out.
  const checkboxes = rows.length
    ? rows
        .map((r, i) => {
          const optedOut = statusByPhone.get(r.phone) !== 'SUBSCRIBED';
          return (
            `<label class="row"><input type="checkbox" name="invite" value="${esc(r.phone)}"${i < 8 ? ' checked' : ''}> ` +
            `#${i + 1} ${esc(r.display_name ?? r.phone)} <span class="muted">(${r.total} pts)</span>` +
            (optedOut ? ` <span class="pill">🚫</span> <span class="muted">(opted out — won't be texted)</span>` : '') +
            `</label>`
          );
        })
        .join('') +
      `<p class="muted">Players marked 🚫 have opted out of texts; they keep their seat in the snapshot but no invite SMS is sent.</p>`
    : `<p class="muted">No standings yet — nobody to invite.</p>`;

  const gameOptions =
    `<option value="">(no specific game)</option>` +
    games.map((g) => `<option value="${esc(g.id)}">${esc(formatWhen(g.starts_at, c.env.TIMEZONE))} — ${esc(g.location)}</option>`).join('');

  const nowIso = new Date().toISOString();
  const hasUpcomingTournamentGame = games.some((g) => !g.cancelled && g.starts_at > nowIso);
  const scheduleTip = hasUpcomingTournamentGame
    ? ''
    : `<p class="muted">💡 Schedule the tournament game first (<a href="/admin/games">Games</a>, tournament toggle) ` +
      `so the invite carries the date and "confirm by" makes sense to players.</p>`;

  const body =
    `<h1>Special Players tournament</h1>` +
    tracker +
    `<h2>Run a new tournament</h2>` +
    `<p class="muted">Top 8 are pre-checked. Adjust to break any tie, then send invites. ` +
    `This <strong>resets the season</strong> (logical — nothing is deleted).</p>` +
    scheduleTip +
    `<form class="stack" method="post" action="/admin/tournament/run">` +
    `<label>Tournament game (optional)<select name="game_id">${gameOptions}</select></label>` +
    `<label>Confirm by (optional, goes in the text — e.g. "Friday")` +
    `<input type="text" name="confirm_by" maxlength="40" placeholder="Friday"></label>` +
    checkboxes +
    `<button class="primary" type="submit">Send invites &amp; reset season</button></form>`;

  return layout('Tournament', body, adminNav);
});

// Backfill: text the next player on the closed season's board and add them to
// the RSVP roster. Host-initiated only — no automated seat reassignment.
admin.post('/tournament/backfill', async (c) => {
  const f = new URLSearchParams(await c.req.text());
  const phone = f.get('phone');
  const season = await db.latestSeason(c.env.DB);
  if (!phone || !season) return c.redirect('/admin/tournament');

  const member = await db.getMember(c.env.DB, phone);
  if (member?.status !== 'SUBSCRIBED') return c.redirect('/admin/tournament');

  const game = season.snapshot.gameId ? await db.getGame(c.env.DB, season.snapshot.gameId) : null;
  const now = new Date().toISOString();
  await broadcast(c.env, [phone], seatOpenedInvite(c.env, game));
  await db.createRsvp(c.env.DB, season.id, phone, now);
  return c.redirect('/admin/tournament');
});

admin.post('/tournament/run', async (c) => {
  const f = new URLSearchParams(await c.req.text());
  const invited = f.getAll('invite');
  if (invited.length === 0) return c.redirect('/admin/tournament');

  const game = f.get('game_id') ? await db.getGame(c.env.DB, f.get('game_id')!) : null;
  const now = new Date().toISOString();

  // Snapshot names before reset so the close record is self-contained. An
  // opted-out player keeps their earned seat in the snapshot (honest history,
  // shows on /seasons) but is NEVER texted — STOP compliance is authoritative
  // here (and again inside broadcast as defense in depth).
  const snapshot: Array<{ phone: string; name: string | null; optedOut?: boolean }> = [];
  const toText: string[] = [];
  for (const phone of invited) {
    const m = await db.getMember(c.env.DB, phone);
    const entry: { phone: string; name: string | null; optedOut?: boolean } = { phone, name: m?.display_name ?? null };
    if (m?.status === 'SUBSCRIBED') toText.push(phone);
    else entry.optedOut = true;
    snapshot.push(entry);
  }
  const optedOutCount = invited.length - toText.length;

  const confirmBy = (f.get('confirm_by') ?? '').trim();
  const res = await broadcast(c.env, toText, tournamentInvite(c.env, game, confirmBy || undefined));
  const seasonId = await db.closeSeason(c.env.DB, { invited: snapshot, gameId: game?.id ?? null, sent: res.sent }, now);
  // RSVP rows only for players actually texted — opted-out seats stay in the
  // snapshot (honest history) but can't be confirmed by SMS.
  for (const phone of toText) await db.createRsvp(c.env.DB, seasonId, phone, now);

  const optedOutNote =
    optedOutCount > 0
      ? ` ${optedOutCount} top-8 player${optedOutCount === 1 ? ' has' : 's have'} opted out of texts and ${optedOutCount === 1 ? 'was' : 'were'} not messaged;`
      : '';
  return layout(
    'Tournament started',
    `<h1>🏆 Invites sent</h1><p class="ok">Invited ${res.sent} player(s);${optedOutNote} season reset.</p>` +
      `<p>Players reply <strong>IN</strong> to lock their seat — track confirmations on the ` +
      `<a href="/admin/tournament">Tournament page</a>.</p>` +
      `<p><a href="/admin/standings">View the fresh standings →</a></p>`,
    adminNav,
  );
});

// ---- roster + rewards -----------------------------------------------------

admin.get('/roster', async (c) => {
  const members = await db.listMembers(c.env.DB);
  const rewards = await db.listAwardedRewards(c.env.DB);
  const visits = await db.attendanceCounts(c.env.DB);

  const memberRows = members.length
    ? members
        .map(
          (m: Member) =>
            `<form class="row" method="post" action="/admin/roster/name">` +
            `<input type="hidden" name="phone" value="${esc(m.phone)}">` +
            `<input type="text" name="name" value="${esc(m.display_name ?? '')}" placeholder="First L" style="flex:1">` +
            `<span class="pill" title="games attended">🎲 ${visits[m.phone] ?? 0}</span>` +
            `<span class="pill">${m.status === 'SUBSCRIBED' ? '✅' : '🚫'}</span>` +
            `<button type="submit">Save</button></form>`,
        )
        .join('')
    : `<p class="muted">No members yet.</p>`;

  const rewardRows = rewards.length
    ? `<table><thead><tr><th>Player</th><th>Reward</th><th>Status</th></tr></thead><tbody>` +
      rewards
        .map(
          (r) =>
            `<tr><td>${esc(r.display_name ?? r.member_phone)}</td><td>${esc(r.reward_text)}</td><td>` +
            (r.redeemed_at
              ? `<span class="muted">redeemed</span>`
              : `<form method="post" action="/admin/rewards/redeem"><input type="hidden" name="id" value="${esc(r.id)}"><button type="submit">Mark redeemed</button></form>`) +
            `</td></tr>`,
        )
        .join('') +
      `</tbody></table>`
    : `<p class="muted">No promos earned yet.</p>`;

  return layout('Roster', `<h1>Roster</h1>${memberRows}<h2>Earned promos</h2>${rewardRows}`, adminNav);
});

admin.post('/roster/name', async (c) => {
  const f = new URLSearchParams(await c.req.text());
  const phone = f.get('phone');
  const name = (f.get('name') ?? '').trim();
  if (phone && name) await db.updateDisplayName(c.env.DB, phone, name, new Date().toISOString());
  return c.redirect('/admin/roster');
});

admin.post('/rewards/redeem', async (c) => {
  const f = new URLSearchParams(await c.req.text());
  const id = f.get('id');
  if (id) await db.markRewardRedeemed(c.env.DB, id, new Date().toISOString());
  return c.redirect('/admin/roster');
});

// ---------------------------------------------------------------------------

function ordinal(n: number): string {
  return ['1st', '2nd', '3rd', '4th', '5th'][n - 1] ?? `${n}th`;
}

/** "18:30" -> "6:30 PM". */
function to12h(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}
