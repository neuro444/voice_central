#!/usr/bin/env node
// Dashboard user management CLI. Standalone (not importing from src/lib) --
// the app's @/lib/* path aliases are a Next.js/webpack feature, not
// something a plain `node` process resolves, and this project has no
// tsx/ts-node to bridge that. Small enough to duplicate the DB logic here
// rather than add a build step just for an admin script.
//
// Usage:
//   node scripts/add-user.mjs add-restaurant <slug> <name>
//   node scripts/add-user.mjs add-user <username> <password> <slug>[,<slug>...]
//   node scripts/add-user.mjs remove-user <username>
//   node scripts/add-user.mjs list
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = process.env.VOICE_CENTRAL_DB_PATH || path.join(process.cwd(), "data", "voice_central.db");
const SCRYPT_KEYLEN = 64;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec(`CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL
);`);
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
db.exec(`CREATE TABLE IF NOT EXISTS user_restaurants (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, restaurant_id)
);`);

const [, , cmd, ...args] = process.argv;

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

if (cmd === "add-restaurant") {
  const [slug, name] = args;
  if (!slug || !name) fail("usage: add-restaurant <slug> <name>");
  try {
    db.prepare("INSERT INTO restaurants (slug, name) VALUES (?, ?)").run(slug, name);
    console.log(`Created restaurant "${name}" (${slug}).`);
  } catch (e) {
    fail(`could not create restaurant: ${e.message}`);
  }
} else if (cmd === "add-user") {
  const [username, password, slugsArg] = args;
  if (!username || !password || !slugsArg) {
    fail("usage: add-user <username> <password> <slug>[,<slug>...]");
  }
  const slugs = slugsArg.split(",").map((s) => s.trim()).filter(Boolean);

  // Validate every slug BEFORE touching the users table -- otherwise a typo
  // in the second of two slugs leaves a half-created user behind even though
  // the command reports failure. All-or-nothing, not partial.
  const restaurantIds = [];
  for (const slug of slugs) {
    const restaurant = db.prepare("SELECT id FROM restaurants WHERE slug = ?").get(slug);
    if (!restaurant) {
      const known = db.prepare("SELECT slug FROM restaurants").all().map((r) => r.slug);
      fail(
        `unknown restaurant slug "${slug}". Create it first with add-restaurant. ` +
          `Known slugs: ${known.join(", ") || "(none yet)"}. Nothing was changed.`
      );
    }
    restaurantIds.push(restaurant.id);
  }

  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");

  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  let userId;
  if (existing) {
    db.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?").run(hash, salt, existing.id);
    userId = existing.id;
    console.log(`Updated password for existing user "${username}".`);
  } else {
    const result = db
      .prepare("INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)")
      .run(username, hash, salt);
    userId = result.lastInsertRowid;
    console.log(`Created user "${username}".`);
  }

  for (const restaurantId of restaurantIds) {
    db.prepare(
      "INSERT OR IGNORE INTO user_restaurants (user_id, restaurant_id) VALUES (?, ?)"
    ).run(userId, restaurantId);
  }
  console.log(`"${username}" now has access to: ${slugs.join(", ")}`);
} else if (cmd === "remove-user") {
  const [username] = args;
  if (!username) fail("usage: remove-user <username>");
  const result = db.prepare("DELETE FROM users WHERE username = ?").run(username);
  if (result.changes > 0) {
    console.log(`Removed user "${username}". Any of their active sessions stop working immediately.`);
  } else {
    console.log(`No user named "${username}" found.`);
  }
} else if (cmd === "list") {
  const users = db
    .prepare(
      `SELECT u.username, GROUP_CONCAT(r.slug, ', ') AS restaurants
       FROM users u
       LEFT JOIN user_restaurants ur ON ur.user_id = u.id
       LEFT JOIN restaurants r ON r.id = ur.restaurant_id
       GROUP BY u.id
       ORDER BY u.username`
    )
    .all();
  if (users.length === 0) {
    console.log("No users yet.");
  } else {
    for (const u of users) {
      console.log(`${u.username}\t${u.restaurants || "(no restaurant assigned)"}`);
    }
  }
} else {
  console.log(`Usage:
  node scripts/add-user.mjs add-restaurant <slug> <name>
  node scripts/add-user.mjs add-user <username> <password> <slug>[,<slug>...]
  node scripts/add-user.mjs remove-user <username>
  node scripts/add-user.mjs list`);
  process.exit(cmd ? 1 : 0);
}
