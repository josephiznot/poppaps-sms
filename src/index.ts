/**
 * Poppa P's Poker Night — one Cloudflare Worker serving three surfaces plus the
 * cron reminder (ADR-0001/0005):
 *   POST /sms     Twilio webhook (players: JOIN/STOP/HELP + name capture)
 *   /admin/*      host web app (password-gated)
 *   GET  /        public season standings
 *   cron          hourly game-reminder check
 */
import { Hono } from 'hono';
import type { Env } from './types';
import { sms } from './routes/sms';
import { admin } from './routes/admin';
import { publicRoutes } from './routes/public';
import { sendDueReminders } from './lib/jobs';

const app = new Hono<{ Bindings: Env }>();

app.route('/sms', sms);
app.route('/admin', admin);
app.route('/', publicRoutes);

app.get('/health', (c) => c.text('ok'));

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(sendDueReminders(env));
  },
} satisfies ExportedHandler<Env>;
