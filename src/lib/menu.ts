import fs from "node:fs";
import path from "node:path";

import { getDb } from "./db";

const CAKEWORLD_SEED_PATH = path.join(process.cwd(), "seed", "cakeworld-menu.csv");
const MAX_PRICE_CENTS = 9_999_999;

export interface MenuItemRecord {
  id: number;
  name: string;
  price: number;
  updated_at: string;
}

type MenuItemRow = {
  id: number;
  name: string;
  price_cents: number;
  updated_at: string;
};

export class MenuValidationError extends Error {}
export class MenuConflictError extends Error {}
export class MenuNotFoundError extends Error {}

export function normalizeMenuName(value: unknown): string {
  if (typeof value !== "string") throw new MenuValidationError("menu item name is required");
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new MenuValidationError("menu item name is required");
  if (name.length > 160) throw new MenuValidationError("menu item name must be 160 characters or fewer");
  return name;
}

export function normalizePriceCents(value: unknown): number {
  const text = typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    throw new MenuValidationError("price must be a valid non-negative number");
  }
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new MenuValidationError("price must be a valid non-negative number");
  }
  if (cents > MAX_PRICE_CENTS) throw new MenuValidationError("price is too large");
  return cents;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  if (quoted) throw new MenuValidationError("menu seed contains an unterminated quoted value");
  values.push(value);
  return values;
}

function seedRows(): Array<{ name: string; priceCents: number }> {
  if (!fs.existsSync(CAKEWORLD_SEED_PATH)) {
    throw new Error(`CakeWorld menu seed is missing: ${CAKEWORLD_SEED_PATH}`);
  }
  return fs.readFileSync(CAKEWORLD_SEED_PATH, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      const columns = parseCsvLine(line);
      if (columns.length !== 2) {
        throw new MenuValidationError(`menu seed row ${index + 1} must contain an item name and price`);
      }
      return {
        name: normalizeMenuName(columns[0]),
        priceCents: normalizePriceCents(columns[1]),
      };
    });
}

function restaurantId(restaurantSlug: string): number {
  const db = getDb();
  const restaurant = db.prepare("SELECT id FROM restaurants WHERE slug = ?").get(restaurantSlug) as
    | { id: number }
    | undefined;
  if (!restaurant) throw new MenuNotFoundError("restaurant configuration was not found");
  return restaurant.id;
}

export function ensureMenuSeeded(restaurantSlug: string): void {
  const db = getDb();
  const id = restaurantId(restaurantSlug);
  const existing = db.prepare(
    "SELECT 1 FROM restaurant_menu_seed_state WHERE restaurant_id = ?"
  ).get(id);
  if (existing) return;

  db.exec("BEGIN IMMEDIATE;");
  try {
    const rechecked = db.prepare(
      "SELECT 1 FROM restaurant_menu_seed_state WHERE restaurant_id = ?"
    ).get(id);
    if (!rechecked) {
      const rows = restaurantSlug === "cakeworld" ? seedRows() : [];
      const insert = db.prepare(
        `INSERT INTO restaurant_menu_items
          (restaurant_id, name, price_cents, position, updated_by)
         VALUES (?, ?, ?, ?, 'seed')`
      );
      rows.forEach((row, position) => insert.run(id, row.name, row.priceCents, position));
      db.prepare(
        "INSERT INTO restaurant_menu_seed_state (restaurant_id) VALUES (?)"
      ).run(id);
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function itemResponse(row: MenuItemRow): MenuItemRecord {
  return {
    id: row.id,
    name: row.name,
    price: row.price_cents / 100,
    updated_at: row.updated_at,
  };
}

function selectItem(restaurantId: number, itemId: number): MenuItemRow | undefined {
  return getDb().prepare(
    `SELECT id, name, price_cents, updated_at
       FROM restaurant_menu_items
      WHERE restaurant_id = ? AND id = ?`
  ).get(restaurantId, itemId) as MenuItemRow | undefined;
}

function translateConflict(error: unknown): never {
  const message = typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : "";
  if (message.toLowerCase().includes("unique")) {
    throw new MenuConflictError("a menu item with this name already exists");
  }
  throw error;
}

export function listMenuItems(restaurantSlug: string): MenuItemRecord[] {
  ensureMenuSeeded(restaurantSlug);
  const id = restaurantId(restaurantSlug);
  const rows = getDb().prepare(
    `SELECT id, name, price_cents, updated_at
       FROM restaurant_menu_items
      WHERE restaurant_id = ?
      ORDER BY position ASC, id ASC`
  ).all(id) as MenuItemRow[];
  return rows.map(itemResponse);
}

export function renderMenuText(restaurantSlug: string): string {
  return listMenuItems(restaurantSlug)
    .map((item) => `${item.name}, ${item.price.toFixed(2)}`)
    .join("\n");
}

export function createMenuItem(
  restaurantSlug: string,
  input: { name: unknown; price: unknown },
  updatedBy: string,
): MenuItemRecord {
  ensureMenuSeeded(restaurantSlug);
  const id = restaurantId(restaurantSlug);
  const name = normalizeMenuName(input.name);
  const priceCents = normalizePriceCents(input.price);
  const max = getDb().prepare(
    "SELECT MAX(position) AS position FROM restaurant_menu_items WHERE restaurant_id = ?"
  ).get(id) as { position: number | null };
  try {
    const result = getDb().prepare(
      `INSERT INTO restaurant_menu_items
        (restaurant_id, name, price_cents, position, updated_by)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, name, priceCents, (max.position ?? -1) + 1, updatedBy);
    const item = selectItem(id, Number(result.lastInsertRowid));
    if (!item) throw new Error("created menu item could not be reloaded");
    return itemResponse(item);
  } catch (error) {
    return translateConflict(error);
  }
}

export function updateMenuItem(
  restaurantSlug: string,
  itemId: number,
  input: { name?: unknown; price?: unknown },
  updatedBy: string,
): MenuItemRecord {
  ensureMenuSeeded(restaurantSlug);
  const id = restaurantId(restaurantSlug);
  const current = selectItem(id, itemId);
  if (!current) throw new MenuNotFoundError("menu item not found");
  if (input.name === undefined && input.price === undefined) {
    throw new MenuValidationError("provide name, price, or both");
  }
  const name = input.name === undefined ? current.name : normalizeMenuName(input.name);
  const priceCents = input.price === undefined
    ? current.price_cents
    : normalizePriceCents(input.price);
  try {
    getDb().prepare(
      `UPDATE restaurant_menu_items
          SET name = ?, price_cents = ?, updated_by = ?, updated_at = datetime('now')
        WHERE restaurant_id = ? AND id = ?`
    ).run(name, priceCents, updatedBy, id, itemId);
    const item = selectItem(id, itemId);
    if (!item) throw new MenuNotFoundError("menu item not found");
    return itemResponse(item);
  } catch (error) {
    return translateConflict(error);
  }
}

export function deleteMenuItem(restaurantSlug: string, itemId: number): MenuItemRecord {
  ensureMenuSeeded(restaurantSlug);
  const id = restaurantId(restaurantSlug);
  const current = selectItem(id, itemId);
  if (!current) throw new MenuNotFoundError("menu item not found");
  getDb().prepare(
    "DELETE FROM restaurant_menu_items WHERE restaurant_id = ? AND id = ?"
  ).run(id, itemId);
  return itemResponse(current);
}
