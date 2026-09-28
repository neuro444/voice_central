const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-central-agent-plan-"));
process.env.VOICE_CENTRAL_DB_PATH = path.join(tempDir, "agent-plan.sqlite3");

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
const plans = loadTypeScript("src/lib/agent-plan.ts", { "./db": db });
const database = db.getDb();
database.prepare("INSERT INTO restaurants (slug, name) VALUES (?, ?)")
  .run("cakeworld", "CakeWorld Alpharetta");

after(() => {
  database.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("defaults new restaurants to Essential and ElevenLabs", () => {
  assert.equal(plans.getAgentPlan("cakeworld"), "essential");
  assert.equal(plans.getVoiceProvider("cakeworld"), "elevenlabs");
});

test("switching to Premier persists and routes to Plivo", () => {
  plans.setAgentPlan("cakeworld", "premier", "tester");
  assert.equal(plans.getAgentPlan("cakeworld"), "premier");
  assert.equal(plans.getVoiceProvider("cakeworld"), "plivo");
  const row = database.prepare(`
    SELECT active_plan, updated_by
      FROM restaurant_agent_plans p
      JOIN restaurants r ON r.id = p.restaurant_id
     WHERE r.slug = ?
  `).get("cakeworld");
  assert.equal(row.active_plan, "premier");
  assert.equal(row.updated_by, "tester");
});

test("switching back to Essential changes the routing decision", () => {
  plans.setAgentPlan("cakeworld", "essential", "tester-two");
  assert.equal(plans.getVoiceProvider("cakeworld"), "elevenlabs");
});
