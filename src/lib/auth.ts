/**
 * Minimal admin auth: a password login that sets a signed session cookie.
 * Self-contained so manual testing works immediately. For production you can
 * additionally front /admin with Cloudflare Access (ADR-0005) — this stays as a
 * second layer / local-dev fallback.
 */
import type { Context, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../types';

const COOKIE = 'pp_session';
const SIGNED_PAYLOAD = 'poker-admin-v1';

/** Deterministic session token derived from ADMIN_PASSWORD (no DB needed). */
export async function sessionToken(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(SIGNED_PAYLOAD));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function setSession(c: Context<{ Bindings: Env }>): Promise<void> {
  const token = await sessionToken(c.env.ADMIN_PASSWORD);
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function isAuthed(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const cookie = getCookie(c, COOKIE);
  if (!cookie) return false;
  return cookie === (await sessionToken(c.env.ADMIN_PASSWORD));
}

/** Hono middleware: redirect to /admin/login when not authenticated. */
export async function requireAuth(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  if (await isAuthed(c)) return next();
  return c.redirect('/admin/login');
}
