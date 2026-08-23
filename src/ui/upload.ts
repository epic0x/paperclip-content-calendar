/**
 * Uploading an image from the calendar panel.
 *
 * WHY THE BROWSER DOES THIS AND NOT THE WORKER
 *
 * Plugin UI is loaded as an ES module into the host document from
 * `/_plugins/:pluginId/ui/*` (server/dist/routes/plugin-ui-static.js), so it is
 * same-origin and carries the operator's session cookie. That is exactly how
 * Paperclip's own UI uploads files:
 *
 *   const fd = new FormData(); fd.append("file", file);
 *   fetch(`/api${path}`, { method: "POST", body: fd, credentials: "include" })
 *
 * with no Content-Type header, so the browser can set the multipart boundary
 * (server/ui-dist/assets/index-CfgXTNC9.js — `dj`, `postForm`, `uploadAttachment`).
 *
 * The alternative, sending bytes through the plugin bridge to the worker, is
 * not viable: the bridge is JSON over `POST /api/plugins/:id/bridge/action`
 * with a 10 MB body limit (server/dist/http/body-limits.js), and base64 of a
 * 10 MB image is ~13.3 MB. It would also re-encode the file for no benefit.
 *
 * So: the browser moves the bytes over the native endpoint, and the worker —
 * which holds the board API key — writes the case fields. Neither half can
 * silently succeed without the other, because `set-media` is only called after
 * this resolves.
 */

import {
  assetContentPath,
  validateImageUpload,
  type UploadCandidate,
} from "../attachments.js";

export interface UploadedImage {
  /** case_attachments row id. */
  attachmentId: string;
  /** assets row id — what `media_file` will point at. */
  assetId: string;
  contentPath: string;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
}

export interface UploadInput {
  /** Case id or identifier; the route accepts either. */
  caseId: string;
  file: File;
  /** Effective company limit, read from the worker's detail handler. */
  maxBytes: number;
  /** Injectable for tests. Defaults to the page's fetch. */
  fetchImpl?: typeof fetch;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/** Pull the most useful message out of whatever the API returned. */
async function failureMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return body.error;
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return text.trim().slice(0, 300) || `Upload failed with HTTP ${res.status}`;
}

/**
 * Attach an image to a social_post case.
 *
 * Creates the asset AND the case_attachments link in one native call. Nothing
 * about the case changes here, so a failure leaves the previous image attached.
 */
export async function uploadCaseImage(input: UploadInput): Promise<UploadedImage> {
  const candidate: UploadCandidate = {
    name: input.file.name,
    type: input.file.type,
    size: input.file.size,
  };
  const check = validateImageUpload(candidate, { maxBytes: input.maxBytes });
  if (!check.ok) throw new UploadError(check.error, null);

  const form = new FormData();
  form.append("file", input.file);

  const doFetch = input.fetchImpl ?? fetch;
  const res = await doFetch(
    `/api/cases/${encodeURIComponent(input.caseId)}/attachments`,
    {
      method: "POST",
      body: form,
      credentials: "include",
    },
  );

  if (!res.ok) {
    throw new UploadError(await failureMessage(res), res.status);
  }

  const body = (await res.json()) as {
    id?: string;
    assetId?: string;
    asset?: {
      id?: string;
      contentType?: string;
      byteSize?: number;
      originalFilename?: string | null;
    };
  };

  const assetId = body.asset?.id ?? body.assetId;
  if (!assetId) {
    throw new UploadError(
      "Paperclip accepted the upload but returned no asset id, so the image was not attached to the case.",
      res.status,
    );
  }

  return {
    attachmentId: body.id ?? assetId,
    assetId,
    contentPath: assetContentPath(assetId),
    contentType: body.asset?.contentType ?? input.file.type,
    byteSize: body.asset?.byteSize ?? input.file.size,
    originalFilename: body.asset?.originalFilename ?? input.file.name ?? null,
  };
}
