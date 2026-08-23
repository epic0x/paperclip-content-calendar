# Content Calendar — Paperclip plugin

Social content calendar for Paperclip: schedule posts, approve them, publish to
X with media, and see the week on a grid inside the Paperclip dashboard.

## Why this is a plugin and not a fork

Paperclip ships a first-class plugin runtime — UI slots, a worker, its own
Postgres namespace, scheduled jobs. Everything the calendar needs is an
extension point that already exists. A fork would mean carrying a permanent
merge burden against an upstream we do not control, for features the plugin
API already supports.

## What it does

- **Calendar grid** inside the Paperclip dashboard, one column per day
- **Approval workflow** — `draft → approved → posted`, approval is a human act
- **Publishes to X with media and alt text**, at the scheduled time
- **Imports Paperclip cases** so the calendar mirrors approved content rather
  than becoming a second place where copy lives

## Source of truth

Content is authored and approved as a Paperclip **case**. The calendar is a
**view over approved cases**, never a parallel store:

```
case (social_post)  ──import-cases──▶  calendar post  ──daily job──▶  X
   approve copy                          approve publish
```

`source_ref` on every imported row carries the case identifier (`UNT-C96`) and
is uniquely indexed, so re-importing updates in place instead of duplicating a
week. Rows already `posted` are never touched by an import.

**The two approvals are deliberately separate.** Approving a case approves the
*copy*. Approving in the calendar approves *publishing*. Collapsing them would
mean an editor approving a caption silently schedules a live post.

## Publishing

The daily job calls a host script that owns the platform credentials:

```
PAPERCLIP_X_PUBLISH_SCRIPT   default: ~/.hermes/scripts/x_publish.py
```

The script takes one JSON argument and always returns one JSON object on
stdout, success or failure — so the worker parses a result rather than scraping
log text:

```bash
x_publish.py '{"text":"...","media":"/abs/path.png","alt":"...","dry":true}'
{"ok": true, "dry": true, "chars": 108, "media": "/abs/path.png", "alt": true}
```

Media goes through X's v1.1 multipart upload (v2 has no upload endpoint) and
alt text is set on every image.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PAPERCLIP_X_PUBLISH_SCRIPT` | `~/.hermes/scripts/x_publish.py` | Publisher |
| `PAPERCLIP_BASE_URL` | `http://127.0.0.1:3100` | Host API for case import |
| `PAPERCLIP_API_TOKEN` | — | Bearer token for that API |

## Build

The package depends on the published SDK, so it builds standalone — no
Paperclip monorepo checkout required.

```bash
npm install
npx tsc --noEmit      # 0 errors
npm run build         # emits dist/manifest.js, dist/worker.js, dist/ui/
paperclipai plugin install "$PWD"
```

## Data model

`plugin_content_calendar_*.posts`, beyond the base columns:

| Column | Purpose |
| --- | --- |
| `media_path` | Absolute path to the image on the publishing host |
| `alt_text` | Accessibility text. **DB-enforced** whenever `media_path` is set |
| `media_id` | Platform media id returned at upload — audit trail |
| `source_ref` | Originating case identifier, uniquely indexed |

The alt-text rule is a CHECK constraint rather than a code path, because an
accessibility rule that only lives in application code eventually gets bypassed.

## Known limits

- X only. The `platform` column exists but no other publisher is wired.
- Import reads `fields.caption` / `publish_at` / `media_file` / `alt_text` — a
  case shape this plugin defines, not a Paperclip standard.
- `media_path` is a host filesystem path, so the publishing host must be the
  machine holding the images.
