/**
 * Getting an attached image to the publisher.
 *
 * The native `assets` row is the source of truth for what is attached to a
 * case. The X publish script, however, takes a FILE PATH — it owns the OAuth1
 * v1.1 multipart media upload and is the one part of this system proven end to
 * end, so it is not being rewritten to speak HTTP to Paperclip.
 *
 * This module bridges the two, and only for the length of one publish:
 *
 *   media_file = "asset:<uuid>"  → download from /api/assets/<uuid>/content,
 *                                  write a temp file, delete it afterwards
 *   media_file = anything else   → hand it through untouched, so every case
 *                                  that already publishes from a host path
 *                                  keeps publishing exactly as it did
 *
 * A download failure THROWS. Posting a visual case as text-only because the
 * image could not be fetched is worse than not posting it, which is the same
 * rule the adapter already applies to a missing file.
 */

import { normalizeContentType, parseAssetRef } from "./attachments.js";

export interface AssetBytes {
  bytes: Uint8Array;
  contentType: string;
}

export interface MediaDeps {
  downloadAsset(assetId: string): Promise<AssetBytes>;
  writeTempFile(fileName: string, bytes: Uint8Array): Promise<string>;
  removeFile(path: string): Promise<void>;
  /**
   * A value unique to THIS publish attempt.
   *
   * Injected rather than generated here so the file name stays a pure function
   * of its inputs. The worker passes a random uuid; see `tempFileNameFor` for
   * why one per attempt is the requirement.
   */
  newAttemptId(): string;
}

export interface ResolvedMedia {
  /** What the adapter should publish, or null when the case has no media. */
  path: string | null;
  /** Set only when the path is a temp copy of a native asset. */
  assetId: string | null;
  /** Always safe to call. Removes the temp copy if there was one. */
  cleanup(): Promise<void>;
}

const noop = async () => {};

/**
 * Extension for a temp copy, from the asset's content type.
 *
 * LOAD-BEARING for video. The publish script picks the simple image upload or
 * X's chunked video upload from this extension, and X itself sniffs it too, so
 * an mp4 written to `content-calendar-….bin` is a video that goes up the image
 * path and is rejected. An unknown type still gets `.bin` — publishing bytes
 * whose type we cannot name, under a name that claims a type, is worse.
 */
const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
};

/**
 * Reduce a value to something that is unambiguously ONE file name component.
 *
 * The result is joined onto the temp directory, so a separator or a `..` in
 * here would be a write outside it. `assetId` is a canonical uuid by the time
 * it reaches this function (`parseAssetRef` anchors it) — this is the second
 * lock on the same door, not the first.
 */
function safeSegment(value: string, fallback: string): string {
  const cleaned = (value ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return cleaned.slice(0, 64) || fallback;
}

/**
 * The name of the temp copy for one publish attempt.
 *
 * UNIQUE PER ATTEMPT, not per asset. The scheduled sweep and Post Now can be
 * publishing the same case at the same moment; when both used
 * `content-calendar-<assetId>.png`, the first to finish removed the file the
 * other was still about to upload, and the second attempt failed on a missing
 * file with nothing in the log to explain it.
 *
 * The extension still follows the content type: the publish script and X both
 * sniff on extension as well as bytes. The lookup normalises first, so
 * `video/mp4; charset=binary` — a real value to find on an asset row — is the
 * mp4 it says it is and not an unnamed `.bin`.
 */
export function tempFileNameFor(
  assetId: string,
  contentType: string,
  attemptId: string,
): string {
  const ext = EXTENSIONS[normalizeContentType(contentType)] ?? ".bin";
  return `content-calendar-${safeSegment(assetId, "asset")}-${safeSegment(
    attemptId,
    "attempt",
  )}${ext}`;
}

export async function resolveMediaForPublish(
  mediaFile: string | null,
  deps: MediaDeps,
): Promise<ResolvedMedia> {
  const assetId = parseAssetRef(mediaFile);
  if (!assetId) {
    return { path: mediaFile ?? null, assetId: null, cleanup: noop };
  }
  const asset = await deps.downloadAsset(assetId);
  const path = await deps.writeTempFile(
    tempFileNameFor(assetId, asset.contentType, deps.newAttemptId()),
    asset.bytes,
  );
  return {
    path,
    assetId,
    cleanup: () => deps.removeFile(path),
  };
}
