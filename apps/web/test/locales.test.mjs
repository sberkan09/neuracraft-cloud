// Every language has every key English has, and every API error code has a sentence.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { ErrorCodes } from "@neuracraft/shared";

const dir = new URL("../src/locales/", import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));
const keys = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v, `${p}${k}.`) : [`${p}${k}`]));

test("every language has the same keys", () => {
  const en = new Set(keys(load("en.json")));
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "en.json")) {
    const other = new Set(keys(load(f)));
    assert.deepEqual([...en].filter((k) => !other.has(k)), [], `${f} is missing keys`);
    assert.deepEqual([...other].filter((k) => !en.has(k)), [], `${f} has extra keys`);
  }
});

test("every error code is translated", () => {
  const errors = load("en.json").errors;
  assert.deepEqual(ErrorCodes.filter((c) => !(c in errors)), []);
});
