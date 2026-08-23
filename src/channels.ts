/**
 * Channel adapters.
 *
 * The contract is `ChannelAdapter`. Credentials are always resolved at call
 * time from plugin config secret references — never read from files, never
 * cached, never logged.
 */

import { createHmac, randomBytes } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { CalendarConfig, CalendarEntry } from "./cases.js";

export interface PublishRequest {
  entry: CalendarEntry;
  caption: string;
  /** Storage key or URL of the attached media, when the case has one. */
  mediaFile: string | null;
}

export interface PublishResult {
  ok: boolean;
  /** Canonical URL of the published post. Required when ok is true. */
  url: string | null;
  /** One-line failure reason. Required when ok is false. */
  error: string | null;
  /** Raw adapter response, persisted for debugging. Must not contain secrets. */
  raw: Record<string, unknown>;
}

export interface ChannelAdapter {
  readonly channel: string;
  /**
   * True when this adapter has everything it needs to actually send.
   * The gate calls this BEFORE attempting, so a missing credential is reported
   * as a clear skip reason instead of a runtime throw.
   */
  isConfigured(ctx: PluginContext, cfg: CalendarConfig): Promise<boolean>;
  publish(
    ctx: PluginContext,
    cfg: CalendarConfig,
    req: PublishRequest,
  ): Promise<PublishResult>;
}

// ---------------------------------------------------------------------------
// OAuth 1.0a signing for X
// ---------------------------------------------------------------------------

/** RFC 3986 percent-encoding. encodeURIComponent leaves !*'() alone; X does not. */
function enc(v: string): string {
  return encodeURIComponent(v).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

interface XCreds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

/**
 * Build an OAuth 1.0a Authorization header.
 *
 * LOAD-BEARING PITFALL: for the v2 JSON endpoints the signature base string
 * contains ONLY the oauth_* parameters — the JSON request body is NOT part of
 * it. Including the body produces a signature that is internally consistent but
 * that X rejects with 401. (Form-encoded v1.1 endpoints are the opposite: their
 * form fields DO get signed, which is what `extraParams` is for.)
 */
function authHeaderFor(
  method: string,
  url: string,
  creds: XCreds,
  extraParams?: Record<string, string>,
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  const all: Record<string, string> = { ...(extraParams ?? {}), ...oauth };
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${enc(k)}=${enc(all[k])}`)
    .join("&");

  const base = [method.toUpperCase(), enc(url), enc(paramString)].join("&");
  const signingKey = `${enc(creds.apiSecret)}&${enc(creds.accessSecret)}`;
  oauth.oauth_signature = createHmac("sha1", signingKey)
    .update(base)
    .digest("base64");

  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${enc(k)}="${enc(oauth[k])}"`)
      .join(", ")
  );
}

/**
 * Resolve X credentials from plugin config.
 *
 * Each is a secret reference (`{type:"secret_ref", secretId:"..."}`) pointing at
 * a Paperclip-managed secret. Returns null when any part is missing, so
 * `isConfigured` can report a clean false rather than throwing mid-publish.
 */
const X_PUBLISH_SCRIPT =
  process.env.PAPERCLIP_X_PUBLISH_SCRIPT ??
  "/home/openclaw/.hermes/scripts/x_publish.py";

const MEDIA_DIR =
  process.env.PAPERCLIP_MEDIA_DIR ?? "/home/openclaw/social/out";

/**
 * X adapter.
 *
 * Delegates to the host publish script instead of reimplementing X here. That
 * script owns the OAuth1 credentials and the v1.1 multipart media upload — X's
 * v2 API has no upload endpoint, so an image must go through v1.1 first to get
 * a media_id, and signing a multipart OAuth1 request is the single most
 * error-prone corner of that API. It is already proven end to end.
 *
 * The token never enters this process, the plugin config, or the database.
 * The script emits exactly one JSON object on stdout either way, so the result
 * is parsed rather than scraped out of log noise.
 */
const xAdapter: ChannelAdapter = {
  channel: "x",

  async isConfigured() {
    const { existsSync } = await import("node:fs");
    return existsSync(X_PUBLISH_SCRIPT);
  },

  async publish(_ctx, _cfg, req): Promise<PublishResult> {
    const { spawn } = await import("node:child_process");
    const { existsSync } = await import("node:fs");

    const caption = req.caption?.trim();
    if (!caption) {
      return { ok: false, url: null, error: "case has no caption", raw: {} };
    }
    // 280 is an X limit, not a universal one — LinkedIn cases run ~1700 chars
    // and are perfectly valid, so this check belongs here, not in the gate.
    if (caption.length > 280) {
      return {
        ok: false,
        url: null,
        error: `caption is ${caption.length} chars, X allows 280`,
        raw: { length: caption.length },
      };
    }

    let mediaPath: string | null = null;
    if (req.mediaFile) {
      mediaPath = req.mediaFile.startsWith("/")
        ? req.mediaFile
        : `${MEDIA_DIR}/${req.mediaFile}`;
      if (!existsSync(mediaPath)) {
        // Fail rather than quietly posting text-only. A visual post that
        // silently loses its image is worse than one that does not go out.
        return {
          ok: false,
          url: null,
          error: `media file not found: ${mediaPath}`,
          raw: { mediaFile: req.mediaFile },
        };
      }
    }

    const payload = JSON.stringify({
      text: caption,
      media: mediaPath,
      alt: req.entry.altText ?? null,
    });

    return new Promise<PublishResult>((resolve) => {
      const child = spawn("python3", [X_PUBLISH_SCRIPT, payload], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 180_000,
      });

      let out = "";
      let err = "";
      child.stdout.on("data", (c: Buffer) => { out += String(c); });
      child.stderr.on("data", (c: Buffer) => { err += String(c); });

      child.on("close", () => {
        try {
          const line = out.trim().split("\n").filter(Boolean).pop() ?? "{}";
          const r = JSON.parse(line) as {
            ok?: boolean; url?: string; media_id?: string; error?: string;
          };
          if (r.ok === true && r.url) {
            resolve({
              ok: true,
              url: r.url,
              error: null,
              raw: { mediaId: r.media_id ?? null, hadMedia: Boolean(mediaPath) },
            });
          } else {
            resolve({
              ok: false,
              url: null,
              error: r.error ?? "publisher reported failure without a reason",
              raw: { implemented: true },
            });
          }
        } catch {
          resolve({
            ok: false,
            url: null,
            error: (err.trim() || out.trim() || "no output from publisher")
              .slice(0, 300),
            raw: { implemented: true, unparseable: true },
          });
        }
      });

      child.on("error", (e) => {
        resolve({ ok: false, url: null, error: e.message, raw: {} });
      });
    });
  },
};

/**
 * LinkedIn stays UNIMPLEMENTED on purpose.
 *
 * The only token we hold is `w_member_social`, which posts to JC's PERSONAL
 * profile rather than the Untrace company page. Wiring this up would publish
 * company content to an individual's feed. It stays disabled until the
 * Community Management API application is approved.
 */

const linkedinAdapter: ChannelAdapter = {
  channel: "linkedin",
  async isConfigured() {
    return false;
  },
  async publish() {
    return {
      ok: false,
      url: null,
      error: "LinkedIn adapter not implemented yet. Nothing was sent.",
      raw: { implemented: false },
    };
  },
};

export const ADAPTERS: Record<string, ChannelAdapter> = {
  x: xAdapter,
  linkedin: linkedinAdapter,
};

export function adapterFor(channel: string | null): ChannelAdapter | null {
  if (!channel) return null;
  return ADAPTERS[channel.toLowerCase()] ?? null;
}
