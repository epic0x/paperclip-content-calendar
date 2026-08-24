/**
 * The X publisher, in Node.
 *
 * `dist/x-publisher.js` is a pure Node ESM module that speaks to X directly
 * and takes every impure operation as an injected dependency: HTTP transport,
 * `readFile`/`stat`, `sleep`, nonce, clock and credentials. Nothing here opens
 * a socket, touches the real filesystem, reads an environment variable or
 * starts another process; the media state machine is exercised against fakes.
 *
 * WHY THERE IS NO HARD-CODED SIGNATURE GOLDEN
 *
 * A golden base64 blob would have to be produced by running the very algorithm
 * under test, and recomputing HMAC-SHA1 inside the test is just the
 * implementation written twice — both pass a signer that is wrong in the same
 * way. Instead the signature is pinned by the properties that actually break
 * in the field: it is deterministic given an injected nonce and timestamp, and
 * it MOVES when any one of the method, the url, any signed parameter, the
 * nonce, the timestamp or any of the four credential fields moves. That is
 * what catches the classic bug — a component quietly left out of the base
 * string — which a single golden value cannot distinguish from a typo in
 * itself.
 *
 * Behaviour kept deliberately, each one load-bearing:
 *
 *   - For the v2 JSON endpoint the signature base string contains ONLY the
 *     oauth_* parameters. The JSON body is NOT signed. Form-encoded v1.1
 *     parameters ARE.
 *   - The media path is chosen from the EXTENSION, and the declared MIME comes
 *     from the same map, so the classifier and the Content-Type cannot drift.
 *   - 5 MB is X's IMAGE cap; a video's ceiling is 512 MB up the chunked path.
 *     One cap for both rejected every clip before a byte moved.
 *   - A `filename=` value is a header built by interpolation, so a name
 *     carrying CR, LF or a quote is header injection into X's upload endpoint.
 *   - A tweet is never created unless the media is up and processed. A post
 *     that silently loses the video it was written around is worse than a post
 *     that does not go out.
 *   - Transcoding is asynchronous and X says when to look again, so STATUS
 *     polling is bounded in both count and total wait: an upload that never
 *     finishes has to become a failed publish with a reason, not a worker
 *     parked forever.
 *   - Errors are one sanitized line. Credentials never appear in them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  CHUNK_BYTES,
  percentEncode,
  oauth1Header,
  mediaKindFor,
  mediaMimeFor,
  safeFilename,
  publishToX,
} from "../dist/x-publisher.js";

// ---------------------------------------------------------------------------
// Fixtures and fakes
// ---------------------------------------------------------------------------

const MEDIA_URL = "https://upload.x.com/1.1/media/upload.json";
const METADATA_URL = "https://api.x.com/1.1/media/metadata/create.json";
const TWEETS_URL = "https://api.x.com/2/tweets";

/**
 * Deliberately distinctive, and deliberately carrying characters that RFC 3986
 * percent-encoding must handle — `/`, `+` and `=` all appear in real X
 * secrets, and all three change meaning if they reach the signing key raw.
 * Being distinctive is what lets every error assertion below prove the string
 * is absent rather than merely unlikely.
 */
const CREDENTIALS = Object.freeze({
  apiKey: "CK-consumer-key",
  apiSecret: "CS-consumer-secret/+=",
  accessToken: "AT-access-token",
  accessSecret: "AS-access-secret/+=",
});

const SECRET_VALUES = Object.values(CREDENTIALS);

/** Epoch MILLISECONDS, as `Date.now` returns. oauth_timestamp is seconds. */
const NOW_MS = 1_700_000_000_123;
const NOW_SECS = "1700000000";

function headerOf(spec, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(spec.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** Split a multipart body into its parts, binary-safe. */
function multipartParts(spec) {
  const contentType = headerOf(spec, "content-type") ?? "";
  const match = /boundary=(.+)$/.exec(contentType);
  assert.ok(match, `not a multipart request: ${contentType}`);
  const boundary = Buffer.from(`--${match[1]}`);
  const buf = Buffer.from(spec.body);

  const parts = [];
  let at = buf.indexOf(boundary);
  while (at !== -1) {
    const start = at + boundary.length;
    if (buf.subarray(start, start + 2).toString("latin1") === "--") break;
    const next = buf.indexOf(boundary, start);
    if (next === -1) break;
    // `--B\r\n<head>\r\n\r\n<bytes>\r\n--B`
    const raw = buf.subarray(start + 2, next - 2);
    const gap = raw.indexOf("\r\n\r\n");
    const head = raw.subarray(0, gap).toString("latin1");
    parts.push({
      head,
      name: /name="([^"]*)"/.exec(head)?.[1] ?? "",
      filename: /filename="([^"]*)"/.exec(head)?.[1] ?? null,
      bytes: raw.subarray(gap + 4),
    });
    at = next;
  }
  return parts;
}

function formFields(spec) {
  return Object.fromEntries(new URLSearchParams(String(spec.body)));
}

/** What this request is, in the media protocol's own vocabulary. */
function commandOf(spec) {
  if (spec.url === TWEETS_URL) return "TWEET";
  if (spec.url === METADATA_URL) return "ALT";
  if (spec.query?.command) return String(spec.query.command);
  const contentType = headerOf(spec, "content-type") ?? "";
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    return formFields(spec).command ?? "?";
  }
  if (contentType.startsWith("multipart/form-data")) {
    const parts = multipartParts(spec);
    const command = parts.find((p) => p.name === "command");
    // The image upload is a single anonymous multipart POST — no command field.
    return command ? command.bytes.toString() : "IMAGE";
  }
  return "?";
}

function recorder(handler) {
  const calls = [];
  const request = async (spec) => {
    calls.push(spec);
    const response = await handler(spec, commandOf(spec), calls.length - 1);
    assert.ok(response, `fake transport had no answer for ${commandOf(spec)}`);
    return response;
  };
  return { request, calls, commands: () => calls.map(commandOf) };
}

const ok = (payload) => ({ status: 200, body: JSON.stringify(payload) });

/**
 * Injected filesystem. `stat` answers from a size table so the size-limit
 * rules can be exercised at 512 MB without allocating 512 MB; `readFile`
 * answers only for files the test actually staged, so "did it read the file"
 * is observable rather than assumed.
 */
function fakeFiles({ bytes = {}, sizes = {} } = {}) {
  const reads = [];
  const rangeReads = [];
  return {
    reads,
    rangeReads,
    async readFile(path) {
      reads.push(path);
      const found = bytes[path];
      if (!found) throw new Error(`ENOENT: unexpected read of ${path}`);
      return found;
    },
    async readRange(path, offset, length) {
      rangeReads.push({ path, offset, length });
      const found = bytes[path];
      if (!found) throw new Error(`ENOENT: unexpected range read of ${path}`);
      return found.subarray(offset, offset + length);
    },
    async stat(path) {
      const size = sizes[path] ?? bytes[path]?.length;
      if (size === undefined) throw new Error(`ENOENT: no such file ${path}`);
      return { size };
    },
  };
}

function makeDeps({ request, files = fakeFiles(), credentials = CREDENTIALS }) {
  const slept = [];
  let nonces = 0;
  return {
    slept,
    files,
    deps: {
      credentials,
      request,
      readFile: files.readFile,
      readRange: files.readRange,
      stat: files.stat,
      async sleep(ms) {
        slept.push(ms);
      },
      nonce: () => `nonce-${nonces++}`,
      now: () => NOW_MS,
    },
  };
}

/** A transport where every media step and the tweet itself succeed. */
function happyX({ mediaId = "MEDIA-77", tweetId = "1919191919191919191" } = {}) {
  return (spec, command) => {
    switch (command) {
      case "IMAGE":
      case "INIT":
        return ok({ media_id_string: mediaId });
      case "APPEND":
        return { status: 204, body: "" };
      case "FINALIZE":
        return ok({ media_id_string: mediaId });
      case "ALT":
        return { status: 204, body: "" };
      case "TWEET":
        return { status: 201, body: JSON.stringify({ data: { id: tweetId } }) };
      default:
        return null;
    }
  };
}

const PNG = "/var/tmp/content-calendar-post.png";
const MP4 = "/var/tmp/content-calendar-clip.mp4";

/** Sparse, position-dependent bytes: reordered chunks cannot compare equal. */
function pattern(size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 997) buf[i] = (i % 251) + 1;
  return buf;
}

function assertNoCredentials(text) {
  assert.equal(typeof text, "string");
  for (const secret of SECRET_VALUES) {
    assert.ok(!text.includes(secret), `error leaked a credential: ${text}`);
  }
  assert.ok(!text.includes("OAuth "), `error leaked an auth header: ${text}`);
  assert.ok(!text.includes("oauth_signature"), `error leaked a signature: ${text}`);
}

// ---------------------------------------------------------------------------
// OAuth 1.0a signing
// ---------------------------------------------------------------------------

const SIGN_ARGS = Object.freeze({
  method: "POST",
  url: TWEETS_URL,
  credentials: CREDENTIALS,
  params: {},
  nonce: "fixed-nonce",
  timestamp: 1_700_000_000,
});

test("signing is deterministic under an injected nonce and clock", () => {
  const header = oauth1Header(SIGN_ARGS);

  assert.equal(header, oauth1Header({ ...SIGN_ARGS }));
  assert.ok(header.startsWith("OAuth "));

  const pairs = Object.fromEntries(
    header
      .slice("OAuth ".length)
      .split(", ")
      .map((pair) => {
        const [k, v] = pair.split("=");
        return [k, decodeURIComponent(v.slice(1, -1))];
      }),
  );

  assert.equal(pairs.oauth_consumer_key, CREDENTIALS.apiKey);
  assert.equal(pairs.oauth_token, CREDENTIALS.accessToken);
  assert.equal(pairs.oauth_nonce, "fixed-nonce");
  assert.equal(pairs.oauth_timestamp, "1700000000");
  assert.equal(pairs.oauth_signature_method, "HMAC-SHA1");
  assert.equal(pairs.oauth_version, "1.0");

  // HMAC-SHA1 is 20 bytes; base64 of 20 bytes is 28 chars ending in one pad.
  assert.match(pairs.oauth_signature, /^[A-Za-z0-9+/]{27}=$/);

  // Parameters appear sorted, and the signature is percent-encoded in place —
  // an unencoded `+` or `/` in the header is a 401 from X.
  const keys = Object.keys(pairs);
  assert.deepEqual(keys, [...keys].sort());
  assert.ok(!/oauth_signature="[^"]*[+/]/.test(header));

  // The secrets sign the request; they are never IN it.
  for (const secret of [CREDENTIALS.apiSecret, CREDENTIALS.accessSecret]) {
    assert.ok(!header.includes(secret));
  }
});

test("percent-encoding is RFC 3986, not encodeURIComponent", () => {
  // encodeURIComponent leaves !*'() alone; RFC 3986 reserves them and X
  // rejects the signature computed with them raw.
  assert.equal(percentEncode("a b!*'()~-_."), "a%20b%21%2A%27%28%29~-_.");
  assert.equal(percentEncode("/+="), "%2F%2B%3D");
  assert.equal(percentEncode("Hello Ladies + Add Me: @deadbeef"),
    "Hello%20Ladies%20%2B%20Add%20Me%3A%20%40deadbeef");
  assert.equal(percentEncode("café"), "caf%C3%A9");
  assert.equal(percentEncode(""), "");
});

test("every signed component reaches the base string", () => {
  const signatureOf = (over) => {
    const header = oauth1Header({ ...SIGN_ARGS, ...over });
    return /oauth_signature="([^"]*)"/.exec(header)[1];
  };
  const baseline = signatureOf({});

  const mutations = {
    method: { method: "GET" },
    url: { url: `${TWEETS_URL}/123` },
    nonce: { nonce: "other-nonce" },
    timestamp: { timestamp: 1_700_000_001 },
    "a signed parameter": { params: { command: "STATUS" } },
    "the consumer key": {
      credentials: { ...CREDENTIALS, apiKey: "CK-other" },
    },
    "the consumer secret": {
      credentials: { ...CREDENTIALS, apiSecret: "CS-other/+=" },
    },
    "the access token": {
      credentials: { ...CREDENTIALS, accessToken: "AT-other" },
    },
    "the access secret": {
      credentials: { ...CREDENTIALS, accessSecret: "AS-other/+=" },
    },
  };

  for (const [what, over] of Object.entries(mutations)) {
    assert.notEqual(signatureOf(over), baseline, `${what} did not change the signature`);
  }

  // ...and a parameter's VALUE matters as much as its presence.
  assert.notEqual(
    signatureOf({ params: { command: "STATUS", media_id: "1" } }),
    signatureOf({ params: { command: "STATUS", media_id: "2" } }),
  );
});

// ---------------------------------------------------------------------------
// Media classification
// ---------------------------------------------------------------------------

test("the media path is chosen from the extension", () => {
  for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".webp"]) {
    assert.equal(mediaKindFor(`/tmp/a${ext}`), "image", ext);
    assert.equal(mediaKindFor(`/tmp/a${ext.toUpperCase()}`), "image", ext);
  }
  for (const ext of [".mp4", ".mov"]) {
    assert.equal(mediaKindFor(`/tmp/a${ext}`), "video", ext);
    assert.equal(mediaKindFor(`/tmp/a${ext.toUpperCase()}`), "video", ext);
  }
  // Not sendable, and said so before anything is uploaded.
  for (const path of ["/tmp/a.pdf", "/tmp/a.bin", "/tmp/a", "/tmp/a.mp4.txt", ""]) {
    assert.equal(mediaKindFor(path), null, path);
  }
});

test("the declared MIME comes from the same map as the classification", () => {
  // A MAP, not a two-way guess: announcing every non-PNG as JPEG sent GIFs and
  // WebPs up as something they are not, which X sometimes sniffed past and
  // sometimes rejected — a media failure on a file that is fine.
  assert.equal(mediaMimeFor("/tmp/a.png"), "image/png");
  assert.equal(mediaMimeFor("/tmp/a.jpg"), "image/jpeg");
  assert.equal(mediaMimeFor("/tmp/a.jpeg"), "image/jpeg");
  assert.equal(mediaMimeFor("/tmp/a.gif"), "image/gif");
  assert.equal(mediaMimeFor("/tmp/a.webp"), "image/webp");
  assert.equal(mediaMimeFor("/tmp/a.MP4"), "video/mp4");
  assert.equal(mediaMimeFor("/tmp/a.mov"), "video/quicktime");
  assert.equal(mediaMimeFor("/tmp/a.pdf"), null);
});

test("a filename cannot break out of a multipart header", () => {
  assert.equal(safeFilename("/var/tmp/post-image.png"), "post-image.png");
  assert.equal(safeFilename('/tmp/ev"il.png'), "evil.png");
  assert.equal(safeFilename("/tmp/a\r\nContent-Type: x.png"), "aContent-Type: x.png");
  assert.equal(safeFilename("/tmp/back\\slash.png"), "backslash.png");
  assert.equal(safeFilename("/tmp/"), "upload");
  assert.equal(safeFilename(""), "upload");
  assert.equal(safeFilename(null), "upload");
});

// ---------------------------------------------------------------------------
// Size limits
// ---------------------------------------------------------------------------

test("5 MB is the image cap and 512 MB the video cap", () => {
  assert.equal(IMAGE_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(VIDEO_MAX_BYTES, 512 * 1024 * 1024);
  assert.equal(CHUNK_BYTES, 4 * 1024 * 1024);
  assert.ok(CHUNK_BYTES <= 5 * 1024 * 1024, "X caps one segment at 5 MB");
});

test("an oversized file is refused from its size alone, without reading it", async () => {
  for (const [path, limit] of [[PNG, IMAGE_MAX_BYTES], [MP4, VIDEO_MAX_BYTES]]) {
    const { request, calls } = recorder(happyX());
    const files = fakeFiles({ sizes: { [path]: limit + 1 } });
    const { deps } = makeDeps({ request, files });

    const result = await publishToX({ text: "over", mediaPath: path }, deps);

    assert.equal(result.ok, false, path);
    assert.match(result.error, /limit|too large/i);
    assert.deepEqual(files.reads, [], "the bytes were slurped just to reject them");
    assert.deepEqual(files.rangeReads, [], "an oversized file must not be range-read");
    assert.deepEqual(calls, [], "an oversized file must not reach the network");
    assertNoCredentials(result.error);
  }
});

test("a file exactly at the cap is still sent", async () => {
  const { request, calls } = recorder(happyX());
  const files = fakeFiles({
    bytes: { [PNG]: pattern(1024) },
    sizes: { [PNG]: IMAGE_MAX_BYTES },
  });
  const { deps } = makeDeps({ request, files });

  const result = await publishToX({ text: "at the cap", mediaPath: PNG }, deps);

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(calls.map(commandOf), ["IMAGE", "TWEET"]);
});

test("an empty file is refused rather than uploaded", async () => {
  const { request, calls } = recorder(happyX());
  const files = fakeFiles({ bytes: { [MP4]: Buffer.alloc(0) }, sizes: { [MP4]: 0 } });
  const { deps } = makeDeps({ request, files });

  const result = await publishToX({ text: "empty", mediaPath: MP4 }, deps);

  assert.equal(result.ok, false);
  assert.match(result.error, /empty/i);
  assert.deepEqual(calls, []);
});

test("an unsupported file never starts an upload", async () => {
  const { request, calls } = recorder(happyX());
  const files = fakeFiles({ bytes: { "/tmp/report.pdf": pattern(64) } });
  const { deps } = makeDeps({ request, files });

  const result = await publishToX(
    { text: "nope", mediaPath: "/tmp/report.pdf" },
    deps,
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /pdf|unsupported|not supported/i);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Image upload — one multipart POST
// ---------------------------------------------------------------------------

test("an image goes up as exactly one multipart POST, before the tweet", async () => {
  const bytes = pattern(4096);
  const { request, calls } = recorder(happyX({ mediaId: "MEDIA-IMG" }));
  const { deps } = makeDeps({ request, files: fakeFiles({ bytes: { [PNG]: bytes } }) });

  const result = await publishToX({ text: "look at this", mediaPath: PNG }, deps);

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(calls.map(commandOf), ["IMAGE", "TWEET"]);

  const [upload] = calls;
  assert.equal(upload.method, "POST");
  assert.equal(upload.url, MEDIA_URL);
  assert.match(headerOf(upload, "content-type"), /^multipart\/form-data; boundary=.+/);
  assert.match(headerOf(upload, "authorization"), /^OAuth /);

  const parts = multipartParts(upload);
  assert.equal(parts.length, 1, "an image is one part, not a chunked upload");
  assert.equal(parts[0].name, "media");
  assert.equal(parts[0].filename, "post-image.png");
  assert.match(parts[0].head, /Content-Type: image\/png/);
  assert.equal(Buffer.compare(parts[0].bytes, bytes), 0, "the file bytes changed in flight");

  // Multipart bodies are NOT signed — only the oauth_* parameters are.
  assert.equal(
    headerOf(upload, "authorization"),
    oauth1Header({
      method: "POST",
      url: MEDIA_URL,
      credentials: CREDENTIALS,
      params: {},
      nonce: "nonce-0",
      timestamp: Math.floor(NOW_MS / 1000),
    }),
  );

  assert.equal(result.mediaId, "MEDIA-IMG");
  assert.deepEqual(JSON.parse(calls[1].body), {
    text: "look at this",
    media: { media_ids: ["MEDIA-IMG"] },
  });
});

test("alt text is attached after media upload and before the tweet", async () => {
  const altText = "A".repeat(1005);
  const { request, calls } = recorder(happyX({ mediaId: "MEDIA-ALT" }));
  const { deps } = makeDeps({
    request,
    files: fakeFiles({ bytes: { [PNG]: pattern(64) } }),
  });

  const result = await publishToX(
    { text: "accessible", mediaPath: PNG, altText },
    deps,
  );

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(calls.map(commandOf), ["IMAGE", "ALT", "TWEET"]);
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].url, METADATA_URL);
  assert.equal(headerOf(calls[1], "content-type"), "application/json");
  assert.match(headerOf(calls[1], "authorization"), /^OAuth /);
  assert.deepEqual(JSON.parse(calls[1].body), {
    media_id: "MEDIA-ALT",
    alt_text: { text: "A".repeat(1000) },
  });
});

test("an alt-text metadata failure leaves no tweet behind", async () => {
  const handler = happyX({ mediaId: "MEDIA-ALT-FAIL" });
  const { request, calls } = recorder((spec, command) =>
    command === "ALT"
      ? { status: 500, body: "metadata unavailable" }
      : handler(spec, command),
  );
  const { deps } = makeDeps({
    request,
    files: fakeFiles({ bytes: { [PNG]: pattern(64) } }),
  });

  const result = await publishToX(
    { text: "accessible", mediaPath: PNG, altText: "A useful description" },
    deps,
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /alt text|metadata/i);
  assert.deepEqual(calls.map(commandOf), ["IMAGE", "ALT"]);
});

test("a hostile file name reaches X as one inert header value", async () => {
  const hostile = '/var/tmp/pwn";\r\nContent-Type: text/html\r\n\r\n.png';
  const { request, calls } = recorder(happyX());
  const { deps } = makeDeps({
    request,
    files: fakeFiles({ bytes: { [hostile]: pattern(32) } }),
  });

  const result = await publishToX({ text: "hostile name", mediaPath: hostile }, deps);

  assert.equal(result.ok, true, result.error);
  const head = multipartParts(calls[0])[0].head;
  const disposition = /Content-Disposition: form-data; name="media"; filename="([^"]*)"/
    .exec(head);
  assert.ok(disposition, `filename was not a single header value: ${head}`);
  assert.ok(!/[\r\n"\\]/.test(disposition[1]), `filename kept header syntax: ${disposition[1]}`);
  // Exactly one Content-Type line in the part header, i.e. nothing was injected.
  assert.equal(head.match(/Content-Type:/g).length, 1);
});

// ---------------------------------------------------------------------------
// Video upload — INIT, APPEND, FINALIZE, STATUS
// ---------------------------------------------------------------------------

test("a video goes up chunked, in order, with no chunk over 4 MiB", async () => {
  const total = 9 * 1024 * 1024; // 4 MiB + 4 MiB + 1 MiB
  const source = pattern(total);
  const { request, calls } = recorder(happyX({ mediaId: "MEDIA-VID" }));
  const files = fakeFiles({ bytes: { [MP4]: source } });
  const { deps, slept } = makeDeps({
    request,
    files,
  });

  const result = await publishToX({ text: "a clip", mediaPath: MP4 }, deps);

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(files.reads, [], "video must never use a whole-file read");
  assert.deepEqual(files.rangeReads, [
    { path: MP4, offset: 0, length: CHUNK_BYTES },
    { path: MP4, offset: CHUNK_BYTES, length: CHUNK_BYTES },
    { path: MP4, offset: 2 * CHUNK_BYTES, length: 1024 * 1024 },
  ]);
  assert.deepEqual(calls.map(commandOf), [
    "INIT", "APPEND", "APPEND", "APPEND", "FINALIZE", "TWEET",
  ]);

  // INIT is form-encoded, so its parameters ARE part of the signature.
  const init = calls[0];
  assert.equal(init.method, "POST");
  assert.equal(init.url, MEDIA_URL);
  assert.match(headerOf(init, "content-type"), /^application\/x-www-form-urlencoded/);
  const initFields = formFields(init);
  assert.deepEqual(initFields, {
    command: "INIT",
    total_bytes: String(total),
    media_type: "video/mp4",
    media_category: "tweet_video",
  });
  assert.equal(
    headerOf(init, "authorization"),
    oauth1Header({
      method: "POST",
      url: MEDIA_URL,
      credentials: CREDENTIALS,
      params: initFields,
      nonce: "nonce-0",
      timestamp: Math.floor(NOW_MS / 1000),
    }),
  );

  const appends = calls.filter((c) => commandOf(c) === "APPEND");
  const rebuilt = [];
  appends.forEach((call, index) => {
    const parts = Object.fromEntries(multipartParts(call).map((p) => [p.name, p]));
    assert.equal(parts.command.bytes.toString(), "APPEND");
    assert.equal(parts.media_id.bytes.toString(), "MEDIA-VID");
    assert.equal(parts.segment_index.bytes.toString(), String(index),
      "segments must be numbered 0..n-1 in the order they are sent");
    assert.ok(parts.media.bytes.length <= CHUNK_BYTES,
      `segment ${index} is ${parts.media.bytes.length} bytes`);
    assert.ok(parts.media.bytes.length > 0);
    rebuilt.push(parts.media.bytes);
  });
  assert.equal(Buffer.compare(Buffer.concat(rebuilt), source), 0,
    "the segments do not reassemble into the file");

  assert.deepEqual(formFields(calls[4]), { command: "FINALIZE", media_id: "MEDIA-VID" });

  // No processing_info in FINALIZE means X finished inline: nothing to poll,
  // nothing to wait for. Treating its absence as "not ready" fails a video
  // that is already usable.
  assert.deepEqual(slept, []);
  assert.deepEqual(JSON.parse(calls[5].body), {
    text: "a clip",
    media: { media_ids: ["MEDIA-VID"] },
  });
});

test("a short video range read aborts before APPEND", async () => {
  const source = pattern(1024);
  const files = fakeFiles({ bytes: { [MP4]: source } });
  files.readRange = async (path, offset, length) => {
    files.rangeReads.push({ path, offset, length });
    return source.subarray(offset, offset + length - 1);
  };
  const { request, calls } = recorder(happyX({ mediaId: "MEDIA-SHORT" }));
  const { deps } = makeDeps({ request, files });

  const result = await publishToX({ text: "short", mediaPath: MP4 }, deps);

  assert.equal(result.ok, false);
  assert.match(result.error, /expected 1024 bytes, got 1023/);
  assert.deepEqual(calls.map(commandOf), ["INIT"]);
});

test("STATUS is polled until X says succeeded, at intervals X asks for", async () => {
  let statuses = 0;
  const { request, calls } = recorder((spec, command) => {
    if (command === "FINALIZE") {
      return ok({
        media_id_string: "MEDIA-VID",
        processing_info: { state: "pending", check_after_secs: 2 },
      });
    }
    if (command === "STATUS") {
      statuses += 1;
      return statuses === 1
        ? ok({ processing_info: { state: "in_progress", check_after_secs: 999 } })
        : ok({ processing_info: { state: "succeeded" } });
    }
    return happyX({ mediaId: "MEDIA-VID" })(spec, command);
  });
  const { deps, slept } = makeDeps({
    request,
    files: fakeFiles({ bytes: { [MP4]: pattern(2048) } }),
  });

  const result = await publishToX({ text: "transcoded", mediaPath: MP4 }, deps);

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(calls.map(commandOf), [
    "INIT", "APPEND", "FINALIZE", "STATUS", "STATUS", "TWEET",
  ]);

  // check_after_secs comes off the wire: 2 s is honoured in milliseconds, and
  // an absurd 999 s is clamped so a stalled transcode cannot park the worker.
  assert.deepEqual(slept, [2000, 30_000]);

  const status = calls[3];
  assert.equal(status.method, "GET");
  assert.equal(status.url, MEDIA_URL);
  assert.deepEqual(status.query, { command: "STATUS", media_id: "MEDIA-VID" });
  assert.equal(
    headerOf(status, "authorization"),
    oauth1Header({
      method: "GET",
      url: MEDIA_URL,
      credentials: CREDENTIALS,
      params: { command: "STATUS", media_id: "MEDIA-VID" },
      nonce: "nonce-3",
      timestamp: Math.floor(NOW_MS / 1000),
    }),
    "a query-string request signs its query parameters",
  );
});

test("a transcode that never finishes fails the publish instead of hanging", async () => {
  const { request, calls } = recorder((spec, command) => {
    if (command === "FINALIZE" || command === "STATUS") {
      return ok({
        media_id_string: "MEDIA-VID",
        processing_info: { state: "in_progress", check_after_secs: 5 },
      });
    }
    return happyX({ mediaId: "MEDIA-VID" })(spec, command);
  });
  const { deps, slept } = makeDeps({
    request,
    files: fakeFiles({ bytes: { [MP4]: pattern(2048) } }),
  });

  const result = await publishToX({ text: "stuck", mediaPath: MP4 }, deps);

  assert.equal(result.ok, false);
  assert.match(result.error, /still processing/i);
  assert.match(result.error, /not created/i);
  assertNoCredentials(result.error);

  const polls = calls.filter((c) => commandOf(c) === "STATUS").length;
  assert.ok(polls >= 1 && polls <= 40, `unbounded STATUS polling: ${polls}`);
  const waited = slept.reduce((a, b) => a + b, 0);
  assert.ok(waited <= 300_000, `waited ${waited} ms on a stuck transcode`);
  assert.ok(!calls.some((c) => c.url === TWEETS_URL));
});

// ---------------------------------------------------------------------------
// No tweet before the media is up
// ---------------------------------------------------------------------------

const MEDIA_FAILURES = [
  [
    "an HTTP error",
    () => ({ status: 413, body: JSON.stringify({ errors: [{ message: "x".repeat(5000) }] }) }),
    /413/,
  ],
  [
    "an unreadable body",
    () => ({ status: 200, body: "<html><body>502 Bad Gateway</body></html>" }),
    /unreadable/i,
  ],
  [
    "a response with no media id",
    () => ({ status: 200, body: JSON.stringify({ media_key: "no-id-here" }) }),
    /media_id/i,
  ],
];

for (const [what, respond, expected] of MEDIA_FAILURES) {
  test(`${what} from the media upload leaves no tweet behind`, async () => {
    const { request, calls } = recorder((spec, command) =>
      command === "IMAGE" ? respond() : happyX()(spec, command),
    );
    const { deps } = makeDeps({
      request,
      files: fakeFiles({ bytes: { [PNG]: pattern(512) } }),
    });

    const result = await publishToX({ text: "must not post", mediaPath: PNG }, deps);

    assert.equal(result.ok, false);
    assert.equal(result.url ?? null, null);
    assert.match(result.error, expected);
    assert.ok(result.error.length <= 500, `error is ${result.error.length} chars`);
    assertNoCredentials(result.error);
    assert.ok(!calls.some((c) => c.url === TWEETS_URL),
      "a text-only post went out in place of the image");
  });
}

test("a video X failed to process leaves no tweet behind", async () => {
  const { request, calls } = recorder((spec, command) => {
    if (command === "FINALIZE") {
      return ok({
        media_id_string: "MEDIA-VID",
        processing_info: {
          state: "failed",
          error: { name: "InvalidMedia", message: "unsupported video codec" },
        },
      });
    }
    return happyX({ mediaId: "MEDIA-VID" })(spec, command);
  });
  const { deps } = makeDeps({
    request,
    files: fakeFiles({ bytes: { [MP4]: pattern(2048) } }),
  });

  const result = await publishToX({ text: "must not post", mediaPath: MP4 }, deps);

  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported video codec/);
  assertNoCredentials(result.error);
  assert.ok(!calls.some((c) => c.url === TWEETS_URL));
});

test("a failed APPEND stops the upload where it is", async () => {
  const { request, calls } = recorder((spec, command) =>
    command === "APPEND"
      ? { status: 500, body: "upstream connect error" }
      : happyX()(spec, command),
  );
  const { deps } = makeDeps({
    request,
    files: fakeFiles({ bytes: { [MP4]: pattern(2048) } }),
  });

  const result = await publishToX({ text: "must not post", mediaPath: MP4 }, deps);

  assert.equal(result.ok, false);
  assert.match(result.error, /500/);
  assert.deepEqual(calls.map(commandOf), ["INIT", "APPEND"]);
  assertNoCredentials(result.error);
});

// ---------------------------------------------------------------------------
// The tweet itself
// ---------------------------------------------------------------------------

test("a text post is one JSON POST to the v2 endpoint", async () => {
  const { request, calls } = recorder(happyX({ tweetId: "1234567890123456789" }));
  const { deps } = makeDeps({ request });

  const result = await publishToX({ text: "hello world", mediaPath: null }, deps);

  assert.deepEqual(result, {
    ok: true,
    id: "1234567890123456789",
    url: "https://x.com/i/web/status/1234567890123456789",
    mediaId: null,
    error: null,
  });

  assert.equal(calls.length, 1, "a text post touches no media endpoint");
  const [tweet] = calls;
  assert.equal(tweet.method, "POST");
  assert.equal(tweet.url, TWEETS_URL);
  assert.match(headerOf(tweet, "content-type"), /^application\/json/);
  assert.deepEqual(JSON.parse(tweet.body), { text: "hello world" });

  // THE JSON BODY IS NOT SIGNED. Including it produces a signature that is
  // internally consistent and that X answers with 401.
  assert.equal(
    headerOf(tweet, "authorization"),
    oauth1Header({
      method: "POST",
      url: TWEETS_URL,
      credentials: CREDENTIALS,
      params: {},
      nonce: "nonce-0",
      timestamp: Number(NOW_SECS),
    }),
  );
});

test("the returned url is the handle-free permalink", async () => {
  const { request } = recorder(happyX({ tweetId: "42" }));
  const { deps } = makeDeps({ request });

  const result = await publishToX({ text: "hi", mediaPath: null }, deps);

  // /i/web/status/ works for any account, so the published url does not encode
  // whose account this plugin happens to be installed against.
  assert.equal(result.url, "https://x.com/i/web/status/42");
});

const TWEET_FAILURES = [
  ["an HTTP error", { status: 403, body: JSON.stringify({ detail: "duplicate content" }) }, /403/],
  ["an unreadable body", { status: 200, body: "not json at all" }, /unreadable/i],
  ["a response with no id", { status: 201, body: JSON.stringify({ data: {} }) }, /id/i],
];

for (const [what, response, expected] of TWEET_FAILURES) {
  test(`${what} from the tweet endpoint is one sanitized line`, async () => {
    const { request } = recorder((spec, command) =>
      command === "TWEET" ? response : happyX()(spec, command),
    );
    const { deps } = makeDeps({ request });

    const result = await publishToX({ text: "hello", mediaPath: null }, deps);

    assert.equal(result.ok, false);
    assert.equal(result.url ?? null, null);
    assert.match(result.error, expected);
    assert.ok(!result.error.includes("\n"), "an error is one line");
    assertNoCredentials(result.error);
  });
}

test("a transport that throws is a failed publish, not an unhandled rejection", async () => {
  const { deps } = makeDeps({
    request: async () => {
      throw new Error("getaddrinfo ENOTFOUND api.x.com");
    },
  });

  const result = await publishToX({ text: "offline", mediaPath: null }, deps);

  assert.equal(result.ok, false);
  assert.match(result.error, /ENOTFOUND/);
  assertNoCredentials(result.error);
});

// ---------------------------------------------------------------------------
// The source contract this module exists to satisfy
// ---------------------------------------------------------------------------

test("the X channel no longer shells out to a python publisher", () => {
  const path = fileURLToPath(new URL("../src/channels.ts", import.meta.url));
  const source = readFileSync(path, "utf8");

  const banned = [
    ["a spawned subprocess", /\bspawn\b/],
    ["node:child_process", /child_process/],
    ["a python runtime", /python/i],
    ["the publisher script override", /X_PUBLISH_SCRIPT/],
    ["the script path resolver", /resolveXPublishScript/],
    ["a developer's home directory", /\/(home|Users)\//],
    ["an operator's initials", /\bJC\b/],
    ["the deployment's account handle", /untracenetwork/i],
    ["a personal profile", /personal profile/i],
  ];

  for (const [what, pattern] of banned) {
    assert.ok(!pattern.test(source), `src/channels.ts still references ${what}`);
  }

  // ...because it publishes through this module instead.
  assert.match(source, /x-publisher/);
});
