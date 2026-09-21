import { Hono } from 'hono';
import type { Env } from '../types';
import { layout,esc,adminNav } from '../lib/html';
import { formatWhen } from '../lib/messages';
import { localDateInTz } from '../lib/schedule';
import * as db from '../lib/db';
import { listTournamentPlans,resolveTournamentTie,rescheduleTournament,cancelTournament } from '../lib/tournament';
import { tournamentBoard,tournamentOffers,getTournamentPlan } from '../lib/tournament-db';
import { listDeliveries,retryDelivery,reconcileDelivery } from '../lib/delivery';

/** Mounted behind admin's existing password gate. All mutations redirect. */
export const tournamentAdmin = new Hono<{Bindings:Env}>();
const statusLabel = (s:string) => ({SCHEDULED:'Scheduled automatically',BLOCKED:'Needs attention',ACTIVE:'Invitations open',COMPLETED:'Completed',CANCELLED:'Cancelled',QUEUED:'Waiting to send',SENDING:'Submitting',ACCEPTED:'Accepted by text provider',DELIVERED:'Delivered',FAILED:'Failed',UNKNOWN:'Delivery uncertain',SUPPRESSED:'Not sent',CONFIRMED:'Seat confirmed',DECLINED:'Declined',EXPIRED:'Expired',REPLACED:'Replaced',OPTED_OUT:'Opted out'} as Record<string,string>)[s] ?? s;

tournamentAdmin.get('/',async c=>{
  const plans = await listTournamentPlans(c.env.DB);
  const since = await db.lastSeasonClose(c.env.DB);
  const cards = await Promise.all(plans.slice(0,8).map(async p=>{
    const [board,offers,deliveries] = await Promise.all([tournamentBoard(c.env.DB,p.id),tournamentOffers(c.env.DB,p.id),listDeliveries(c.env.DB,p.id)]);
    const active = p.status !== 'COMPLETED' && p.status !== 'CANCELLED';
    const when=(s:string)=>esc(formatWhen(s,c.env.TIMEZONE));
    const hidden=`<input type="hidden" name="plan_id" value="${esc(p.id)}"><input type="hidden" name="version" value="${p.version}">`;
    const changeDate=active ? `<details><summary>Change tournament date</summary><form class="stack" method="post" action="/admin/tournament/reschedule">${hidden}<label>New date (Central)<input type="date" name="date" value="${localDateInTz(new Date(p.planned_starts_at),c.env.TIMEZONE)}" required></label><p class="muted">Keep this tournament on an off week. If invitations have already gone out, current invitees will receive one date-change notice.</p><button>Save new date</button></form></details>` : '';
    const cancel=active ? `<details><summary>Cancel this tournament</summary><form method="post" action="/admin/tournament/cancel" onsubmit="return confirm('Cancel this tournament? Existing invitees will receive a cancellation notice.')">${hidden}<button class="danger">Cancel tournament</button></form></details>` : '';
    let tie='';
    if(active && p.tie_score !== null){
      const choices = board.length ? board.map(r=>({phone:r.member_phone,display_name:r.display_name,total:r.points})) : await db.standings(c.env.DB,since,p.qualification_cutoff);
      tie=`<form class="stack" method="post" action="/admin/tournament/resolve">${hidden}<p>Select the players who should receive the tied seats. Higher-scoring qualifiers are retained automatically.</p>`+
        choices.filter(r=>r.total===p.tie_score && (!board.length || !offers.some(o=>o.member_phone===r.phone))).map(r=>`<label class="row"><input type="checkbox" name="phone" value="${esc(r.phone)}">${esc(r.display_name ?? 'Player')} · ${r.total} points</label>`).join('')+`<button>Save tie decision</button></form>`;
    }
    const roster = offers.length ? `<table><caption>Seat offers · eight ranked seats plus the host</caption><thead><tr><th>Player</th><th>Seat</th><th>Reply by</th></tr></thead><tbody>`+offers.map(o=>`<tr><td>${esc(o.display_name ?? 'Player')}${o.is_host_offer ? ' · Host' : ''}</td><td>${esc(o.is_host_offer && ['ACTIVE','CONFIRMED'].includes(o.state) ? 'Guaranteed' : statusLabel(o.state))}</td><td>${o.is_host_offer ? 'Guaranteed until play; FOLD may decline' : when(o.response_deadline)}</td></tr>`).join('')+`</tbody></table>`:'';
    const deliveryRows = deliveries.map(d=>`<tr><td>${esc(board.find(b=>b.member_phone===d.recipient)?.display_name ?? offers.find(o=>o.member_phone===d.recipient)?.display_name ?? 'Player')}</td><td>${esc(statusLabel(d.state))}${d.last_error ? `<br><span class="muted">${esc(d.last_error)}</span>` : ''}</td><td>${d.state==='FAILED' && d.retryable ? `<form method="post" action="/admin/tournament/retry"><input type="hidden" name="delivery_id" value="${esc(d.id)}"><button>Retry failed text</button></form>` : (d.state==='UNKNOWN' || d.state==='ACCEPTED') && d.provider_sid ? `<form method="post" action="/admin/tournament/reconcile"><input type="hidden" name="delivery_id" value="${esc(d.id)}"><button>Check provider status</button></form>` : d.state==='UNKNOWN' ? 'Check the provider log before contacting this player; receipt unavailable.' : ''}</td></tr>`).join('');
    const delivery=deliveryRows ? `<details><summary>Text delivery status</summary><p class="muted">Accepted means the provider received the request; delivered is a separate receipt. An uncertain request is never resent automatically.</p><table><thead><tr><th>Player</th><th>Status</th><th>Action</th></tr></thead><tbody>${deliveryRows}</tbody></table></details>`:'';
    return `<section class="season-note"><h2>${esc(p.quarter_key)} tournament</h2><p><strong>${when(p.planned_starts_at)}</strong> · ${esc(statusLabel(p.status))}</p><p>Qualification closes / invites begin: ${when(p.qualification_cutoff)}<br>Reply by: ${when(p.confirmation_deadline)}</p>${p.blocked_reason ? `<p class="warn" role="status">${esc(p.blocked_reason)}</p>`:''}${tie}${roster}${delivery}${changeDate}${cancel}</section>`;
  }));
  return layout('Tournament',`<h1>Special Players tournament</h1><p>The calendar, invitations and reminders run automatically. Your normal job is to record each game's results. Change a date here if it conflicts with your plans.</p><p class="muted">First off-week Monday each quarter · 6:30 PM Central · invitations two weeks before play. Missing results, tied final seats and uncertain texts appear here for attention.</p>${cards.join('') || '<p>The next tournament will appear after the next hourly schedule check.</p>'}`,adminNav);
});

async function errorPage(error:unknown):Promise<Response>{
  const response=layout('Tournament needs attention',`<h1>Change not saved</h1><p class="warn">${esc(error instanceof Error ? error.message : String(error))}</p><p><a href="/admin/tournament">Return to tournament →</a></p>`,adminNav);
  return new Response(response.body,{status:409,headers:response.headers});
}
for(const action of ['reschedule','cancel','resolve'] as const){
  tournamentAdmin.post(`/${action}`,async c=>{
    const f=new URLSearchParams(await c.req.text());
    try {
      const id=f.get('plan_id') ?? ''; const version=Number(f.get('version'));
      const plan=await getTournamentPlan(c.env.DB,id);
      if(!f.has('version') || !plan || plan.version!==version) throw new Error('This tournament changed. Reload the page before trying again.');
      if(action==='reschedule') await rescheduleTournament(c.env,id,f.get('date') ?? '',new Date(),version);
      if(action==='cancel') await cancelTournament(c.env,id,new Date(),version);
      if(action==='resolve') await resolveTournamentTie(c.env,id,f.getAll('phone'),new Date(),version);
      return c.redirect('/admin/tournament',303);
    }catch(error){return errorPage(error);}
  });
}
for(const action of ['retry','reconcile'] as const){
  tournamentAdmin.post(`/${action}`,async c=>{
    const f=new URLSearchParams(await c.req.text());
    try{
      if(action==='retry') await retryDelivery(c.env,f.get('delivery_id') ?? '');
      else await reconcileDelivery(c.env,f.get('delivery_id') ?? '');
      return c.redirect('/admin/tournament',303);
    }catch(error){return errorPage(error);}
  });
}
// Old tabs/bookmarks can never invoke the former send-then-close flow.
for(const path of ['/run','/backfill']) tournamentAdmin.post(path,c=>c.text('Tournament operation is now automatic. Open /admin/tournament for current status.',409));
