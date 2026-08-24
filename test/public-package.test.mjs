/**
 * Issue #3 — public package metadata, docs, and tarball contents.
 *
 * This plugin was written for one private Paperclip deployment and still reads
 * that way: `private: true`, `exports` pointing at TypeScript source, no
 * LICENSE / CHANGELOG / SECURITY, a README that names an internal knowledge
 * graph, internal hostnames and the people who asked for features. Publishing
 * it as-is would ship a package nobody outside that deployment can install and
 * would leak the deployment's shape.
 *
 * The desired 0.5.0 state, asserted here before it exists:
 *
 *   (a) package.json and src/manifest.ts both say 0.5.0;
 *   (b) package.json is publishable — no `private`, `exports` resolves to
 *       COMPILED output, every `paperclipPlugin` path is compiled, `files`
 *       carries the artifact AND the public docs, license MIT, repository /
 *       homepage / bugs point at the public GitHub repo, publishConfig.access
 *       is public;
 *   (c) LICENSE, CHANGELOG.md and SECURITY.md exist, and SECURITY.md names the
 *       public contact address;
 *   (d) the README tells a stranger how to install, configure, upgrade and
 *       uninstall it, which runtimes it needs, what it can do, what it stores,
 *       how to report a vulnerability, and that X is optional;
 *   (e) nothing public mentions the private deployment — its company uuid, its
 *       internal hosts, its operator's initials, its knowledge graph, its
 *       filesystem layout;
 *   (f) `npm pack` actually produces that: compiled plugin, migrations, public
 *       docs and the publisher runtime in; sources, tests, CI, source maps,
 *       __pycache__ and anything credential-shaped out.
 *
 * Determinism: every assertion reads a file in this repo or the output of
 * `npm pack --dry-run`, which packs the working tree and makes no registry
 * request. No clock, no network, no ordering assumptions.
 *
 * The private company uuid is assembled from fragments below so that this test
 * — which is itself public — never contains the literal it is banning.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const at = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel) => readFileSync(at(rel), "utf8");
const has = (rel) => existsSync(at(rel));

const EXPECTED_VERSION = "0.5.0";
const EXPECTED_PACKAGE_NAME = "@epic0x/paperclip-plugin-content-calendar";
const EXPECTED_PLUGIN_ID = "epic0x.plugin-content-calendar";
const EXPECTED_DB_NAMESPACE = "plugin_content_calendar_f2583e060b";
const REPO_URL = "https://github.com/epic0x/paperclip-content-calendar";
const SECURITY_CONTACT = "contact@untrace.network";

/**
 * The runtimes an installer actually has to have. Node comes from
 * `engines.node`; the Paperclip surface is pinned by the plugin SDK dependency
 * and the manifest's apiVersion. The publisher is bundled Node code, so no
 * second language runtime is part of the install contract.
 */

const pkg = JSON.parse(read("package.json"));
const manifestSrc = read("src/manifest.ts");
const readme = read("README.md");

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------

test("package.json version is 0.5.0", () => {
  assert.equal(pkg.version, EXPECTED_VERSION);
});

test("the manifest's PLUGIN_VERSION is 0.5.0", () => {
  const m = manifestSrc.match(/PLUGIN_VERSION\s*=\s*"([^"]+)"/);
  assert.ok(m, "src/manifest.ts must export a PLUGIN_VERSION string");
  assert.equal(m[1], EXPECTED_VERSION);
});

test("the manifest object takes its version from PLUGIN_VERSION", () => {
  assert.match(manifestSrc, /version:\s*PLUGIN_VERSION/);
});

// ---------------------------------------------------------------------------
// package.json is publishable
// ---------------------------------------------------------------------------

test("the npm package is owned by the epic0x scope", () => {
  assert.equal(pkg.name, EXPECTED_PACKAGE_NAME);
  assert.equal(pkg.author, "Epic0x");
});

test("the public release is a fresh Epic0x Paperclip plugin", () => {
  assert.match(
    manifestSrc,
    new RegExp(`PLUGIN_ID\\s*=\\s*"${escapeRe(EXPECTED_PLUGIN_ID)}"`),
  );
  assert.match(
    manifestSrc,
    new RegExp(`DB_NAMESPACE\\s*=\\s*"${escapeRe(EXPECTED_DB_NAMESPACE)}"`),
  );

  for (const rel of [
    "src/manifest.ts",
    "migrations/001_publish_log.sql",
    "README.md",
    "SECURITY.md",
    "CHANGELOG.md",
  ]) {
    const content = read(rel);
    assert.doesNotMatch(
      content,
      /untrace\.plugin-content-calendar|plugin_content_calendar_cc002f61cd/,
      `${rel} still carries the old plugin identity`,
    );
  }
});

test("the package is not marked private", () => {
  assert.ok(
    !("private" in pkg),
    "`private: true` blocks `npm publish`; remove the key entirely",
  );
});

test("exports resolves to compiled output, not TypeScript source", () => {
  const entry = typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.["."];
  assert.equal(
    entry,
    "./dist/manifest.js",
    "a consumer installing from npm has no tsc in the path",
  );
});

test("every paperclipPlugin path is compiled", () => {
  const p = pkg.paperclipPlugin ?? {};
  assert.equal(p.manifest, "./dist/manifest.js");
  assert.equal(p.worker, "./dist/worker.js");
  assert.equal(p.ui, "./dist/ui/");
  for (const [key, value] of Object.entries(p)) {
    assert.ok(
      String(value).startsWith("./dist/"),
      `paperclipPlugin.${key} must point into dist/, got ${value}`,
    );
    assert.doesNotMatch(String(value), /\.tsx?$/, `paperclipPlugin.${key} is source`);
  }
});

test("files carries the artifact and the public docs", () => {
  const files = pkg.files ?? [];
  for (const entry of [
    "dist",
    "migrations",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "SECURITY.md",
  ]) {
    assert.ok(files.includes(entry), `package.json files[] is missing ${entry}`);
  }
  assert.ok(!files.includes("scripts"), "Node-only package must not ship scripts/");
});

test("the license is MIT", () => {
  assert.equal(pkg.license, "MIT");
});

test("repository, homepage and bugs point at the public repo", () => {
  const repoUrl =
    typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  assert.ok(repoUrl, "package.json needs a repository field");
  assert.ok(
    repoUrl.includes(REPO_URL),
    `repository must reference ${REPO_URL}, got ${repoUrl}`,
  );

  assert.ok(pkg.homepage, "package.json needs a homepage");
  assert.ok(
    pkg.homepage.startsWith(REPO_URL),
    `homepage must reference ${REPO_URL}, got ${pkg.homepage}`,
  );

  const bugsUrl = typeof pkg.bugs === "string" ? pkg.bugs : pkg.bugs?.url;
  assert.ok(bugsUrl, "package.json needs a bugs url");
  assert.equal(bugsUrl, `${REPO_URL}/issues`);
});

test("publishConfig.access is public", () => {
  // A scoped package defaults to restricted; publishing would 402 without this.
  assert.equal(pkg.publishConfig?.access, "public");
});

test("npm packaging rebuilds the public artifact", () => {
  assert.equal(pkg.scripts?.prepack, "npm run build");
});

// ---------------------------------------------------------------------------
// the public docs exist
// ---------------------------------------------------------------------------

test("LICENSE exists and is the MIT text", () => {
  assert.ok(has("LICENSE"), "LICENSE is missing");
  const license = read("LICENSE");
  assert.match(license, /MIT License/i);
  assert.match(license, /Copyright \(c\)/i);
  assert.match(license, /Permission is hereby granted, free of charge/);
});

test("CHANGELOG.md exists and has a 0.5.0 entry", () => {
  assert.ok(has("CHANGELOG.md"), "CHANGELOG.md is missing");
  const changelog = read("CHANGELOG.md");
  assert.match(
    changelog,
    new RegExp(`^##\\s*\\[?${escapeRe(EXPECTED_VERSION)}\\]?`, "m"),
    "CHANGELOG.md needs a `## 0.5.0` section",
  );
});

test("SECURITY.md exists and gives the public contact address", () => {
  assert.ok(has("SECURITY.md"), "SECURITY.md is missing");
  const security = read("SECURITY.md");
  assert.ok(
    security.includes(SECURITY_CONTACT),
    `SECURITY.md must name ${SECURITY_CONTACT} as the reporting address`,
  );
  assert.match(security, /report/i, "SECURITY.md must say how to report");
});

// ---------------------------------------------------------------------------
// the README documents the package for a stranger
// ---------------------------------------------------------------------------

test("README shows the npm install command", () => {
  assert.match(
    readme,
    new RegExp(`npm install ${escapeRe(pkg.name)}`),
    `README must show \`npm install ${pkg.name}\``,
  );
});

test("README documents PAPERCLIP_CONTENT_CALENDAR_COMPANY_ID", () => {
  assert.match(
    readme,
    /PAPERCLIP_CONTENT_CALENDAR_COMPANY_ID/,
    "the scheduled sweep does nothing until this is set; it has to be documented",
  );
});

test("README covers fresh install, configuration, upgrade and uninstall", () => {
  const sections = [
    ["install", /^#{2,4} .*\binstall(ing|ation)?\b/im],
    ["configuration", /^#{2,4} .*\bconfigur\w*/im],
    ["upgrade", /^#{2,4} .*\bupgrad\w*/im],
    ["uninstall", /^#{2,4} .*\b(uninstall\w*|removing|removal)\b/im],
  ];
  for (const [name, re] of sections) {
    assert.match(readme, re, `README has no ${name} section`);
  }
});

test("README states the required Paperclip and Node versions", () => {
  const nodeRange = pkg.engines?.node;
  assert.ok(nodeRange, "package.json must declare engines.node");
  const nodeMajor = nodeRange.match(/(\d+)/)?.[1];
  assert.match(
    readme,
    new RegExp(`Node[^\\n]*${escapeRe(nodeMajor)}`, "i"),
    `README must state the Node requirement (engines.node is ${nodeRange})`,
  );

  const sdkVersion = pkg.dependencies?.["@paperclipai/plugin-sdk"];
  assert.ok(sdkVersion, "package.json must depend on @paperclipai/plugin-sdk");
  assert.ok(
    readme.includes(sdkVersion.replace(/^[^\d]*/, "")),
    `README must state the Paperclip plugin SDK version it is built against (${sdkVersion})`,
  );
  const apiVersion = manifestSrc.match(/apiVersion:\s*(\d+)/)?.[1];
  assert.ok(apiVersion, "src/manifest.ts must declare apiVersion");
  assert.match(
    readme,
    new RegExp(`(plugin )?API version[^\\n]*${escapeRe(apiVersion)}`, "i"),
    `README must state the plugin API version (${apiVersion})`,
  );

  assert.match(
    readme,
    /bundled Node/i,
    "README must state that X publishing is bundled Node code",
  );
  assert.doesNotMatch(readme, /Python[^\n]*(required|requirement)/i);
});

test("README documents every capability the manifest requests", () => {
  assert.match(readme, /^#{2,4} .*\bcapabilit/im, "README has no capabilities section");
  const block = manifestSrc.match(/capabilities:\s*\[([\s\S]*?)\]/)?.[1];
  assert.ok(block, "src/manifest.ts must declare a capabilities array");
  const capabilities = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(capabilities.length > 0);
  for (const capability of capabilities) {
    assert.ok(
      readme.includes(capability),
      `README does not document the requested capability \`${capability}\``,
    );
  }
});

test("README has a security section pointing at SECURITY.md", () => {
  assert.match(readme, /^#{2,4} .*\bsecurity\b/im, "README has no security section");
  assert.match(readme, /SECURITY\.md/, "README must link SECURITY.md");
});

test("README documents the data the plugin stores", () => {
  assert.match(
    readme,
    /^#{2,4} .*\b(what it stores|data (it )?stores?d?|stored data)\b/im,
    "README has no 'what it stores' section",
  );
  for (const table of ["publish_attempts", "schedule_overrides"]) {
    assert.ok(readme.includes(table), `README must describe the ${table} table`);
  }
});

test("README says the X channel is optional", () => {
  const sentences = readme.split(/(?<=[.!?])\s+|\n{2,}|\n(?=[-*|#])/);
  const said = sentences.some(
    (s) => /\bX\b/.test(s) && /\boptional\b/i.test(s),
  );
  assert.ok(
    said,
    "README must state in so many words that X publishing is optional — the plugin is a usable calendar with no channel configured",
  );
});

// ---------------------------------------------------------------------------
// nothing public mentions the private deployment
// ---------------------------------------------------------------------------

/** Assembled from fragments so this public test never carries the literal. */
const PRIVATE_COMPANY_ID = ["b276d33f", "a226", "4fd1", "95fa", "b3f3114ccd9d"].join(
  "-",
);

const FORBIDDEN = [
  ["the private company uuid", new RegExp(escapeRe(PRIVATE_COMPANY_ID), "i")],
  ["the internal ops host", /ops\.untrace\.network/i],
  ["the internal short domain", /pclip\.co/i],
  ["an operator's initials", /\bJC\b/],
  ["the internal knowledge graph", /knowledge graph/i],
  ["a developer's home directory", /\/home\/openclaw/i],
  ["the private agent hosts", /\bagent hosts?\b/i],
  ["the private deployment", /private deployment/i],
];

const PUBLIC_SURFACES = [
  "README.md",
  "package.json",
  "src/manifest.ts",
  "LICENSE",
  "CHANGELOG.md",
  "SECURITY.md",
];

for (const rel of PUBLIC_SURFACES) {
  test(`${rel} leaks nothing about the private deployment`, () => {
    if (!has(rel)) {
      assert.fail(`${rel} does not exist yet`);
    }
    const text = read(rel);
    for (const [what, re] of FORBIDDEN) {
      const hit = text.match(re);
      assert.ok(
        !hit,
        `${rel} mentions ${what} (matched ${JSON.stringify(hit?.[0])})`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// what npm pack actually ships
// ---------------------------------------------------------------------------

/**
 * `npm pack --dry-run` packs the working tree and writes nothing; it contacts
 * no registry, so this stays offline. `--ignore-scripts` keeps a future
 * `prepack` from turning this assertion into a build.
 */
const packInventory = () => {
  const stdout = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, npm_config_update_notifier: "false" },
    },
  );
  const parsed = JSON.parse(stdout);
  const result = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  assert.ok(result && Array.isArray(result.files), "npm pack returned a file inventory");
  return result.files.map((f) => f.path);
};

test("npm pack ships the compiled plugin, migrations, docs and publisher", () => {
  assert.ok(
    has("dist/manifest.js"),
    "run `npm run build` first — the tarball assertions read real build output",
  );
  const files = packInventory();

  for (const wanted of [
    // compiled plugin
    "dist/manifest.js",
    "dist/worker.js",
    "dist/gate.js",
    "dist/channels.js",
    "dist/x-publisher.js",
    "dist/ui/index.js",
    // schema
    "migrations/001_publish_log.sql",
    // public docs
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "SECURITY.md",
  ]) {
    assert.ok(files.includes(wanted), `the tarball is missing ${wanted}`);
  }
});

test("npm pack ships no sources, tests, CI, maps, caches or credentials", () => {
  const files = packInventory();

  const banned = [
    ["TypeScript sources", (p) => p.startsWith("src/")],
    ["tests", (p) => p.startsWith("test/")],
    ["CI configuration", (p) => p.startsWith(".github/")],
    ["source maps", (p) => p.endsWith(".map")],
    ["Python files", (p) => p.endsWith(".py") || p.endsWith(".pyc")],
    ["obsolete runtime scripts", (p) => p.startsWith("scripts/")],
    ["obsolete publisher bundle", (p) => p === "dist/publisher.js"],
    ["bytecode caches", (p) => p.includes("__pycache__")],
    [
      "credentials",
      (p) => /(^|\/)\.env|credential|secret|\.pem$|\.key$|token/i.test(p),
    ],
  ];

  for (const [what, matches] of banned) {
    const hits = files.filter(matches);
    assert.deepEqual(hits, [], `the tarball ships ${what}: ${hits.join(", ")}`);
  }
});
