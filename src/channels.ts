/**
 * Channel adapters.
 *
 * Credentials are Paperclip secret references. They are resolved for the
 * active company at call time, never read from files, cached or logged.
 */

import { randomBytes } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { CalendarConfig, CalendarEntry } from "./cases.js";
import {
  publishToX,
  type XCredentials,
  type XPublisherDeps,
  type XRequestSpec,
  type XResponse,
} from "./x-publisher.js";

export interface PublishRequest {
  entry: CalendarEntry;
  caption: string;
  /** Absolute local path prepared by the media resolver, or null. */
  mediaFile: string | null;
}

export interface PublishResult {
  ok: boolean;
  url: string | null;
  error: string | null;
  /** Persisted for diagnostics. Never contains credential values. */
  raw: Record<string, unknown>;
}

export interface ChannelAdapter {
  readonly channel: string;
  isConfigured(
    ctx: PluginContext,
    cfg: CalendarConfig,
    companyId: string,
  ): Promise<boolean>;
  publish(
    ctx: PluginContext,
    cfg: CalendarConfig,
    companyId: string,
    req: PublishRequest,
  ): Promise<PublishResult>;
}

const X_CONFIG_PATHS = {
  apiKey: "xCredentials.apiKeyRef",
  apiSecret: "xCredentials.apiSecretRef",
  accessToken: "xCredentials.accessTokenRef",
  accessSecret: "xCredentials.accessSecretRef",
} as const;

async function resolveSecret(
  ctx: PluginContext,
  ref: unknown,
  companyId: string,
  configPath: string,
): Promise<string | null> {
  if (!ref) return null;
  const value = await ctx.secrets.resolve(ref as string, {
    companyId,
    configPath,
  });
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

/** Whether all four secret references are present, without resolving values. */
function hasXCredentialRefs(cfg: CalendarConfig): boolean {
  const refs = cfg.xCredentials;
  return Boolean(
    refs?.apiKeyRef &&
      refs.apiSecretRef &&
      refs.accessTokenRef &&
      refs.accessSecretRef,
  );
}

/** Resolve one complete OAuth1 set for one company at publish time. */
async function resolveXCredentials(
  ctx: PluginContext,
  cfg: CalendarConfig,
  companyId: string,
): Promise<XCredentials | null> {
  const refs = cfg.xCredentials;
  if (!refs) return null;

  const [apiKey, apiSecret, accessToken, accessSecret] = await Promise.all([
    resolveSecret(ctx, refs.apiKeyRef, companyId, X_CONFIG_PATHS.apiKey),
    resolveSecret(ctx, refs.apiSecretRef, companyId, X_CONFIG_PATHS.apiSecret),
    resolveSecret(ctx, refs.accessTokenRef, companyId, X_CONFIG_PATHS.accessToken),
    resolveSecret(ctx, refs.accessSecretRef, companyId, X_CONFIG_PATHS.accessSecret),
  ]);
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) return null;
  return { apiKey, apiSecret, accessToken, accessSecret };
}

async function xRequest(spec: XRequestSpec): Promise<XResponse> {
  const url = new URL(spec.url);
  for (const [key, value] of Object.entries(spec.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: spec.method,
    headers: spec.headers,
    body: spec.body as BodyInit | null | undefined,
    signal: AbortSignal.timeout(120_000),
  });
  return { status: response.status, body: await response.text() };
}

export async function readRange(
  path: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    let totalRead = 0;
    while (totalRead < length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalRead,
        length - totalRead,
        offset + totalRead,
      );
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    return buffer.subarray(0, totalRead);
  } finally {
    await handle.close();
  }
}

function xDeps(credentials: XCredentials): XPublisherDeps {
  return {
    credentials,
    request: xRequest,
    readFile,
    readRange,
    stat,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    nonce: () => randomBytes(16).toString("hex"),
    now: () => Date.now(),
  };
}

const xAdapter: ChannelAdapter = {
  channel: "x",

  async isConfigured(_ctx, cfg, _companyId) {
    return hasXCredentialRefs(cfg);
  },

  async publish(ctx, cfg, companyId, req): Promise<PublishResult> {
    const caption = req.caption?.trim();
    if (!caption) {
      return { ok: false, url: null, error: "case has no caption", raw: {} };
    }
    if (caption.length > 280) {
      return {
        ok: false,
        url: null,
        error: `caption is ${caption.length} chars, X allows 280`,
        raw: { length: caption.length },
      };
    }

    let credentials: XCredentials | null;
    try {
      credentials = await resolveXCredentials(ctx, cfg, companyId);
    } catch {
      return {
        ok: false,
        url: null,
        error: "X credential resolution failed",
        raw: { configured: true, credentialResolution: "failed" },
      };
    }
    if (!credentials) {
      return {
        ok: false,
        url: null,
        error: "X credentials are incomplete or unavailable",
        raw: { configured: false },
      };
    }

    const result = await publishToX(
      {
        text: caption,
        mediaPath: req.mediaFile,
        altText: req.entry.altText,
      },
      xDeps(credentials),
    );
    if (!result.ok || !result.url) {
      return {
        ok: false,
        url: null,
        error: result.error ?? "X returned no post URL",
        raw: { implemented: true, hadMedia: Boolean(req.mediaFile) },
      };
    }

    return {
      ok: true,
      url: result.url,
      error: null,
      raw: {
        postId: result.id,
        mediaId: result.mediaId,
        hadMedia: Boolean(req.mediaFile),
      },
    };
  },
};

/** LinkedIn remains disabled until an organization-authorized adapter exists. */
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
