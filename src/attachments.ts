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

/** Matches MAX_ATTACHMENT_BYTES in server/dist/attachment-types.js. */
export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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
 * Decide whether a locally selected file may be sent to Paperclip.
 *
 * Returns a reason rather than throwing, so the panel can show it inline.
 */
export function validateImageUpload(
  file: UploadCandidate,
  opts: { maxBytes: number },
): UploadValidation {
  const type = (file.type ?? "").trim().toLowerCase();
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(type)) {
    return {
      ok: false,
      error: `${type || "unknown file type"} is not an accepted image. Use ${ALLOWED_IMAGE_TYPES.join(", ")}.`,
    };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, error: "That file is empty." };
  }
  if (file.size > opts.maxBytes) {
    return {
      ok: false,
      error: `That image is ${mib(file.size)}. This company's limit is ${mib(opts.maxBytes)}.`,
    };
  }
  return { ok: true, error: null };
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
