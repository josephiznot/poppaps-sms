/** /admin/* — host web app behind password auth (ADR-0005 §2). */
import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import type { Env, Member } from '../types';
import { layout, adminNav, esc } from '../lib/html';
import { formatWhen } from '../lib/messages';
import { pointsForPlace } from '../lib/points';
import { setSession, requireAuth } from '../lib/auth';
import { broadcast, awardRewardsForAttendees } from '../lib/jobs';
import { tournamentInvite } from '../lib/messages';
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
  const list = games.length
    ? `<table><thead><tr><th>When</th><th>Where</th><th></th></tr></thead><tbody>` +
      games
        .map(
          (g) =>
            `<tr><td>${esc(formatWhen(g.starts_at, c.env.TIMEZONE))}` +
            `${g.is_tournament ? ' <span class="pill">🏆</span>' : ''}</td>` +
            `<td>${esc(g.location)}</td>` +
            `<td><a href="/admin/games/${esc(g.id)}">Results →</a></td></tr>`,
        )
        .join('') +
      `</tbody></table>`
    : `<p class="muted">No games yet.</p>`;

  const form =
    `<h2>Schedule a game</h2>` +
    `<form class="stack" method="post" action="/admin/games">` +
    `<label>Date<input type="date" name="date" required></label>` +
    `<label>Time<input type="time" name="time" required></label>` +
    `<label>Location<input type="text" name="location" value="Poppa P's" required></label>` +
    `<label>Buy-in <input type="text" name="buy_in" placeholder="2 cigars"></label>` +
    `<label>Note <input type="text" name="description" placeholder="Texas Hold'em"></label>` +
    `<label class="row"><input type="checkbox" name="is_tournament" value="1"> Special Players tournament</label>` +
    `<button class="primary" type="submit">Schedule</button>` +
    `<p class="muted">Times are ${esc(c.env.TIMEZONE)}. Past dates are allowed (backfill).</p>` +
    `</form>`;

  return layout('Games', `<h1>Games</h1>${list}${form}`, adminNav);
});

admin.post('/games', async (c) => {
  const f = new URLSearchParams(await c.req.text());
  const date = f.get('date') ?? '';
  const time = f.get('time') ?? '';
  const location = (f.get('location') ?? '').trim();
  if (!date || !time || !location) return c.redirect('/admin/games');

  await db.createGame(
    c.env.DB,
    {
      starts_at: zonedToUtcIso(`${date}T${time}`, c.env.TIMEZONE),
      location,
      is_tournament: f.get('is_tournament') === '1',
      description: (f.get('description') ?? '').trim() || undefined,
      buy_in: (f.get('buy_in') ?? '').trim() || undefined,
    },
    new Date().toISOString(),
  );
  return c.redirect('/admin/games');
});

// ---- post-game: attendance + winners --------------------------------------

admin.get('/games/:id', async (c) => {
  const game = await db.getGame(c.env.DB, c.req.param('id'));
  if (!game) return layout('Not found', `<p>Game not found.</p>`, adminNav);

  const when = esc(formatWhen(game.starts_at, c.env.TIMEZONE));
  if (await db.gameHasResults(c.env.DB, game.id)) {
    const attendees = await db.attendeesForGame(c.env.DB, game.id);
    return layout(
      'Results recorded',
      `<h1>${when}</h1><p class="ok">✅ Results already recorded.</p>` +
        `<p class="muted">${attendees.length} attendee(s). See <a href="/admin/standings">standings</a>.</p>`,
      adminNav,
    );
  }

  const members = await db.listMembers(c.env.DB);
  if (members.length === 0) {
    return layout(
      'Post-game',
      `<h1>${when}</h1><p class="warn">No members yet — players must text JOIN first.</p>`,
      adminNav,
    );
  }

  const options = (sel = '') =>
    `<option value="">—</option>` +
    members.map((m) => `<option value="${esc(m.phone)}"${m.phone === sel ? ' selected' : ''}>${esc(m.display_name ?? m.phone)}</option>`).join('');

  const winnerSelects = [1, 2, 3, 4, 5]
    .map((p) => `<label>${ordinal(p)} place<select name="place${p}">${options()}</select></label>`)
    .join('');

  const attendanceRows = members
    .map(
      (m) =>
        `<label class="row"><input type="checkbox" name="attend" value="${esc(m.phone)}"> ${esc(m.display_name ?? m.phone)}</label>`,
    )
    .join('');

  const body =
    `<h1>Post-game — ${when}</h1>` +
    `<form class="stack" method="post" action="/admin/games/${esc(game.id)}/result">` +
    `<h2>Top 5 (5·4·3·2·1 pts)</h2>${winnerSelects}` +
    `<h2>Who attended?</h2><p class="muted">Winners count automatically.</p>${attendanceRows}` +
    `<button class="primary" type="submit">Save results</button></form>`;

  return layout('Post-game', body, adminNav);
});

admin.post('/games/:id/result', async (c) => {
  const game = await db.getGame(c.env.DB, c.req.param('id'));
  if (!game) return c.redirect('/admin/games');
  if (await db.gameHasResults(c.env.DB, game.id)) return c.redirect('/admin/standings');

  const f = new URLSearchParams(await c.req.text());
  const now = new Date().toISOString();

  // Ordered winners (dedup, keep first occurrence).
  const winners: string[] = [];
  for (const p of [1, 2, 3, 4, 5]) {
    const phone = f.get(`place${p}`);
    if (phone && !winners.includes(phone)) winners.push(phone);
  }
  for (let i = 0; i < winners.length; i++) {
    await db.addPoints(c.env.DB, winners[i]!, game.id, pointsForPlace(i), now);
  }

  // Attendance = checked ∪ winners.
  const attendees = new Set<string>([...f.getAll('attend'), ...winners]);
  for (const phone of attendees) await db.markAttendance(c.env.DB, phone, game.id, now);

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

admin.get('/tournament', async (c) => {
  const since = await db.lastSeasonClose(c.env.DB);
  const rows = await db.standings(c.env.DB, since);
  const games = (await db.listGames(c.env.DB)).filter((g) => g.is_tournament === 1);

  const checkboxes = rows.length
    ? rows
        .map(
          (r, i) =>
            `<label class="row"><input type="checkbox" name="invite" value="${esc(r.phone)}"${i < 8 ? ' checked' : ''}> ` +
            `#${i + 1} ${esc(r.display_name ?? r.phone)} <span class="muted">(${r.total} pts)</span></label>`,
        )
        .join('')
    : `<p class="muted">No standings yet — nobody to invite.</p>`;

  const gameOptions =
    `<option value="">(no specific game)</option>` +
    games.map((g) => `<option value="${esc(g.id)}">${esc(formatWhen(g.starts_at, c.env.TIMEZONE))} — ${esc(g.location)}</option>`).join('');

  const body =
    `<h1>Special Players tournament</h1>` +
    `<p class="muted">Top 8 are pre-checked. Adjust to break any tie, then send invites. ` +
    `This <strong>resets the season</strong> (logical — nothing is deleted).</p>` +
    `<form class="stack" method="post" action="/admin/tournament/run">` +
    `<label>Tournament game (optional)<select name="game_id">${gameOptions}</select></label>` +
    checkboxes +
    `<button class="primary" type="submit">Send invites &amp; reset season</button></form>`;

  return layout('Tournament', body, adminNav);
});

admin.post('/tournament/run', async (c) => {
  const f = new URLSearchParams(await c.req.text());
  const invited = f.getAll('invite');
  if (invited.length === 0) return c.redirect('/admin/tournament');

  const game = f.get('game_id') ? await db.getGame(c.env.DB, f.get('game_id')!) : null;
  const now = new Date().toISOString();

  // Snapshot names before reset so the close record is self-contained.
  const snapshot: Array<{ phone: string; name: string | null }> = [];
  for (const phone of invited) {
    const m = await db.getMember(c.env.DB, phone);
    snapshot.push({ phone, name: m?.display_name ?? null });
  }

  const res = await broadcast(c.env, invited, tournamentInvite(c.env, game));
  await db.closeSeason(c.env.DB, { invited: snapshot, gameId: game?.id ?? null, sent: res.sent }, now);

  return layout(
    'Tournament started',
    `<h1>🏆 Invites sent</h1><p class="ok">Invited ${res.sent} player(s); season reset.</p>` +
      `<p><a href="/admin/standings">View the fresh standings →</a></p>`,
    adminNav,
  );
});

// ---- roster + rewards -----------------------------------------------------

admin.get('/roster', async (c) => {
  const members = await db.listMembers(c.env.DB);
  const rewards = await db.listAwardedRewards(c.env.DB);

  const memberRows = members.length
    ? members
        .map(
          (m: Member) =>
            `<form class="row" method="post" action="/admin/roster/name">` +
            `<input type="hidden" name="phone" value="${esc(m.phone)}">` +
            `<input type="text" name="name" value="${esc(m.display_name ?? '')}" placeholder="First L" style="flex:1">` +
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

/** Interpret a wall-clock "YYYY-MM-DDTHH:MM" in `timeZone` and return UTC ISO. */
function zonedToUtcIso(localWall: string, timeZone: string): string {
  const asUtc = new Date(`${localWall}:00Z`);
  if (Number.isNaN(asUtc.getTime())) return new Date().toISOString();
  const tzShown = new Date(asUtc.toLocaleString('en-US', { timeZone }));
  const utcShown = new Date(asUtc.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offset = tzShown.getTime() - utcShown.getTime();
  return new Date(asUtc.getTime() - offset).toISOString();
}
