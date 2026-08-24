/**
 * Native attachment rules.
 *
 * Everything in this module is pure. It encodes what Paperclip itself accepts,
 * traced from the installed server rather than guessed:
 *
 *   - `DEFAULT_ALLOWED_TYPES` in server/dist/attachment-types.js lists the image
 *     types the instance accepts; `MAX_ATTACHMENT_BYTES` defaults to 10 MiB.
 *   - `POST /api/cases/:id/attachments` (server/dist/routes/cases.js) enforces
 *     the per-company byte cap and rejects an empty body, but it does NOT check
 *     the content type — only `/companies/:id/assets/images` does. So for case
 *     attachments the type check has to happen on our side or nowhere.
 */

/**
 * Image types accepted for a social post.
 *
 * This is the image subset of Paperclip's DEFAULT_ALLOWED_TYPES. SVG is
 * deliberately excluded: only the assets/images route sanitises SVG through
 * DOMPurify, the case attachment route does not, and no social channel we
 * publish to accepts it.
 */
export const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
] as const;

/**
 * Video types accepted for a social post.
 *
 * NARROWER THAN THE HOST ON PURPOSE. Paperclip's own attachment allowlist also
 * carries `video/webm` and `video/x-m4v`, and the case attachment route checks
 * no content type at all — so anything rejected here is rejected by us or by
 * nobody. These two are what X's chunked upload ingests without surprises:
 * webm is not a documented X input at all, and x-m4v is an Apple container that
 * X accepts inconsistently. A file that uploads fine to Paperclip and then
 * fails at X is the worst of both, because the post looks attached until the
 * moment it is due.
 */
export const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime"] as const;

/** Everything a social post may carry, images first. */
export const ALLOWED_MEDIA_TYPES = [
  ...ALLOWED_IMAGE_TYPES,
  ...ALLOWED_VIDEO_TYPES,
] as const;

/** Matches MAX_ATTACHMENT_BYTES in server/dist/attachment-types.js. */
export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** What a post's media IS — the one distinction the UI and X both care about. */
export type MediaKind = "image" | "video";

/**
 * A content type reduced to `type/subtype`, lowercased and trimmed.
 *
 * THE ONE PLACE THIS IS DONE. A `Content-Type` is a type plus optional
 * parameters — `video/mp4; charset=binary` is a real value to find on an asset
 * row, and some uploaders and proxies always send one. Every consumer used to
 * `.trim().toLowerCase()` its own copy and then match the whole string
 * exactly, so one parameter made the same file an empty month card, an
 * unpreviewable panel and a `.bin` temp file that X rejects: three symptoms,
 * one cause, three places to fix it.
 *
 * The parameter is dropped, never interpreted. Nothing downstream reads
 * charset or name, and a type is not invented for a value that has none.
 */
export function normalizeContentType(
  contentType: string | null | undefined,
): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

export interface UploadCandidate {
  name: string;
  type: string;
  size: number;
}

export type UploadValidation =
  | { ok: true; error: null }
  | { ok: false; error: string };

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Classify a content type, by EXACT match against the same allowlists the
 * upload check uses.
 *
 * Deliberately not `startsWith("video/")`. The content type reaches here from
 * an asset row, a case field and a picked file, and a prefix test would call
 * `video/webm` a video everywhere in the UI while the upload path refuses it —
 * two answers to one question. Anything not on a list is null: not an image,
 * not a video, not renderable.
 *
 * Parameters are dropped first (`normalizeContentType`), so an exact match is
 * a match on what the bytes ARE rather than on how the type happened to be
 * spelled by whatever stored them.
 */
export function mediaKindOf(
  contentType: string | null | undefined,
): MediaKind | null {
  const type = normalizeContentType(contentType);
  if ((ALLOWED_IMAGE_TYPES as readonly string[]).includes(type)) return "image";
  if ((ALLOWED_VIDEO_TYPES as readonly string[]).includes(type)) return "video";
  return null;
}

/**
 * Decide whether a locally selected file may be sent to Paperclip.
 *
 * Returns a reason rather than throwing, so the panel can show it inline.
 * `allowed` narrows the accepted set for callers that want one kind only.
 */
export function validateMediaUpload(
  file: UploadCandidate,
  opts: { maxBytes: number; allowed?: readonly string[] },
): UploadValidation {
  const allowed = opts.allowed ?? ALLOWED_MEDIA_TYPES;
  // Same normalisation as everywhere else: a browser that reports
  // `video/mp4; codecs=...` is describing a file this does accept.
  const type = normalizeContentType(file.type);
  if (!allowed.includes(type)) {
    return {
      ok: false,
      error: `${type || "unknown file type"} is not accepted. Use ${allowed.join(", ")}.`,
    };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, error: "That file is empty." };
  }
  if (file.size > opts.maxBytes) {
    return {
      ok: false,
      error: `That file is ${mib(file.size)}. This company's limit is ${mib(opts.maxBytes)}.`,
    };
  }
  return { ok: true, error: null };
}

/**
 * The image-only check.
 *
 * Kept as its own function rather than aliased onto `validateMediaUpload`:
 * an alias would silently start accepting video everywhere the old name is
 * still used, which is the opposite of what a caller asking for an image
 * check means.
 */
export function validateImageUpload(
  file: UploadCandidate,
  opts: { maxBytes: number },
): UploadValidation {
  return validateMediaUpload(file, {
    maxBytes: opts.maxBytes,
    allowed: ALLOWED_IMAGE_TYPES,
  });
}

// ---------------------------------------------------------------------------
// media_file as a native asset reference
// ---------------------------------------------------------------------------

/**
 * ANCHORED on purpose.
 *
 * `media_file` is free text: an operator or an agent can put anything in it,
 * and whatever comes back from here is interpolated into `/api/assets/<id>/content`
 * AND into a temp file name on the publish host. An unanchored test would say
 * yes to `../../etc/passwd-<uuid>` and hand the whole string back.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The one path shape the assets route serves, with the id as an EXACT segment. */
const CONTENT_PATH_RE =
  /^\/api\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/content$/i;

/**
 * The path part of a value that may be a bare path or a fully qualified URL.
 *
 * Query and fragment are dropped — they do not change which asset is meant —
 * but nothing is decoded, so an escaped separator stays a literal character
 * and simply fails the exact-segment match below.
 */
function pathOf(value: string): string | null {
  let path = value;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      path = new URL(value).pathname;
    } catch {
      return null;
    }
  }
  if (!path.startsWith("/")) return null;
  return path.split("#")[0].split("?")[0];
}

/**
 * How an attached image is written into `fields.media_file`.
 *
 * The native `assets` row is the source of truth; this string only points at
 * it. Legacy values (a bare filename or an absolute host path) are left alone —
 * `parseAssetRef` returns null for them and the publish path keeps treating
 * them as files, so nothing that already works breaks.
 */
export function assetRef(assetId: string): string {
  return `asset:${assetId}`;
}

/**
 * Read an asset id back out of a `media_file` value.
 *
 * Accepts the canonical `asset:<uuid>` form and the content path the API hands
 * back (`/api/assets/<uuid>/content`, absolute or fully qualified), because a
 * case may have been edited by hand or by an agent. Both forms are matched
 * WHOLE: the uuid must be canonical and, on the path form, an exact segment of
 * exactly that route. Anything else — a bare filename, an absolute host path,
 * a uuid with anything glued to it — is not an asset reference and returns
 * null.
 */
export function parseAssetRef(mediaFile: string | null | undefined): string | null {
  const value = (mediaFile ?? "").trim();
  if (!value) return null;

  // `asset:` carries a bare uuid and nothing else. Not a uuid with a suffix,
  // not a uuid with a path glued on, not a uuid inside a sentence.
  if (value.toLowerCase().startsWith("asset:")) {
    const id = value.slice("asset:".length);
    return UUID_RE.test(id) ? id.toLowerCase() : null;
  }

  const path = pathOf(value);
  if (!path) return null;
  const match = CONTENT_PATH_RE.exec(path);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Where the browser reads an asset's bytes.
 *
 * Same string the assets route reports as `contentPath`
 * (server/dist/routes/assets.js). Session-authenticated and same-origin, so an
 * <img src> from plugin UI just works.
 */
export function assetContentPath(assetId: string): string {
  return `/api/assets/${assetId}/content`;
}
