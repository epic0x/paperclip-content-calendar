#!/usr/bin/env node
/**
 * Pre-install guards for the migration SQL. Both of these failures otherwise
 * only surface as a dead plugin on a live server, with an error message that
 * points nowhere near the real cause.
 *
 * GUARD 1 — namespace derivation.
 *   The host computes plugin_<slug>_<sha256(pluginId).slice(0,10)>
 *   (@paperclipai/server dist/services/plugin-database.js →
 *   derivePluginDatabaseNamespace). The migration SQL hardcodes it. If they
 *   disagree, every statement is rejected as out-of-namespace.
 *
 * GUARD 2 — apostrophes in comments. THIS IS A HOST BUG, verified 2026-08-23
 *   against @paperclipai/server 2026.821.0-canary.11.
 *   stripSqlForKeywordScan() replaces quoted string literals BEFORE it strips
 *   comments:
 *       .replace(/'([^']|'')*'/g, "''")   <-- strings first
 *       .replace(/--.*$/gm, "")            <-- comments second
 *   So one apostrophe in a `--` comment opens a phantom string literal that
 *   runs to the next apostrophe in real SQL (e.g. a '{}'::jsonb default) and
 *   swallows the CREATE TABLE keyword with it. The statement then normalises
 *   to a fragment and fails the host's "DDL or namespace-scoped backfill
 *   statements only" check.
 *
 *   Symptom on the server: install fails with
 *     "Plugin migrations may contain DDL or namespace-scoped backfill
 *      statements only"
 *   for a statement that is plainly a CREATE TABLE.
 *   Fix: write comments without apostrophes. Say "do not" instead of "don't".
 *
 * GUARD 3 — fully qualified names. The host requires every object reference to
 *   carry the schema. `CREATE INDEX ... ON publish_log (...)` is rejected;
 *   `... ON plugin_x_hash.publish_log (...)` is accepted.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const MAX_POSTGRES_IDENTIFIER_LENGTH = 63;

function derive(pluginKey, namespaceSlug) {
  const hash = createHash("sha256").update(pluginKey).digest("hex").slice(0, 10);
  const slug =
    (namespaceSlug ?? pluginKey)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 36) || "plugin";
  return `plugin_${slug}_${hash}`.slice(0, MAX_POSTGRES_IDENTIFIER_LENGTH);
}

/** Verbatim copy of the host's stripSqlForKeywordScan, bug included. */
function stripSqlForKeywordScan(input) {
  return input
    .replace(/'([^']|'')*'/g, "''")
    .replace(/"([^"]|"")*"/g, '""')
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const normalise = (s) =>
  stripSqlForKeywordScan(s).replace(/\s+/g, " ").trim().toLowerCase();

/** Verbatim port of the host's statement splitter (comment- and quote-aware). */
function splitSqlStatements(input) {
  const statements = [];
  let start = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (char === quote) { if (next === quote) i += 1; else quote = null; }
      continue;
    }
    if (char === "-" && next === "-") { lineComment = true; i += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; i += 1; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === ";") {
      const st = input.slice(start, i).trim();
      if (st) statements.push(st);
      start = i + 1;
    }
  }
  const trailing = input.slice(start).trim();
  if (trailing) statements.push(trailing);
  return statements;
}

// ---------------------------------------------------------------------------

const src = readFileSync("src/manifest.ts", "utf8");
const pick = (name) => {
  const m = src.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`));
  if (!m) throw new Error(`could not find ${name} in src/manifest.ts`);
  return m[1];
};

const pluginId = pick("PLUGIN_ID");
const slug = pick("NAMESPACE_SLUG");
const declared = pick("DB_NAMESPACE");
const expected = derive(pluginId, slug);

let failed = 0;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed += 1; };

console.log(`pluginId : ${pluginId}`);
console.log(`slug     : ${slug}`);
console.log(`derived  : ${expected}`);
console.log(`declared : ${declared}\n`);

if (declared !== expected) {
  fail(`DB_NAMESPACE is "${declared}" but the host derives "${expected}".`);
}

for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql"))) {
  const full = path.join("migrations", file);
  const sql = readFileSync(full, "utf8");
  console.log(`${file}:`);

  // GUARD 2 — apostrophes inside line comments.
  sql.split("\n").forEach((line, idx) => {
    const c = line.indexOf("--");
    if (c >= 0 && line.slice(c).includes("'")) {
      fail(
        `${file}:${idx + 1} apostrophe inside a comment. The host strips string literals before comments, so this swallows the following DDL keyword. Rewrite without the apostrophe.\n         ${line.trim().slice(0, 90)}`,
      );
    }
  });

  // GUARD 3 — every statement must pass the host's own shape checks.
  splitSqlStatements(sql).forEach((st, i) => {
    const n = normalise(st);
    const ddlOk =
      /^(create|alter|comment)\b/.test(n) ||
      /^(insert\s+into|update)\b/.test(n) ||
      (n.startsWith("with ") && /\b(insert\s+into|update)\b/.test(n));
    if (!ddlOk) {
      fail(
        `${file} statement [${i}] does not normalise to DDL. Host would reject it.\n         raw: ${st.slice(0, 70).replace(/\n/g, " ")}\n         normalised: ${n.slice(0, 90)}`,
      );
      return;
    }
    const schemas = new Set([...st.matchAll(/\b(plugin_[a-z0-9_]+)\./g)].map((m) => m[1]));
    for (const s of schemas) {
      if (s !== expected) fail(`${file} statement [${i}] references schema "${s}", expected "${expected}"`);
    }
    // Object-creating statements must name their schema.
    if (/^(create\s+(unique\s+)?index|create\s+table|alter\s+table)\b/.test(n) && schemas.size === 0) {
      fail(`${file} statement [${i}] is not schema-qualified. Host requires fully qualified names.\n         ${st.slice(0, 80).replace(/\n/g, " ")}`);
    }
    console.log(`  ok [${i}] ${n.slice(0, 72)}`);
  });

  if (/\b(DROP|ALTER|TRUNCATE)\s+TABLE\s+(IF\s+EXISTS\s+)?public\./i.test(sql)) {
    fail(`${file} attempts to mutate a public table`);
  }
  if (/^\s*(DROP|TRUNCATE)\b/im.test(sql)) {
    fail(`${file} contains a destructive statement; the host rejects DROP and TRUNCATE outright`);
  }
}

if (failed) {
  console.error(`\n${failed} problem(s) found. These would fail at install time on the server.`);
  process.exit(1);
}
console.log("\nall migration guards passed");
