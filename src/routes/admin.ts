/** /admin/* — host web app behind password auth (ADR-0005 §2). */
import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import type { Env, Member } from '../types';
import { layout, adminNav, esc } from '../lib/html';
import { formatWhen, formatDateOnly } from '../lib/messages';
import { setSession, requireAuth } from '../lib/auth';
import { awardRewardsForAttendees } from '../lib/jobs';
import { RECURRING, to12h, zonedToUtcIso, gameLocalDates, localDateInTz } from '../lib/schedule';
import * as db from '../lib/db';
import { tournamentAdmin } from './tournament-admin';
import { listTournamentPlans } from '../lib/tournament';

export const admin = new Hono<{ Bindings: Env }>();

// Auth gate for everything except the login/logout endpoints.
admin.use('*', async (c, next) => {
  const origin = c.req.header('Origin');
  if(c.req.method==='POST' && origin && origin!==new URL(c.req.url).origin) return c.text('Cross-site form submission rejected.',403);
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
  const plans = await listTournamentPlans(c.env.DB);
  const planByGame = new Map(plans.map(p=>[p.game_id,p]));
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
          const managed = planByGame.has(g.id);
          const primary = g.cancelled
            ? `<span class="muted">—</span>`
            : `<a href="/admin/games/${esc(g.id)}">${g.results_recorded_at ? 'Edit results' : g.starts_at < now ? 'Record results' : 'Results'} →</a>${managed ? ' · <a href="/admin/tournament">Tournament settings</a>' : ''}`;
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
            `<div class="menu-body">${managed ? '<a href="/admin/tournament">Change date or cancel</a>' : skip+del}</div></details>`;
          return (
            `<tr><td>${esc(formatDateOnly(g.starts_at, c.env.TIMEZONE))}${tag}</td>` +
            `<td>${primary} ${menu}</td></tr>`
          );
        })
        .join('') +
      `</tbody></table>`
    : `<p class="muted">No games yet.</p>`;

  const form =
    `<details><summary>Add an extra regular game or past result</summary>` +
    `<form class="stack" method="post" action="/admin/games">` +
    `<label>Date<input type="date" name="date" required></label>` +
    `<button class="primary" type="submit">Schedule</button>` +
    `<p class="muted">Every game uses these standard details ` +
    `(all times are Central):<br>` +
    `🕡 ${to12h(RECURRING.time)} ${esc(c.env.TIMEZONE)} · 📍 ${esc(RECURRING.location)} · ` +
    `🚬 ${esc(RECURRING.buyIn)} · 🃏 ${esc(RECURRING.description)}<br>` +
    `Past dates are allowed (backfill).</p>` +
    `</form></details>`;

  const dup =
    c.req.query('err') === 'dup'
      ? `<p class="warn">⚠️ A game already exists on that date — only one game per day. Delete the existing one if you need to replace it.</p>`
      : '';
  return layout('Games', `<h1>Games</h1><p>Regular nights and quarterly tournaments schedule themselves. Record results after each game; <a href="/admin/tournament">change a tournament date or check exceptions</a>.</p>${dup}${list}${form}`, adminNav);
});

admin.post('/games', async (c) => {
  const f = new URLSearchParams(await c.req.text());
  if(f.get('is_tournament')==='1') return c.text('Tournaments schedule automatically. Use the Tournament page to change a date.',409);
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
      is_tournament: false,
      description: RECURRING.description,
      buy_in: RECURRING.buyIn,
    },
    new Date().toISOString(),
  );
  return c.redirect('/admin/games');
});

admin.post('/games/:id/cancel', async (c) => {
  const plan=(await listTournamentPlans(c.env.DB)).find(p=>p.game_id===c.req.param('id'));
  if(plan) return c.redirect('/admin/tournament',303);
  await db.cancelGame(c.env.DB, c.req.param('id'));
  return c.redirect('/admin/games');
});

admin.post('/games/:id/delete', async (c) => {
  const plan=(await listTournamentPlans(c.env.DB)).find(p=>p.game_id===c.req.param('id'));
  if(plan) return c.text('Automatic tournaments retain their records. Cancel through the Tournament page.',409);
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
  const tieExtras: Array<{ place: number; phone: string }> = [];
  for (const row of existing) {
    if (!row.place) continue;
    if (placePhone[row.place] === undefined) placePhone[row.place] = row.member_phone;
    else tieExtras.push({ place: row.place, phone: row.member_phone }); // co-finisher (a tie)
  }
  const attended = new Set(await db.attendeesForGame(c.env.DB, game.id));
  const editing = existing.length > 0;

  const options = (sel = '') =>
    `<option value="">—</option>` +
    members.map((m) => `<option value="${esc(m.phone)}"${m.phone === sel ? ' selected' : ''}>${esc(m.display_name ?? m.phone)}</option>`).join('');

  const winnerSelects = [1, 2, 3, 4, 5]
    .map((p) => `<label>${ordinal(p)} place<select name="place${p}">${options(placePhone[p] ?? '')}</select></label>`)
    .join('');

  // Ties (rare): an exact chip-count tie at the 9:00 stop can put two players at
  // the same place. Each tie row carries a place + the extra player sharing it;
  // tie_place / tie_phone post as parallel arrays (one pair per row).
  const placeOptions = (sel: number | '' = '') =>
    `<option value="">—</option>` +
    [1, 2, 3, 4, 5].map((p) => `<option value="${p}"${p === sel ? ' selected' : ''}>${ordinal(p)}</option>`).join('');
  const tieRow = (place: number | '' = '', phone = '') =>
    `<div class="row"><label>Tied place<select name="tie_place">${placeOptions(place)}</select></label>` +
    `<label>Tied player<select name="tie_phone">${options(phone)}</select></label></div>`;
  const tieRowsHtml = [...tieExtras.map((e) => tieRow(e.place, e.phone)), tieRow()].join('');

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
    `<input type="hidden" name="result_version" value="${game.result_version ?? 0}">` +
    `<h2>Top 5 ${game.is_tournament ? '(no season points)' : '(5·4·3·2·1 pts)'}</h2>${winnerSelects}` +
    `<h2>Ties <span class="muted">(rare)</span></h2>` +
    `<p class="muted">Only if two players truly tied for a place — e.g. a chip-count tie at the 9:00 stop. ` +
    `Pick the place and the extra player who shares it; they get that place's points too. Leave blank otherwise.</p>${tieRowsHtml}` +
    `<h2>Who attended?</h2><p class="muted">Winners count automatically.</p>${attendanceRows}` +
    `<label class="row"><input type="checkbox" name="is_tournament" value="1"${game.is_tournament ? ' checked' : ''}> 🏆 Special Players tournament <span class="muted">(no season points)</span></label>` +
    `<button class="primary" type="submit">Save results</button></form>`;

  return layout(title, body, adminNav);
});

admin.post('/games/:id/result', async (c) => {
  const game = await db.getGame(c.env.DB, c.req.param('id'));
  if (!game) return c.redirect('/admin/games');
  if(game.starts_at > new Date().toISOString()) return c.text('Record results after the game has started.',409);

  const f = new URLSearchParams(await c.req.text());
  const now = new Date().toISOString();
  const isTournament = f.get('is_tournament') === '1';
  if(!isTournament && (await listTournamentPlans(c.env.DB)).some(p=>p.game_id===game.id))
    return c.text('A scheduled tournament cannot award regular-season points.',409);

  const placements: Array<{phone:string;place:number}> = [];
  for (const p of [1,2,3,4,5]) {
    const phone = f.get(`place${p}`);
    if (phone) placements.push({phone,place:p});
  }
  const tiePlaces = f.getAll('tie_place');
  const tiePhones = f.getAll('tie_phone');
  for (let i = 0; i < tiePhones.length; i++) {
    const p = Number(tiePlaces[i]);
    if (tiePhones[i]) placements.push({phone:tiePhones[i]!,place:p});
  }

  const attendees = new Set<string>([...f.getAll('attend'), ...placements.map(p=>p.phone)]);
  try {
    if (!f.has('result_version')) throw new Error('Reload this game to get its current result version.');
    if(!placements.length) throw new Error('Record at least one finishing place. If the game did not happen, skip it instead.');
    await db.replaceGameResult(c.env.DB,game.id,Number(f.get('result_version')),placements,[...attendees],isTournament,now);
  } catch (error) {
    const response = layout('Results not saved',`<h1>Results not saved</h1><p class="warn">${esc(String(error instanceof Error ? error.message : error))}</p><p><a href="/admin/games/${esc(game.id)}">Reload this game →</a></p>`,adminNav);
    return new Response(response.body,{status:409,headers:response.headers});
  }
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

// Tournament operations use the durable automatic workflow.
admin.route('/tournament', tournamentAdmin);

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
