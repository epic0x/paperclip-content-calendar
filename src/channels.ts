/**
 * Channel adapters.
 *
 * OWNERSHIP: the X/LinkedIn implementations belong to the CMO (Son of Davis).
 * Publishing is his lane and the channel credentials are his. This file defines
 * the contract and ships a safe no-op so the rest of the plugin is testable and
 * installable today without any channel token existing anywhere.
 *
 * To add a real channel: implement `ChannelAdapter`, register it in
 * `ADAPTERS`, and put the token in plugin config as a secret reference so it is
 * resolved at call time and never persisted.
 */

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
   * The job calls this BEFORE attempting, so a missing token is reported as a
   * clear skip reason instead of a runtime throw.
   */
  isConfigured(ctx: PluginContext, cfg: CalendarConfig): Promise<boolean>;
  publish(
    ctx: PluginContext,
    cfg: CalendarConfig,
    req: PublishRequest,
  ): Promise<PublishResult>;
}

/**
 * Placeholder X adapter — DELIBERATELY NOT IMPLEMENTED.
 *
 * It reports itself unconfigured, so the publish job records
 * `skipped / adapter not implemented` and never pretends to have posted.
 *
 * CMO: replace the body of `publish` and make `isConfigured` check for the
 * resolved token. Do not hardcode a script path — the June scaffold spawned
 * `/root/.openclaw/.../x-post.mjs`, which exists on no host we run.
 */
const xAdapter: ChannelAdapter = {
  channel: "x",
  async isConfigured() {
    return false;
  },
  async publish() {
    return {
      ok: false,
      url: null,
      error:
        "X adapter not implemented yet — owned by the CMO. Nothing was sent.",
      raw: { implemented: false },
    };
  },
};

const linkedinAdapter: ChannelAdapter = {
  channel: "linkedin",
  async isConfigured() {
    return false;
  },
  async publish() {
    return {
      ok: false,
      url: null,
      error:
        "LinkedIn adapter not implemented yet — owned by the CMO. Nothing was sent.",
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
