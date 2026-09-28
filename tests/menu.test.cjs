const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-central-menu-"));
process.env.VOICE_CENTRAL_DB_PATH = path.join(tempDir, "menu.sqlite3");

function loadTypeScript(file, imports = {}, globals = {}) {
  const exportsObject = {};
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports: exportsObject,
    require: (name) => imports[name] || require(name),
    process,
    console,
    global: globals.global || {},
    ...globals,
  });
  return exportsObject;
}

const db = loadTypeScript("src/lib/db.ts");
const menu = loadTypeScript("src/lib/menu.ts", { "./db": db });

const database = db.getDb();
database.prepare(
  "INSERT INTO restaurants (slug, name) VALUES (?, ?)"
).run("cakeworld", "CakeWorld Alpharetta");
database.prepare(
  "INSERT INTO restaurants (slug, name) VALUES (?, ?)"
).run("another-restaurant", "Another Restaurant");

after(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("seeds CakeWorld once and renders the concise agent format", () => {
  const items = menu.listMenuItems("cakeworld");
  assert.equal(items.length, 153);
  assert.deepEqual(
    { name: items[0].name, price: items[0].price },
    { name: "Kizhi Porotta", price: 16.99 },
  );
  const prompt = menu.renderMenuText("cakeworld");
  assert.match(prompt, /^Kizhi Porotta, 16\.99$/m);
  assert.doesNotMatch(prompt, /pickup|vegetarian|category/i);
});

test("creates, renames, reprices, and deletes a menu item", () => {
  const created = menu.createMenuItem(
    "cakeworld",
    { name: "  Weekend   Special  ", price: "12.345" },
    "tester",
  );
  assert.equal(created.name, "Weekend Special");
  assert.equal(created.price, 12.35);

  const updated = menu.updateMenuItem(
    "cakeworld",
    created.id,
    { name: "Weekend Veg Special", price: 13.5 },
    "tester",
  );
  assert.equal(updated.name, "Weekend Veg Special");
  assert.equal(updated.price, 13.5);

  const deleted = menu.deleteMenuItem("cakeworld", created.id);
  assert.equal(deleted.id, created.id);
  assert.equal(menu.listMenuItems("cakeworld").some((item) => item.id === created.id), false);
});

test("rejects invalid prices and duplicate names regardless of case", () => {
  assert.throws(
    () => menu.createMenuItem("cakeworld", { name: "Bad Price", price: "free" }, "tester"),
    (error) => error instanceof menu.MenuValidationError,
  );
  assert.throws(
    () => menu.createMenuItem("cakeworld", { name: "kizhi porotta", price: 1 }, "tester"),
    (error) => error instanceof menu.MenuConflictError,
  );
});

test("keeps each restaurant menu isolated and does not reseed deletions", () => {
  assert.equal(menu.listMenuItems("another-restaurant").length, 0);
  const other = menu.createMenuItem(
    "another-restaurant",
    { name: "House Item", price: 9.99 },
    "tester",
  );
  assert.equal(menu.listMenuItems("another-restaurant").length, 1);
  assert.equal(menu.listMenuItems("cakeworld").some((item) => item.name === other.name), false);

  const cakeworldItem = menu.listMenuItems("cakeworld")[0];
  menu.deleteMenuItem("cakeworld", cakeworldItem.id);
  assert.equal(menu.listMenuItems("cakeworld").length, 152);
});
