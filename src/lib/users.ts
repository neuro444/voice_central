// Multi-user dashboard accounts, backed by SQLite (see db.ts).
//
// Replaces the single hardcoded DASHBOARD_ADMIN_USERNAME/PASSWORD pair.
// Username is globally unique across all restaurants -- login has no
// restaurant selector, so two different restaurants can't both claim the
// same username (that would make login ambiguous about which person is
// signing in).
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";

const SCRYPT_KEYLEN = 64;

export interface DashboardUser {
  id: number;
  username: string;
  restaurants: string[]; // slugs
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
}

// ── Seed migration ───────────────────────────────────────────────────────
// On first run (users table empty), create the "cakeworld" restaurant and
// one user from the existing DASHBOARD_ADMIN_USERNAME/PASSWORD env vars, so
// an existing deployment doesn't lose its only login when this ships. Those
// two env vars are only ever read here, once -- after the first user exists,
// they're inert.
function ensureSeeded(): void {
  const db = getDb();
  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (count.n > 0) return;

  const envUser = process.env.DASHBOARD_ADMIN_USERNAME;
  const envPass = process.env.DASHBOARD_ADMIN_PASSWORD;
  if (!envUser || !envPass) {
    // Nothing to seed from and no users exist yet -- fine, addUser() (the
    // CLI script) is how the first account gets created in that case. Login
    // will correctly refuse everyone until then (see verifyUserCredentials).
    return;
  }

  db.prepare(
    "INSERT OR IGNORE INTO restaurants (slug, name) VALUES ('cakeworld', 'CakeWorld Alpharetta')"
  ).run();
  addUser(envUser, envPass, ["cakeworld"]);
}

// ── Credential verification ──────────────────────────────────────────────
export function verifyUserCredentials(username: string, password: string): DashboardUser | null {
  ensureSeeded();
  const db = getDb();
  const row = db
    .prepare("SELECT id, username, password_hash, salt FROM users WHERE username = ?")
    .get(username) as { id: number; username: string; password_hash: string; salt: string } | undefined;
  if (!row) return null;

  const candidate = Buffer.from(hashPassword(password, row.salt), "hex");
  const expected = Buffer.from(row.password_hash, "hex");
  // Buffers must be equal length for timingSafeEqual -- both are always
  // SCRYPT_KEYLEN bytes here since we control both sides, but guard anyway.
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    return null;
  }

  return { id: row.id, username: row.username, restaurants: getUserRestaurants(row.id) };
}

// Used by verifySessionToken (auth.ts) to check the account backing an
// otherwise-valid signed token still exists -- so removing a user actually
// revokes their access instead of leaving already-issued tokens valid until
// natural expiry.
export function userExists(username: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM users WHERE username = ?").get(username);
  return row !== undefined;
}

function getUserRestaurants(userId: number): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT r.slug FROM restaurants r
       JOIN user_restaurants ur ON ur.restaurant_id = r.id
       WHERE ur.user_id = ?`
    )
    .all(userId) as { slug: string }[];
  return rows.map((r) => r.slug);
}

// ── Admin management (used by scripts/add-user.ts) ───────────────────────
// Upsert: re-running for an existing username updates their password --
// this is the de facto "reset a password" path now that there's no single
// env var to just change.
export function addUser(username: string, password: string, restaurantSlugs: string[]): void {
  const db = getDb();

  // Validate every slug BEFORE touching the users table -- otherwise a typo
  // in one slug leaves a half-created user behind even though this throws.
  // All-or-nothing, not partial.
  const restaurantIds: number[] = [];
  for (const slug of restaurantSlugs) {
    const restaurant = db.prepare("SELECT id FROM restaurants WHERE slug = ?").get(slug) as
      | { id: number }
      | undefined;
    if (!restaurant) {
      throw new Error(
        `Unknown restaurant slug "${slug}". Create it first rather than guessing -- ` +
          `restaurant creation should be deliberate, not a side effect of adding a user. Nothing was changed.`
      );
    }
    restaurantIds.push(restaurant.id);
  }

  const salt = randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);

  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
    | { id: number }
    | undefined;

  const userId = existing
    ? (db.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?").run(hash, salt, existing.id), existing.id)
    : (db.prepare("INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)").run(username, hash, salt)
        .lastInsertRowid as number);

  for (const restaurantId of restaurantIds) {
    db.prepare(
      "INSERT OR IGNORE INTO user_restaurants (user_id, restaurant_id) VALUES (?, ?)"
    ).run(userId, restaurantId);
  }
}

export function removeUser(username: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM users WHERE username = ?").run(username);
  return result.changes > 0;
}

export function createRestaurant(slug: string, name: string): void {
  const db = getDb();
  db.prepare("INSERT INTO restaurants (slug, name) VALUES (?, ?)").run(slug, name);
}
