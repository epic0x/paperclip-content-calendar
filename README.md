# Content Calendar — a Paperclip plugin

A month calendar for `social_post` cases, plus a job that publishes them when
they are approved and due. Selecting a post opens an editor panel that can do
the whole job — text, alt text, status, image, schedule, publish — so the Cases
page is never a required stop.

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
| Image storage | `assets` + `case_attachments`, and `POST /cases/:id/attachments` | upload through the native endpoint, store nothing ourselves |

The three "nothing" rows are the entire scope.

### Approval is the case status, not a field

Our team previously tracked approval in `fields.approved` — a JSON string on
78 cases, `"true"` on exactly zero of them. Paperclip has a real `approved`
lifecycle status that is indexed and event-logged. The gate reads the native
status. `fields.approved` is ignored.

Reviewers move a case to **Approved** in the Paperclip UI. That is the whole
handoff.

---

## The editor panel

Clicking a post opens a panel on the right. It holds:

- **Caption and alt text** — a textarea and an input with one explicit **Save**.
  Unsaved edits are marked, and the result of the save is stated inline. Nothing
  auto-saves.
- **Status** — a dropdown of the four review states (Draft, In review, Approved,
  Cancelled). This writes the **native** `cases.status`, the same field the
  Paperclip case page writes, emitting the same `status_changed` event. `done`
  and `in_progress` are not offered: a post becomes done by being published.
  `PANEL_STATUSES` in `src/cases.ts` is the single list, shared by the dropdown
  and the worker's validation, so the UI cannot offer a transition the worker
  would refuse.
- **Image** — a bounded preview of the attached image, read straight from the
  native asset content endpoint, with the case's alt text on the `<img>`. Empty,
  legacy and failed-to-load states each say what is actually true rather than
  showing a broken frame.
- **Replace image** — a file picker that uploads to Paperclip and repoints the
  case at the new asset.
- **Schedule and Post Now** — unchanged from 0.2.x.

### How an image replacement actually works

Traced from the installed server rather than guessed:

1. The browser posts the file to **`POST /api/cases/:id/attachments`**
   (`server/dist/routes/cases.js`) as `multipart/form-data` with the field name
   `file`. That one call creates the `assets` row, links it to the case through
   `case_attachments`, and records an `attachment_added` case event.
2. Only after that succeeds does the plugin worker write
   `fields.media_file = "asset:<uuid>"` (plus alt text) with a **merged** patch.

The ordering is the safety property: **the previous image stays attached and
stays referenced until the new one is in place.** A failed upload changes
nothing.

Two details worth keeping:

- **The upload is a browser `fetch` with `credentials: "include"`, and that is
  deliberate.** Plugin UI is served from `/_plugins/:pluginId/ui/*` and imported
  as an ES module into the host document, so it is same-origin and carries the
  operator's session — which is exactly how Paperclip's own UI uploads files
  (`postForm` → `fetch("/api"+path, {credentials:"include"})`, with no
  `Content-Type` header so the browser can set the multipart boundary). Sending
  bytes through the plugin bridge instead is not an option: that path is JSON
  with a 10 MB body limit, and base64 of a 10 MB image is ~13.3 MB.
- **The worker re-checks the link before repointing `media_file`.** It reads the
  case back and refuses an asset that is not actually attached to it, so a
  crafted action call cannot point a case at an arbitrary asset id.

### Validation

`POST /cases/:id/attachments` enforces the company's byte cap and rejects an
empty body, but — unlike `/companies/:id/assets/images` — it does **not** check
the content type. So the plugin checks it: PNG, JPEG, WebP and GIF only, the
image subset of Paperclip's own `DEFAULT_ALLOWED_TYPES`. SVG is excluded
because only the assets/images route sanitises SVG, and no channel we publish to
accepts it. The size limit shown in the panel is the real
`companies.attachment_max_bytes`, read through the plugin's `coreReadTables`
access rather than hardcoded.

### Publishing a native attachment

The X adapter publishes from a **file path** — it owns the OAuth1 v1.1 multipart
media upload and is the one part of this system proven end to end. So when
`media_file` is an `asset:<uuid>` reference, `src/media.ts` downloads the bytes
from the native content endpoint into a temp file for the length of one publish
and deletes it afterwards. A legacy host path is handed through untouched, so
every case that already publishes keeps publishing the same way. A download
failure is recorded as a **failed** attempt — never a text-only post of a case
that was meant to carry an image.

### One request per selection

`attachments` only exists on `GET /api/cases/:id`; the case **list** endpoint
returns bare rows. Projecting attachments onto every chip would therefore cost
one API round trip per post on every render of the month. Instead the
`case-detail` data handler is called by the panel, which is mounted only while a
card is selected — so the grid stays one request and detail is read once per
selection.

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
9. **the emergency pause is on → `dry_run`** — evaluated, recorded, nothing sent
10. otherwise → `publish`

**There is no per-post arming switch.** Approved + a publish date that has
arrived is the entire contract (JC, 2026-08-23: *"if something is approved and
we set a scheduled date, then it will go if it's green"*). The old `autoPost`
flag meant "this post has no date, publish it daily at a fixed time" — a concept
that died once every case carried its own `publish_at`.

`paused` is an instance-wide emergency stop, default off. It halts every route
including Post Now, because a stop a button can walk past is not a stop.

---

## Worker surface

| Kind | Key | What it does |
| --- | --- | --- |
| data | `calendar` | Every `social_post` case, grouped by Dubai day. One API read. |
| data | `case-detail` | One case with its native attachments and the upload limits. Called only while a card is selected. |
| data | `attempts` | Recent publish attempts, newest first. |
| data | `status` | Config health, so the UI can explain itself instead of rendering empty. |
| action | `save-content` | Writes caption / alt text as a merged field patch. |
| action | `set-status` | Writes the native case status. Only `PANEL_STATUSES`. |
| action | `set-media` | Repoints `media_file` at an asset already attached to the case. Refuses anything else. |
| action | `reschedule` | Moves `publish_at`, server-enforced to a Dubai `:00`/`:30` slot. |
| action | `post-now` | Publishes one case through the same gate as the cron sweep, with `manual: true`. |

---

## Configuration

Set on the plugin's settings page after install:

| Key | Required | Meaning |
| --- | --- | --- |
| `apiBaseUrl` | yes | Where to reach the Cases API. Use the loopback origin, e.g. `http://127.0.0.1:3100`. |
| `boardApiKeyRef` | yes | Secret **reference** to a board API key (`paperclipai token board create`). Resolved per call, never cached or logged. Without it the calendar shows a clear "not configured" notice instead of rendering empty. |
| `paused` | no | Default `false`. Emergency stop for the whole instance. Not a per-post switch. |
| `channels` | no | Channel keys the job may send to. A case on an unlisted channel is skipped with a reason. |
| `lookbackHours` | no | Default 6. How late a missed post may still go out. |

---

## Channel adapters

`src/channels.ts` defines the `ChannelAdapter` contract.

**X** delegates to the host publish script, which owns the OAuth1 credentials
and the v1.1 multipart media upload; the token never enters this process, the
plugin config, or the database. It reports `isConfigured: false` when that
script is absent, so the job records `skipped / no configured adapter` rather
than pretending to have posted.

**LinkedIn** stays unimplemented on purpose: the only token we hold is
`w_member_social`, which posts to a personal profile rather than the company
page. It reports `isConfigured: false` until the Community Management API
application is approved.

To add an adapter: implement `publish`, make `isConfigured` check for the
resolved credential, and register it in `ADAPTERS`. Put the credential in plugin
config as a secret reference — never in the source.

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
- **The calendar displays and accepts Asia/Dubai time (UTC+4).** `publish_at`
  remains a UTC instant in storage. Both the worker's day grouping and the UI's
  Today marker, labels, input value, and save conversion use the same Dubai
  helper module, so posts around midnight stay on the correct local date.
- **Plugin UI is same-origin, not sandboxed.** That is what makes the native
  upload work at all — and a reason not to install third-party plugins casually.
- **`POST /cases/:id/attachments` does not validate content type.** Only
  `/companies/:id/assets/images` does. Anything relying on the server to reject
  a non-image is relying on a check that is not there.
- **`media_file` may be an `asset:<uuid>` reference or a legacy host path.**
  Both publish. `parseAssetRef()` is the only place that tells them apart.
