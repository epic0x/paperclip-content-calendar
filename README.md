# Content Calendar — a Paperclip plugin

A month calendar and a list view for `social_post` cases, plus a job that
publishes them when they are approved and due.

**Cases stay the source of truth.** This plugin does not author content, does
not copy captions into its own tables, and does not invent its own approval
flag. It reads cases over the Paperclip API, lays them out by `publish_at`, and
records what it published.

```bash
npm install @epic0x/paperclip-plugin-content-calendar
```

---

## Features

- **Month grid and List view.** The grid places every `social_post` case on its
  Asia/Dubai publish day. List view is flat and uncapped — soonest first,
  undated posts last — so nothing is hidden behind a per-day limit.
- **Post editor panel.** Selecting a post opens a panel that does the whole
  job: caption, alt text, case status, media, reschedule, publish. The Cases
  page is never a required stop.
- **Image and video attachments.** PNG, JPEG, WebP and GIF images, and MP4 and
  QuickTime video, uploaded through Paperclip's native case-attachment
  endpoint. Cards render an image or a video preview from the recorded
  `media_type`.
- **Scheduling on half-hour slots.** Both the UI and the server round
  `publish_at` to `:00` / `:30` in Asia/Dubai, which is what lets a twice-hourly
  job run with no drift. Storage stays a UTC instant.
- **Publish job.** Twice an hour the job finds approved cases whose
  `publish_at` has arrived and publishes them, recording every decision.
- **Post Now**, for publishing one case immediately through the same gate.
- **An append-only publish log**, with a database-enforced interlock that makes
  double-posting impossible.

X publishing is optional: with no channel configured this is a working calendar
and publish log that records `skipped / no configured adapter` instead of
posting.

---

## Requirements

- **Paperclip 2026.821.0-canary.11 or newer.** That is the `@paperclipai/plugin-sdk`
  version this plugin is built against; the plugin API version it declares is 1.
- **Node.js 22 or newer**, on the machine running the Paperclip host. X
  publishing is bundled Node code and needs no second language runtime.
- **A board API key**, for reading cases over the authenticated API.

---

## Installation

Install the package, then install the built plugin directory into your
Paperclip instance:

```bash
npm install @epic0x/paperclip-plugin-content-calendar

# confirm which instance you are pointing at before you change it
paperclipai plugin target

paperclipai plugin install ./node_modules/@epic0x/paperclip-plugin-content-calendar
paperclipai plugin inspect epic0x.plugin-content-calendar
```

`plugin install` copies built output from disk — nothing is compiled on the
server, and the installed plugin directory has no `node_modules`. `inspect`
should report status `active` and the two migrations applied.

### Required environment variable

The scheduled sweep needs to know whose posts to publish. Set this in the
environment of the **Paperclip host process**, not in plugin config:

```bash
PAPERCLIP_CONTENT_CALENDAR_COMPANY_ID=<company uuid>
```

There is no default. Unset or malformed, the job throws an error naming the
variable rather than silently sweeping nothing. The interactive surfaces — the
calendar, the panel, Post Now — pass the company through from the UI and do not
use it.

**Finding the company uuid:** open the company in the Paperclip UI and read it
out of the address bar, or ask the API with your board API key:

```bash
curl -s -H "Authorization: Bearer $BOARD_API_KEY" \
  http://127.0.0.1:3100/api/companies
```

---

## Configuration

Set on the plugin's settings page after install:

| Key | Required | Meaning |
| --- | --- | --- |
| `apiBaseUrl` | yes | Where the plugin reaches the Cases API. Use the loopback origin of your own host, e.g. `http://127.0.0.1:3100`. |
| `boardApiKeyRef` | yes | Secret **reference** to a board API key (`paperclipai token board create`). Without it the calendar shows a "not configured" notice instead of rendering empty. |
| `paused` | no | Default `false`. Instance-wide emergency stop. |
| `channels` | no | Channel keys the publish job may send to. A case on an unlisted channel is skipped with a reason. |
| `xCredentials` | no | Secret references for the X OAuth 1.0a set: API key, API secret, access token, access secret. All four are needed to post to X. |
| `lookbackHours` | no | Default `6`. How late a missed post may still go out. |

### Secret references

Credentials are configured as secret **references**, never as literal values.
The host resolves a reference per call; the plugin does not cache it, does not
write it to its own tables, and does not log it. Create the secret in Paperclip
first, then point the setting at it.

### Channels

`src/channels.ts` defines the `ChannelAdapter` contract. **X** is the one
adapter shipped. Its bundled Node publisher owns OAuth 1.0a signing, image
multipart upload, and the `INIT` / `APPEND` / `FINALIZE` / `STATUS` video
protocol. An adapter reports `isConfigured: false` when its secret references
are incomplete, and the job records `skipped` rather than pretending to have
posted. **LinkedIn** is declared but unimplemented.

To add an adapter: implement `publish`, make `isConfigured` check for the
resolved credential, and register it in `ADAPTERS`. Put the credential in
plugin config as a secret reference — never in source.

### Upgrading

```bash
npm install @epic0x/paperclip-plugin-content-calendar@latest
paperclipai plugin target
paperclipai plugin install ./node_modules/@epic0x/paperclip-plugin-content-calendar
paperclipai plugin inspect epic0x.plugin-content-calendar
```

Migrations are additive within the Epic0x plugin identity and are applied by the
host on install. Version 0.5.0 starts a fresh database namespace; it does not
import state from a differently named installation. Check `inspect` reports the
new version and status `active`.

### Uninstalling

```bash
paperclipai plugin uninstall epic0x.plugin-content-calendar
```

Removing the plugin stops the job and the UI surfaces. It does **not** drop the
plugin's schema — the publish log is an audit record and outlives the install.
Drop `plugin_content_calendar_f2583e060b` by hand if you want the history gone,
and unset `PAPERCLIP_CONTENT_CALENDAR_COMPANY_ID`. No case is modified by an
uninstall.

---

## Cases and the native schema

The plugin reads and writes Paperclip's own case model. It adds no case table
of its own.

- **Case type:** `social_post`.
- **Approval is the native case status.** A case publishes when
  `cases.status === "approved"` — the indexed, event-logged lifecycle status
  that the Paperclip case page writes. There is no separate approval field.
- **Fields it reads and writes**, all inside `cases.fields`: `publish_at` (the
  scheduled instant), `channel`, `caption`, `alt_text`, `media_file`,
  `media_type`, and `publish_url`, written back after a successful send.
  `media_file` must be a native `asset:<uuid>` reference; host-local paths are
  rejected because they cannot survive installation on another machine.
- **`cases.fields` is replaced wholesale on PATCH, never deep-merged.** Every
  write this plugin makes reads the case first and sends a merged object.
- **Media is stored by Paperclip**, through `POST /api/cases/:id/attachments`,
  which creates the asset, links it to the case and logs the event. Only after
  that succeeds does the plugin repoint `media_file`. A failed upload changes
  nothing, and the previous media stays attached.

## Publish safety

Every reason to publish or not lives in one pure function, `src/gate.ts`,
evaluated in this order:

1. already sent → `skipped`
2. the case already carries a `publish_url` → `skipped`
3. the case is `cancelled` or `done` → `skipped`
4. the case status is not `approved` → `skipped`
5. no caption → `skipped`
6. no channel, channel not enabled in config, or no configured adapter → `skipped`
7. no `publish_at`, unparseable, or not due yet → `skipped`
8. overdue beyond `lookbackHours` → `skipped` — reschedule rather than post late
9. `paused` is on → `dry_run`: evaluated and recorded, nothing sent
10. otherwise → publish

Three interlocks sit under that:

- **A partial unique index on `outcome = 'sent'`** means a case can be sent at
  most once. A late, duplicated or concurrent job run hits a constraint
  violation instead of double-posting.
- **`paused` halts every route**, including Post Now. A stop a button can walk
  past is not a stop.
- **A media download failure is recorded as `failed`**, never downgraded to a
  text-only post of a case that was meant to carry an image or video.

## Requested capabilities

The manifest asks the host for exactly these, and nothing broader:

| Capability | Why |
| --- | --- |
| `companies.read` | Read the company row for attachment limits and context. |
| `projects.read` | Read project context for a case. |
| `database.namespace.migrate` | Create the plugin's two tables on install. |
| `database.namespace.read` | Read the publish log and schedule overrides. |
| `database.namespace.write` | Append publish attempts and overrides. |
| `jobs.schedule` | Register the twice-hourly publish job. |
| `http.outbound` | Reach the Paperclip Cases API and the channel adapter. |
| `secrets.read-ref` | Resolve the board API key and channel credentials from references. |
| `activity.log.write` | Leave an audit trail in the Paperclip activity log. |
| `ui.page.register` | The calendar page. |
| `ui.sidebar.register` | The sidebar entry. |
| `ui.dashboardWidget.register` | The "Upcoming posts" widget. |
| `ui.action.register` | The panel's save, status, media, reschedule and publish actions. |

Note that `cases` is deliberately **not** in the plugin's `coreReadTables`
whitelist — it is not readable from plugin SQL at all. Case access goes over the
authenticated HTTP API, which is why a board API key is required.

## What it stores

One host-derived schema, `plugin_content_calendar_f2583e060b`, with two tables.
Neither duplicates a case:

- **`publish_attempts`** — append-only, one row per attempt: the case id and
  identifier, the channel, the `publish_at` at attempt time, the outcome
  (`sent` / `dry_run` / `failed` / `skipped`), the reason, the resulting post
  URL, a SHA-256 hash of the caption as sent, and the raw adapter response.
  Never updated in place, never deleted.
- **`schedule_overrides`** — one row per reschedule made from the calendar,
  recorded before `publish_at` is written back to the case, so a failed
  write-back is visible rather than lost.

No captions, no media bytes, and no credentials are stored by this plugin.

## Security

Plugin UI is served same-origin and runs with the operator's session, and this
plugin can publish to public networks — review it before installing it, as you
should any Paperclip plugin.

Report vulnerabilities privately to `contact@untrace.network`. Do not open a
public issue for a vulnerability or a leaked secret. See
[SECURITY.md](SECURITY.md).

---

## Development

```bash
npm install
npm run build          # esbuild → dist/
npm run typecheck      # tsc --noEmit
npm test               # node --test test/*.test.mjs
npm run verify:namespace
```

`verify:namespace` checks that the schema name hardcoded in
`migrations/001_publish_log.sql` still matches the one the host derives as
`plugin_<namespaceSlug>_<sha256(pluginId)[0:10]>`. Changing `PLUGIN_ID` or
`NAMESPACE_SLUG` changes that hash and makes every migration statement fail as
out-of-namespace, so the check runs in CI before anything reaches a server.

Issues and pull requests:
<https://github.com/epic0x/paperclip-content-calendar>.

## License

MIT — see [LICENSE](LICENSE).
