/**
 * Public game-rules page (/rules) — format, blind structure, and payouts, so
 * anyone can see the game ahead of time (and it runs without the host present).
 */
import type { Env } from '../types';
import { layout } from '../lib/html';

const BLINDS: Array<{ level: string; blinds: string; start: string }> = [
  { level: '1', blinds: '25 / 50', start: '6:30 PM' },
  { level: '2', blinds: '50 / 100', start: '6:45 PM' },
  { level: '3', blinds: '75 / 150', start: '7:00 PM' },
  { level: '4', blinds: '100 / 200', start: '7:15 PM' },
  { level: '5', blinds: '150 / 300', start: '7:30 PM' },
  { level: '6', blinds: '200 / 400', start: '7:45 PM' },
  { level: '—', blinds: '5-minute break', start: '8:00 PM' },
  { level: '7', blinds: '300 / 600', start: '8:05 PM' },
  { level: '8', blinds: '400 / 800', start: '8:20 PM' },
  { level: '9', blinds: '500 / 1,000', start: '8:35 PM' },
  { level: '10', blinds: '600 / 1,200', start: '8:50 PM' },
];

export function rulesPage(env: Env): Response {
  const blindRows = BLINDS.map(
    (b) => `<tr><td>${b.level}</td><td>${b.blinds}</td><td class="muted">${b.start}</td></tr>`,
  ).join('');

  const body =
    `<h1>${env.PROGRAM_NAME} — Game Rules</h1>` +
    `<p><strong>No-Limit Texas Hold'em.</strong> Biweekly. This page is open to anyone so you can see the format before you come.</p>` +
    `<p class="muted">📍 Poppa P's Smoke Shoppe &amp; Lounge — 1935 Mallory Ln, Suite 220, Franklin, TN 37067</p>` +

    `<h2>When</h2>` +
    `<p><strong>Cards fly at 6:30 PM</strong> (Central). Come early to buy your cigars, grab a drink, find a seat, and get your buy-in. ` +
    `<strong>Hard stop at 9:00 PM</strong> — final ranks are decided by chip stack.</p>` +

    `<h2>Buy-in &amp; buy-back</h2>` +
    `<ul>` +
    `<li>Your <strong>first cigar is your buy-in</strong> → <strong>2,000 chips</strong>.</li>` +
    `<li>Bust out? Your <strong>second cigar buys you back</strong> in for another 2,000 chips — ` +
    `available <strong>until 8:00 PM</strong> (≈ level 7) only.</li>` +
    `</ul>` +

    `<h2>Blind structure</h2>` +
    `<p class="muted">15-minute levels. Times are approximate.</p>` +
    `<table><thead><tr><th>Level</th><th>Blinds</th><th>≈ Start</th></tr></thead><tbody>${blindRows}</tbody></table>` +

    `<h2>Payouts — the cigar pot</h2>` +
    `<p>Every buy-in and buy-back cigar goes into the pot. Off the top:</p>` +
    `<ul>` +
    `<li><strong>2 cigars</strong> to the employees working that night (the person up front + the bartender).</li>` +
    `<li><strong>1 cigar</strong> to each table's designated dealer (otherwise the dealer button decides who deals).</li>` +
    `</ul>` +
    `<p>The <strong>remaining pot</strong> is then split among the top three:</p>` +
    `<ul>` +
    `<li><strong>1st place</strong> — grand prizes from Poppa P (cutters, lighters, ashtrays, travel humidors, merch, cigar packs, and more) <strong>+ 50%</strong> of the remaining pot.</li>` +
    `<li><strong>2nd place</strong> — <strong>1/3</strong> of the remaining pot.</li>` +
    `<li><strong>3rd place</strong> — <strong>1/6</strong> of the remaining pot.</li>` +
    `</ul>` +

    `<p class="muted" style="margin-top:2rem"><a href="/">← Standings</a> · <a href="/terms">SMS terms</a> · <a href="/privacy">Privacy</a></p>`;

  return layout(`Game Rules — ${env.PROGRAM_NAME}`, body);
}
