# Content Calendar — a Paperclip plugin

A month calendar for `social_post` cases, plus a job that publishes them when
they are approved and due.

**Cases stay the source of truth.** This plugin does not author content, does
not copy captions into its own table, and does not invent its own approval
flag. It reads cases over the Paperclip API, lays them out by date, and records
what it published.

---

## Why it is built this way

Paperclip already ships most of what a content calendar needs, under different
names. Before writing anything we audited the live instance
(`Agents/paperclip-native-scheduling.md` in the knowledge graph):

| Need | Already in Paperclip | So we |
| --- | --- | --- |
| Recurring job engine | `plugin_jobs`, and `routines` with cron, timezone, catch-up and concurrency policies | declare a job, write no scheduler |
| Approval | native case status `approved`, indexed, emits `status_changed` events | read `status === "approved"` |
| Approval audit | `case_events`, `approvals` | write nothing extra |
| Content storage | `cases` + `case_documents` + `case_attachments` | never duplicate a case |
| **Publish date** | **nothing** | read `fields.publish_at` |
| **Calendar view** | **nothing** | this plugin |
| **Publisher** | **nothing** | this plugin |

The three "nothing" rows are the entire scope.

### Approval is the case status, not a field

Our team previously tracked approval in `fields.approved` — a JSON string on
78 cases, `"true"` on exactly zero of them. Paperclip has a real `approved`
lifecycle status that is indexed and event-logged. The gate reads the native
status. `fields.approved` is ignored.

Reviewers move a case to **Approved** in the Paperclip UI. That is the whole
handoff.

---

## What it stores

One schema, `plugin_content_calendar_cc002f61cd`, derived by the host. Two
tables, neither of which duplicates a case:

- **`publish_attempts`** — append-only. One row per attempt with the outcome
  (`sent` / `dry_run` / `failed` / `skipped`), the reason, the caption hash at
  attempt time, and the raw adapter response. A partial unique index on
  `outcome = 'sent'` means a case can only ever be sent once; a duplicate raises
  a constraint violation instead of double-posting.
- **`schedule_overrides`** — records a reschedule intent before writing
  `publish_at` back to the case, so a failed write-back is visible rather than
  lost.

`cases` is **not** in the host's `coreReadTables` whitelist, so it cannot be
read from plugin SQL at all. Case access goes over the authenticated HTTP API,
which is why a board API key is required.

---

## The publish gate

Every reason to publish or not lives in one pure function (`src/gate.ts`), in
this order:

1. already sent (unique index) → `skipped`
2. case already has a `publish_url` → `skipped`
3. case is `cancelled` or `done` → `skipped`
4. **case status is not `approved`** → `skipped`
5. no caption → `skipped`
6. no channel, channel not enabled in config, or no configured adapter → `skipped`
7. no `publish_at`, unparseable, or not due yet → `skipped`
8. overdue beyond `lookbackHours` → `skipped` (reschedule rather than post late)
9. **`autoPost` is off → `dry_run`** — evaluated, recorded, nothing sent
10. otherwise → `publish`

`autoPost` defaults to `false` and fails closed: any value other than boolean
`true` is treated as off. **Nothing reaches a public channel until an operator
turns it on.**

---

## Configuration

Set on the plugin's settings page after install:

| Key | Required | Meaning |
| --- | --- | --- |
| `apiBaseUrl` | yes | Where to reach the Cases API. Use the loopback origin, e.g. `http://127.0.0.1:3100`. |
| `boardApiKeyRef` | yes | Secret **reference** to a board API key (`paperclipai token board create`). Resolved per call, never cached or logged. Without it the calendar shows a clear "not configured" notice instead of rendering empty. |
| `autoPost` | no | Default `false`. The only switch that can publish. |
| `channels` | no | Channel keys the job may send to. A case on an unlisted channel is skipped with a reason. |
| `lookbackHours` | no | Default 6. How late a missed post may still go out. |

---

## Channel adapters

`src/channels.ts` defines the `ChannelAdapter` contract. The X and LinkedIn
adapters are **deliberately unimplemented** — they report `isConfigured: false`,
so the job records `skipped / no configured adapter` and never pretends to have
posted.

Implementing them is the CMO's lane, because publishing and the channel
credentials are. To add one: implement `publish`, make `isConfigured` check for
the resolved token, and register it in `ADAPTERS`. Put the token in plugin
config as a secret reference — never in the source, and never as a spawned
script path.

---

## Build and install

**Never build on the agent hosts.** Both droplets are 1–2 GB RAM with under
5 GB free; a single `npm install` has taken the gateway down before. CI builds
the artifact:

```bash
# in CI (.github/workflows/build.yml)
npm install && npx tsc --noEmit && npm run build
node scripts/verify-namespace.mjs      # schema name must match the derived one
```

Then on the Paperclip host:

```bash
tar -xzf paperclip-content-calendar.tar.gz -C ~/plugins
paperclipai plugin target                       # confirm which instance
paperclipai plugin install ~/plugins/paperclip-content-calendar
paperclipai plugin inspect untrace.plugin-content-calendar
```

`plugin install` reads built output from disk — no compilation happens on the
server.

### The namespace trap

The host derives the schema name as
`plugin_<slug>_<sha256(pluginId)[0:10]>`. The migration SQL hardcodes it.
Change `PLUGIN_ID` or `NAMESPACE_SLUG` and every migration statement is
rejected as out-of-namespace, leaving the plugin in `error` status.
`scripts/verify-namespace.mjs` runs in CI to catch that before it reaches a
server, and the worker logs a loud error at startup if `ctx.db.namespace`
disagrees with the compiled constant.

---

## Pitfalls worth knowing

- **`cases.fields` is replaced wholesale on PATCH, never deep-merged.** Sending
  `{ publish_url }` alone destroys caption, channel and publish_at.
  `patchCaseFields()` always reads first and sends the merged object.
- **Cases are experimental**, gated on `experimental.enableCases`. A
  `403 Cases are disabled` means an operator turned it off.
- **`POST /cases` upserts on `(caseType, key)`** — `200` updates, `201`
  creates. Retries converge only with a deterministic key.
- **The calendar grid is UTC.** `publish_at` is an instant; rendering in
  browser-local time would shift posts across day boundaries for anyone outside
  UTC.
- **Plugin UI is same-origin, not sandboxed.** Fine for a plugin we wrote;
  a reason not to install third-party plugins casually.
