/**
 * Recurring game schedule (ADR/roadmap: biweekly auto-scheduling).
 *
 * The game runs every 14 days at a fixed time/place/buy-in, so the whole rule is
 * config here. The cron (jobs.ts) materializes upcoming occurrences as Games so
 * reminders fire; the host can Skip/Cancel any one in the admin (it won't be
 * regenerated). To change day/time/place, edit this and redeploy.
 */
export const RECURRING = {
  /** First game, as a local date in TIMEZONE. The series is every intervalDays from here. */
  anchorDate: '2026-06-15',
  /** Local wall-clock start ("cards fly"), 24h HH:MM. */
  time: '18:30',
  intervalDays: 14,
  /** Short name for SMS; full address lives on the /rules + /terms pages. */
  location: "Poppa P's Smoke Shoppe & Lounge",
  buyIn: '2 cigars',
  description: "No-Limit Texas Hold'em",
  /** Keep occurrences within this many days materialized (> intervalDays). */
  horizonDays: 16,
} as const;

import type { Game } from '../types';

/** Local dates (YYYY-MM-DD) already occupied by games — for one-game-per-day rules. */
export function gameLocalDates(games: Game[], timeZone: string, includeCancelled = false): Set<string> {
  const out = new Set<string>();
  for (const g of games) {
    if (!includeCancelled && g.cancelled) continue;
    out.add(localDateInTz(new Date(g.starts_at), timeZone));
  }
  return out;
}

/** Local date (YYYY-MM-DD) in a time zone for a given instant. */
export function localDateInTz(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Add whole days to a YYYY-MM-DD key (UTC date math; safe for date-only keys). */
export function addDaysToKey(dateKey: string, days: number): string {
  const t = new Date(`${dateKey}T00:00:00Z`).getTime() + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Occurrence date keys (YYYY-MM-DD) of the series that fall within [fromKey, toKey],
 * inclusive. Pure — easy to unit test.
 */
export function seriesDatesBetween(anchorKey: string, intervalDays: number, fromKey: string, toKey: string): string[] {
  const out: string[] = [];
  let d = anchorKey;
  while (d < fromKey) d = addDaysToKey(d, intervalDays);
  while (d <= toKey) {
    out.push(d);
    d = addDaysToKey(d, intervalDays);
  }
  return out;
}

/** Interpret "YYYY-MM-DDTHH:MM" as wall time in `timeZone`, return the UTC ISO instant. */
export function zonedToUtcIso(localWall: string, timeZone: string): string {
  const asUtc = new Date(`${localWall}:00Z`);
  if (Number.isNaN(asUtc.getTime())) return new Date().toISOString();
  const tzShown = new Date(asUtc.toLocaleString('en-US', { timeZone }));
  const utcShown = new Date(asUtc.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offset = tzShown.getTime() - utcShown.getTime();
  return new Date(asUtc.getTime() - offset).toISOString();
}
