# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.5.0

First public release under the Epic0x package and plugin identity. It installs as
a new Paperclip plugin with its own database namespace; it does not upgrade or
import state from a differently named private installation.

### Added

- `LICENSE` (MIT), `CHANGELOG.md` and `SECURITY.md`, and a README rewritten as
  operator documentation: install, configure, upgrade, uninstall, runtime
  requirements, requested capabilities, stored data and publish safety.
- `repository`, `homepage`, `bugs` and `publishConfig.access` in
  `package.json`, so the package resolves to a public repository and can be
  published from a scoped name.

### Changed

- The package is publishable: `private` removed, and `exports["."]` now
  resolves to the compiled `./dist/manifest.js` instead of TypeScript source —
  a consumer installing from a registry has no compiler in the path.
- `files` ships the public docs alongside `dist/` and `migrations/`; the
  compiled Node publisher is inside `dist/`, with no Python files or source maps
  in the tarball.
- The published artifact contains no sources, tests or CI configuration.

### Removed

- The Python publisher, subprocess wrapper, host credential file and
  `PAPERCLIP_X_PUBLISH_SCRIPT` override. X now runs inside the bundled Node
  worker and resolves four `xCredentials` secret references per company.
- Host-local `media_file` paths and `PAPERCLIP_MEDIA_DIR`. Durable media must be
  a native Paperclip `asset:<uuid>` reference so installations remain portable.

## 0.4.0

Calendar and editor release.

### Added

- **Post editor panel.** Selecting a post opens a panel that edits caption and
  alt text, sets the native case status, replaces the attached media and
  reschedules or publishes — so the Cases page is never a required stop.
- **Media attachments.** Images and video (`image/png`, `image/jpeg`,
  `image/webp`, `image/gif`, `video/mp4`, `video/quicktime`) are uploaded
  through Paperclip's native case-attachment endpoint; the case's `media_file`
  is only repointed after the upload succeeds, so a failed upload changes
  nothing. Cards render an image or a video preview from the recorded
  `media_type`.
- **List view.** A flat, uncapped ordering of every post — soonest first,
  undated last — alongside the month grid.
- **Video publishing.** The bundled X publisher takes video up the chunked
  `INIT`/`APPEND`/`FINALIZE`/`STATUS` path and waits for transcoding, rather
  than applying the image size cap to clips.
- **`create-post` action**, for creating a `social_post` case from the
  calendar.

### Changed

- Scheduling is restricted to `:00` and `:30` slots in Asia/Dubai on both the
  UI and the server, so day grouping and the publish job cannot drift apart.
- The scheduled sweep resolves its company from the
  `PAPERCLIP_CONTENT_CALENDAR_COMPANY_ID` environment variable instead of a
  compiled-in constant, and fails loudly when it is unset or malformed.
- Approval is read from the native `cases.status === "approved"` rather than a
  JSON field; the per-post auto-post flag is gone. Approved plus a due
  `publish_at` is the whole rule.
