/** Cloudflare Worker bindings (D1 + vars + secrets). See wrangler.toml / .dev.vars. */
export interface Env {
  DB: D1Database;

  // Secrets (wrangler secret put …)
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  ADMIN_PASSWORD: string;

  // Vars (wrangler.toml [vars])
  TWILIO_FROM_NUMBER: string;
  PROGRAM_NAME: string;
  SUPPORT_CONTACT: string;
  TIMEZONE: string;
  REMINDER_LEAD_HOURS: string;
  VALIDATE_TWILIO_SIGNATURE: string;
  PUBLIC_BASE_URL: string;
}

export interface Member {
  phone: string;
  display_name: string | null;
  status: 'SUBSCRIBED' | 'UNSUBSCRIBED';
  awaiting_name: number;
  source: string | null;
  opted_in_at: string | null;
  opted_out_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Game {
  id: string;
  starts_at: string;
  location: string;
  is_tournament: number;
  description: string | null;
  buy_in: string | null;
  reminder_sent: number;
  cancelled: number;
  series_date: string | null;
  created_at: string;
}

export interface StandingRow {
  phone: string;
  display_name: string | null;
  total: number;
  last_award: string;
}

export interface TournamentRsvp {
  id: string;
  season_id: string;
  member_phone: string;
  invited_at: string;
  confirmed_at: string | null;
}

export interface AwardedReward {
  id: string;
  member_phone: string;
  rule_id: string;
  threshold: number;
  reward_text: string;
  awarded_at: string;
  redeemed_at: string | null;
}
