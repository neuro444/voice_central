// Dashboard authentication — unforgeable, server-validated session.
//
// Security model:
//   * Login route (Node) checks the password, then mints an HMAC-signed token.
//     Creating a valid token REQUIRES the secret, so a cookie cannot be forged.
//   * Middleware runs on the Node.js runtime (see middleware.ts) so it can read
//     DASHBOARD_SESSION_SECRET at runtime and verify the signature on every
//     request.
//   * FAIL CLOSED: if the secret is missing, verification returns false and the
//     user is sent to /login. A misconfiguration can never become a bypass.

export const SESSION_COOKIE = "dash_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 hours

function getSecret(): string | null {
  const s = process.env.DASHBOARD_SESSION_SECRET;
  return s && s.length >= 16 ? s : null;
}

// Constant-time compare for credential checks.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function verifyCredentials(username: string, password: string): boolean {
  const expectedUser = process.env.DASHBOARD_ADMIN_USERNAME;
  const expectedPass = process.env.DASHBOARD_ADMIN_PASSWORD;
  if (!expectedUser || !expectedPass) {
    throw new Error("DASHBOARD_ADMIN_USERNAME / DASHBOARD_ADMIN_PASSWORD not set");
  }
  const userOk = safeEqual(username, expectedUser);
  const passOk = safeEqual(password, expectedPass);
  return userOk && passOk;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBuffer(s: string): ArrayBuffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

// Token = base64url(payload) + "." + base64url(hmac(payload)).
// Returns null if the secret is unavailable (login will 500-guard on that).
export async function createSessionToken(username: string): Promise<string | null> {
  const secret = getSecret();
  if (!secret) return null;
  const payload = {
    sub: username,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const payloadPart = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadPart));
  return `${payloadPart}.${b64url(new Uint8Array(sig))}`;
}

// FAIL CLOSED: any problem (no secret, bad format, bad signature, expired)
// returns false, so the request is treated as unauthenticated.
export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const secret = getSecret();
  if (!secret) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payloadPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlToBuffer(sigPart),
      new TextEncoder().encode(payloadPart)
    );
    if (!ok) return false;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBuffer(payloadPart)));
    return typeof payload.exp === "number" && payload.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

// ── In-memory rate limiter (single-instance dashboard) ──────────────────────
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
const attempts = new Map<string, number[]>();

export function isRateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (attempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, hits);
  return hits.length >= MAX_FAILS;
}

export function recordFailure(key: string): void {
  const now = Date.now();
  const hits = (attempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  attempts.set(key, hits);
}

export function clearFailures(key: string): void {
  attempts.delete(key);
}
