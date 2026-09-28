const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const exportsObject = {};
vm.runInNewContext(
  ts.transpileModule(fs.readFileSync("src/lib/api-shapes.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  { exports: exportsObject },
);

const { responseArray } = exportsObject;

test("reads direct and keyed list response shapes", () => {
  assert.deepEqual(responseArray([1, 2], "orders"), [1, 2]);
  assert.deepEqual(responseArray({ orders: [1, 2] }, "orders"), [1, 2]);
});

test("turns malformed and error response shapes into an empty list", () => {
  assert.deepEqual(Array.from(responseArray({ error: "unavailable" }, "approvals")), []);
  assert.deepEqual(Array.from(responseArray({ approvals: {} }, "approvals")), []);
  assert.deepEqual(Array.from(responseArray(null, "approvals")), []);
});
