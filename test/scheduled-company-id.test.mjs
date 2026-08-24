/**
 * Issue #3 — the scheduled sweep must not carry a hard-coded company.
 *
 * `registerJobs` currently hands `publishSweep` the `UNTRACE_COMPANY_ID`
 * constant baked into src/manifest.ts, so the published plugin only ever sweeps
 * one company's cases: the deployment it was written for. Every interactive
 * surface already does the right thing — each data handler and each action
 * reads `params.companyId` from the caller — and the cron path is the single
 * place that does not.
 *
 * The desired behaviour, asserted here before it exists:
 *
 *   (a) neither src/manifest.ts nor src/worker.ts mentions UNTRACE_COMPANY_ID
 *       or the company uuid it held;
 *   (b) src/worker.ts exports `resolveScheduledCompanyId(env)`, a PURE function
 *       of the environment it is handed, reading
 *       PAPERCLIP_CONTENT_CALENDAR_COMPANY_ID;
 *   (c) it accepts a valid uuid and otherwise throws an error that NAMES the
 *       variable, so an operator who forgot to set it is told what to set
 *       rather than shown a database error about a company that is not there;
 *   (d) the job resolves on every invocation and passes the result to
 *       `publishSweep`, so fixing a bad value is a config change and a rerun,
 *       not a worker restart;
 *   (e) the interactive handlers are untouched — they keep taking companyId
 *       from params, and must not start resolving it from the environment.
 *
 * `src/worker.ts` calls `runWorker()` at module scope, but that call is a no-op
 * unless the module IS the process entrypoint (`process.argv[1]`), which under
 * `node --test` it is not. So the resolver's real behaviour is exercised
 * against the built module, while the wiring around it — which handler reads
 * what — is asserted against the source, as in create-post-action.test.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const WORKER_SRC = readFileSync(
  new URL("../src/worker.ts", import.meta.url),
  "utf8",
);
const MANIFEST_SRC = readFileSync(
  new URL("../src/manifest.ts", import.meta.url),
  "utf8",
);

const ENV_VAR = "PAPERCLIP_CONTENT_CALENDAR_COMPANY_ID";
/** The single-tenant company id this plugin must stop shipping. */
const BAKED_IN_UUID = ["b276d33f", "a226", "4fd1", "95fa", "b3f3114ccd9d"].join("-");
/** Any valid company id that is not the one above. */
const A_COMPANY = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** The resolver under test, or undefined while it does not exist yet. */
async function resolver() {
  const mod = await import("../dist/worker.js");
  return mod.resolveScheduledCompanyId;
}

/** One registered action or data handler, from its `register` to the next. */
function handler(kind, name) {
  const start = WORKER_SRC.indexOf(`ctx.${kind}.register("${name}"`);
  assert.ok(start > 0, `the ${name} ${kind} handler is registered`);
  const nextHandler = WORKER_SRC.indexOf(`ctx.${kind}.register(`, start + 1);
  const nextSection = WORKER_SRC.indexOf("\n// ---", start);
  const candidates = [nextHandler, nextSection].filter((offset) => offset > start);
  const end = candidates.length > 0 ? Math.min(...candidates) : WORKER_SRC.length;
  return WORKER_SRC.slice(start, end);
}

/** The body of `registerJobs`, which is where the cron path is wired. */
function registerJobsBody() {
  const start = WORKER_SRC.indexOf("async function registerJobs(");
  assert.ok(start > 0, "registerJobs exists");
  const next = WORKER_SRC.indexOf("\n// ---", start);
  return WORKER_SRC.slice(start, next > 0 ? next : WORKER_SRC.length);
}

// --- (a) the hard-coded company is gone -------------------------------------

test("src/manifest.ts no longer ships a company id", () => {
  assert.doesNotMatch(
    MANIFEST_SRC,
    /UNTRACE_COMPANY_ID/,
    "the constant is removed, not just unused",
  );
  assert.ok(
    !MANIFEST_SRC.includes(BAKED_IN_UUID),
    "and the uuid it held is not left behind anywhere in the manifest",
  );
});

test("src/worker.ts no longer references a company id constant", () => {
  assert.doesNotMatch(WORKER_SRC, /UNTRACE_COMPANY_ID/);
  assert.ok(
    !WORKER_SRC.includes(BAKED_IN_UUID),
    "not as an import, not as a default, not in a comment example",
  );
});

// --- (b) the resolver exists, is pure, and reads the documented variable -----

test("the worker exports resolveScheduledCompanyId", async () => {
  const resolve = await resolver();
  assert.equal(
    typeof resolve,
    "function",
    "dist/worker.js exports resolveScheduledCompanyId (run `npm run build` first)",
  );
  assert.equal(resolve.length, 1, "it takes the environment as its argument");
});

test("the resolver names PAPERCLIP_CONTENT_CALENDAR_COMPANY_ID in the source", () => {
  assert.match(WORKER_SRC, /export (function|const) resolveScheduledCompanyId/);
  assert.match(
    WORKER_SRC,
    new RegExp(`env(\\.${ENV_VAR}|\\[["']${ENV_VAR}["']\\])`),
    "it reads the variable off the env it was handed",
  );
});

test("the resolver reads its argument and never process.env behind it", async () => {
  const resolve = await resolver();
  const before = process.env[ENV_VAR];
  process.env[ENV_VAR] = A_COMPANY;
  try {
    // A pure resolver told the environment is empty says so, even when the
    // ambient process happens to have the variable set. This is what makes the
    // function testable and what lets a caller pass a per-invocation env.
    assert.throws(() => resolve({}), new RegExp(ENV_VAR));
    const other = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
    assert.equal(resolve({ [ENV_VAR]: other }), other);
  } finally {
    if (before === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = before;
  }
});

// --- (c) valid in, clear error out ------------------------------------------

test("a valid uuid resolves to itself", async () => {
  const resolve = await resolver();
  assert.equal(resolve({ [ENV_VAR]: A_COMPANY }), A_COMPANY);
  assert.equal(
    resolve({ [ENV_VAR]: A_COMPANY.toUpperCase() }),
    A_COMPANY.toUpperCase(),
    "case is the operator's business; a uuid is a uuid",
  );
  assert.equal(
    resolve({ [ENV_VAR]: `  ${A_COMPANY}\n` }),
    A_COMPANY,
    "surrounding whitespace is trimmed, like every other required string here",
  );
});

test("missing, empty or malformed all fail by naming the variable", async () => {
  const resolve = await resolver();
  const rejected = [
    ["missing", {}],
    ["undefined", { [ENV_VAR]: undefined }],
    ["empty", { [ENV_VAR]: "" }],
    ["whitespace", { [ENV_VAR]: "   " }],
    ["not a uuid", { [ENV_VAR]: "the-untrace-company" }],
    ["truncated", { [ENV_VAR]: "b276d33f-a226-4fd1-95fa" }],
    ["non-hex", { [ENV_VAR]: "zzzzzzzz-a226-4fd1-95fa-b3f3114ccd9d" }],
    ["a number", { [ENV_VAR]: 42 }],
  ];

  for (const [why, env] of rejected) {
    assert.throws(
      () => resolve(env),
      (err) => {
        assert.ok(err instanceof Error, `${why}: throws an Error`);
        // The operator reading this line in the job log has to learn the name
        // of the thing to set. An "invalid uuid" with no name does not.
        assert.match(err.message, new RegExp(ENV_VAR), why);
        return true;
      },
      `${why} is refused`,
    );
  }
});

// --- (d) the job resolves per invocation and sweeps that company ------------

test("the publish job resolves the company inside the invocation", () => {
  const body = registerJobsBody();
  const register = body.indexOf("ctx.jobs.register(");
  assert.ok(register > 0, "the publish job is registered");

  const callback = body.slice(body.indexOf("async (", register));
  assert.match(
    callback,
    /resolveScheduledCompanyId\(/,
    "resolved when the job runs, so a corrected value takes effect on the next tick",
  );

  // Every call site is inside a job callback: no module-scope constant is
  // resolved once at setup and reused for the life of the worker.
  const calls = WORKER_SRC.split(/resolveScheduledCompanyId\(/).length - 1;
  const declarations =
    WORKER_SRC.split(/(?:function|const) resolveScheduledCompanyId\s*[(=]/).length - 1;
  const inJob = callback.split(/resolveScheduledCompanyId\(/).length - 1;
  assert.equal(
    calls - declarations,
    inJob,
    "resolveScheduledCompanyId is only ever called from inside the job",
  );
});

test("the resolved company is what publishSweep sweeps", () => {
  const body = registerJobsBody();
  const sweep = body.slice(body.indexOf("publishSweep("));
  assert.ok(sweep.startsWith("publishSweep("), "the job still calls publishSweep");

  const bound = body.match(/const\s+(\w+)\s*=\s*resolveScheduledCompanyId\(/);
  const argument = bound ? new RegExp(`\\b${bound[1]}\\b`) : /resolveScheduledCompanyId\(/;
  assert.match(
    sweep.slice(0, sweep.indexOf(");") + 2),
    argument,
    "publishSweep receives the resolved id, not a constant",
  );
});

// --- (e) the interactive surfaces are untouched -----------------------------

test("data handlers still take companyId from their params", () => {
  for (const name of ["calendar", "attempts", "status", "case-detail"]) {
    const body = handler("data", name);
    assert.match(body, /params\.companyId/, `${name} reads params.companyId`);
    assert.doesNotMatch(
      body,
      /resolveScheduledCompanyId/,
      `${name} must not resolve a company from the environment — the caller says which one`,
    );
  }
});

test("actions still take companyId from their params", () => {
  const actions = [
    "reschedule",
    "create-post",
    "set-status",
    "save-content",
    "set-media",
    "post-now",
  ];
  for (const name of actions) {
    const body = handler("actions", name);
    assert.match(
      body,
      /requireStr\(params\.companyId, "companyId"\)/,
      `${name} requires companyId from the caller`,
    );
    assert.doesNotMatch(body, /resolveScheduledCompanyId/, `${name} stays scoped to its caller`);
  }
});
