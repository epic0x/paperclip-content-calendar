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
async function resolveXCreds(
  ctx: PluginContext,
  cfg: CalendarConfig,
): Promise<XCreds | null> {
  const refs = cfg.xCredentials;
  if (!refs) return null;
  const need = ["apiKeyRef", "apiSecretRef", "accessTokenRef", "accessSecretRef"] as const;
  if (need.some((k) => !refs[k])) return null;

  try {
    const [apiKey, apiSecret, accessToken, accessSecret] = await Promise.all(
      need.map((k) =>
        ctx.secrets.resolve(refs[k] as string, {
          configPath: `xCredentials.${k}`,
        }),
      ),
    );
    if (!apiKey || !apiSecret || !accessToken || !accessSecret) return null;
    return { apiKey, apiSecret, accessToken, accessSecret };
  } catch (err) {
    ctx.logger.warn(
      `[content-calendar] could not resolve X credentials: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

const X_TWEETS_URL = "https://api.x.com/2/tweets";
/** X hard-limits a standard post. Fail before the API does, with a clear reason. */
const X_MAX_CHARS = 280;

const xAdapter: ChannelAdapter = {
  channel: "x",

  async isConfigured(ctx, cfg) {
    return (await resolveXCreds(ctx, cfg)) !== null;
  },

  async publish(ctx, cfg, req) {
    const creds = await resolveXCreds(ctx, cfg);
    if (!creds) {
      return {
        ok: false,
        url: null,
        error:
          "X credentials are not configured. Set xCredentials.{apiKeyRef,apiSecretRef,accessTokenRef,accessSecretRef} in plugin config as secret references.",
        raw: { configured: false },
      };
    }

    const text = req.caption.trim();
    if (text.length > X_MAX_CHARS) {
      return {
        ok: false,
        url: null,
        error: `caption is ${text.length} characters, over the ${X_MAX_CHARS} limit for X`,
        raw: { length: text.length },
      };
    }

    // Media is not attached yet: v2 has no upload endpoint, it needs the v1.1
    // media/upload flow. Posting text-only would silently drop the image the
    // reviewer approved, so refuse instead.
    if (req.mediaFile) {
      return {
        ok: false,
        url: null,
        error:
          "case has media attached and media upload is not implemented yet; refusing to post text-only and silently drop the image",
        raw: { mediaFile: req.mediaFile },
      };
    }

    const body = JSON.stringify({ text });
    // Public endpoint: use the audited host client so the call is traced.
    const res = await ctx.http.fetch(X_TWEETS_URL, {
      method: "POST",
      headers: {
        // Body deliberately excluded from the signature — see authHeaderFor.
        Authorization: authHeaderFor("POST", X_TWEETS_URL, creds),
        "Content-Type": "application/json",
      },
      body,
    });

    const raw = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { body: raw.slice(0, 400) };
    }

    if (!res.ok) {
      return {
        ok: false,
        url: null,
        error: `X API ${res.status}: ${raw.slice(0, 200)}`,
        raw: { status: res.status, ...parsed },
      };
    }

    const id = (parsed as { data?: { id?: string } }).data?.id;
    if (!id) {
      return {
        ok: false,
        url: null,
        error: `X returned ${res.status} but no tweet id`,
        raw: parsed,
      };
    }

    return {
      ok: true,
      url: `https://x.com/i/web/status/${id}`,
      error: null,
      raw: parsed,
    };
  },
};

/**
 * LinkedIn — not implemented. Reports unconfigured so the gate records
 * "skipped, no configured adapter" rather than ever claiming a false success.
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
