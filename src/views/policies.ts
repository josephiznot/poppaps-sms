/**
 * Public policy pages served by the Worker (so the privacy policy + program
 * terms live on Cloudflare, not GitHub Pages). Content mirrors the source in
 * docs/privacy.md and docs/index.md.
 */
import type { Env } from '../types';
import { layout, esc } from '../lib/html';
import { formatUs } from '../lib/phone';

const footer = (other: string, label: string) =>
  `<p class="muted" style="margin-top:2rem"><a href="/">← Standings</a> · <a href="${other}">${label}</a></p>`;

export function privacyPage(env: Env): Response {
  const body =
    `<h1>Privacy Policy — ${esc(env.PROGRAM_NAME)}</h1>` +
    `<p class="muted">Last updated: 2026-06-08</p>` +
    `<p>This policy covers the SMS program for Poppa P's poker night (reminders, promos, and the season standings).</p>` +
    `<h2>What we collect</h2><ul>` +
    `<li>Your mobile phone number.</li>` +
    `<li>A display name you give us at opt-in — your first name and last initial (e.g. "Mike R").</li>` +
    `<li>Your opt-in / opt-out status and timestamps.</li>` +
    `<li>Your game results (points) and attendance.</li>` +
    `<li>Basic message metadata (e.g. when we last texted you).</li></ul>` +
    `<p>We do not collect your email, address, location, or payment information through this program.</p>` +
    `<h2>How we use it</h2><ul>` +
    `<li>To text you game reminders, promos, and tournament invites.</li>` +
    `<li>To track points and attendance for season standings, the quarterly tournament, and attendance promos.</li>` +
    `<li>To show your first name + last initial and point total on a public standings page.</li></ul>` +
    `<h2>Public standings</h2>` +
    `<p>The standings page shows your first name + last initial and your points. We never display your full name, phone number, or other personal detail publicly. If you don't opt in, you aren't tracked or shown.</p>` +
    `<h2>What we don't do</h2><ul>` +
    `<li>We do not sell, rent, or trade your number or name.</li>` +
    `<li>We do not share your information with third parties for their own marketing.</li></ul>` +
    `<p>We use Twilio to deliver the texts and mobile carriers to transmit them; they don't use your information beyond delivering these messages.</p>` +
    `<h2>Opting out</h2>` +
    `<p>Reply STOP to any message to stop all texts immediately. We keep a record that you opted out so we don't text you again. Reply HELP for help.</p>` +
    `<h2>Data retention</h2>` +
    `<p>We keep your information while you participate and for a reasonable period after, so we can honor opt-outs and keep season history accurate. You can ask the host at Poppa P's to delete your record entirely.</p>` +
    `<h2>Contact</h2>` +
    `<p>Questions about this program or your data? Ask the host at Poppa P's, or reply HELP to any message.</p>` +
    footer('/terms', 'SMS terms');
  return layout(`Privacy — ${env.PROGRAM_NAME}`, body);
}

export function termsPage(env: Env): Response {
  const num = esc(formatUs(env.TWILIO_FROM_NUMBER));
  const body =
    `<h1>${esc(env.PROGRAM_NAME)} — Text Program Terms</h1>` +
    `<p>Game reminders, occasional promos, and season standings by text. Messages come from ${num}.</p>` +
    `<h2>How to join (opt in)</h2>` +
    `<p>Text <strong>JOIN</strong> to ${num} from your phone — at the lounge or anytime. We'll text back asking for your first name + last initial (e.g. "Mike R"); reply with it and you're on the list — that's how you appear on the standings. By texting JOIN you agree to receive recurring automated SMS (reminders and occasional promos). <strong>Consent is not a condition of any purchase.</strong></p>` +
    `<h2>What you'll get</h2><ul>` +
    `<li>A reminder before each scheduled game (usually the day before).</li>` +
    `<li>Occasional promos and tournament invites.</li>` +
    `<li>Schedule changes. Frequency varies — usually a few messages per month.</li></ul>` +
    `<h2>What we track (and show publicly)</h2>` +
    `<p>We track your game results (points) and attendance to run the season standings, the quarterly Special Players tournament, and attendance promos. Your first name + last initial and point total appear on a public standings page; we never show your full name or phone number. If you don't opt in, none of this is tracked.</p>` +
    `<h2>Cost</h2>` +
    `<p>Message and data rates may apply, depending on your mobile plan. Poppa P's doesn't charge anything for the texts.</p>` +
    `<h2>Stop / Help</h2>` +
    `<p>Reply <strong>STOP</strong> any time to be removed immediately (one final confirmation, then nothing). Reply JOIN to rejoin. Reply <strong>HELP</strong>, or ask the host at Poppa P's.</p>` +
    `<h2>About the game</h2>` +
    `<p>A private, social game at the cigar lounge. Players buy cigars up front — and are ID'd at purchase — and compete for cigars at the table. No money is wagered and there are no cash payouts.</p>` +
    footer('/privacy', 'Privacy Policy');
  return layout(`Terms — ${env.PROGRAM_NAME}`, body);
}
