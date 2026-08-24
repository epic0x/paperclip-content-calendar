# Security Policy

## Reporting a vulnerability

Report security vulnerabilities **privately** to **contact@untrace.network**.

**Do not open a public GitHub issue, pull request, or discussion for a
vulnerability, or for anything containing a secret** — an API key, an OAuth
token, a session cookie, a credential file, or a log excerpt that carries one.
Public issues are indexed the moment they are created, and a leaked credential
cannot be un-leaked by deleting the issue afterwards. If you have already
posted one, email the address above so the credential can be rotated.

Include what you can:

- the plugin version (`paperclipai plugin inspect epic0x.plugin-content-calendar`);
- the Paperclip version it is installed on;
- what an attacker gains, and the steps to reproduce it;
- any proof-of-concept — as an email attachment, not a public gist.

You will get an acknowledgement within 3 business days. Fixed issues are
credited in [CHANGELOG.md](CHANGELOG.md) unless you ask otherwise.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.5.x | yes |
| < 0.5 | no — pre-release, unsupported |

## What this plugin handles

- **Secret references, not secrets.** The board API key and the X OAuth 1.0a
  credential set are configured as secret *references*, resolved by the host
  per call. They are not stored in the plugin's schema and are not written to
  logs.
- **Same-origin UI.** Plugin UI is served from `/_plugins/:pluginId/ui/*` and
  imported into the host document, so it runs with the operator's session. That
  is a good reason to review any Paperclip plugin — this one included — before
  installing it.
- **Publishing is irreversible.** A `sent` publish attempt puts a post on a
  public network. See "Publish safety" in the [README](README.md#publish-safety)
  for the interlocks that guard it.

If you find a way to make this plugin publish a case that was not approved, or
to read a secret it should not, that is a vulnerability — please report it.
