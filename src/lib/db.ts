// Shared SQLite connection for dashboard users/restaurants.
//
// One connection for the whole process, not one per request/module-load --
// Next.js dev mode hot-reloads server modules on every save, and opening a
// fresh SQLite connection each time risks file-lock contention against the
// still-open previous one. A module-level singleton (kept on `global` so it
// survives Next.js's dev-mode module reloading too) avoids that.
//
// node:sqlite ships in Node itself (no external dependency) as of the Node
// version this project runs on -- but it's a newer addition to Node, so pin
// the Node version in production deployment rather than assuming behavior
// stays identical across an upgrade.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = process.env.VOICE_CENTRAL_DB_PATH || path.join(process.cwd(), "data", "voice_central.db");

declare global {
  // eslint-disable-next-line no-var
  var __voiceCentralDb: DatabaseSync | undefined;
}

function initSchema(db: DatabaseSync): void {
  // WAL mode: reads don't block writes and vice versa. Cheap to turn on from
  // the start -- the same lesson chat_manager's own security review already
  // flagged for its SQLite store (journal_mode=delete blocks a dashboard read
  // against a live write otherwise).
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS restaurants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Join table: a staff member can work at more than one restaurant. Deleting
  // a restaurant or a user cascades here rather than leaving orphan rows.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_restaurants (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, restaurant_id)
    );
  `);
}

export function getDb(): DatabaseSync {
  if (global.__voiceCentralDb) return global.__voiceCentralDb;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  initSchema(db);
  global.__voiceCentralDb = db;
  return db;
}
