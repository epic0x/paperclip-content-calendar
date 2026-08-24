#!/usr/bin/env python3
"""X (Twitter) write client for @untracenetwork — OAuth1, stdlib only.

Subcommands:
    post    "<text>"     -> creates a tweet, prints id + url
    delete  <id>         -> deletes a tweet, prints the API's deleted flag
    get     <id>         -> reads a tweet back (proves it exists / is gone)

OAuth1 note: for JSON-body requests the signature base string contains only the
oauth_* parameters — the JSON body is NOT included. Form-encoding the body here
would produce a valid signature but the v2 endpoint requires JSON, so the body
is sent as JSON and left out of the signature.

MEDIA: an image goes up as ONE multipart POST. A video cannot — X requires the
chunked protocol (INIT, APPEND per segment, FINALIZE) and then asynchronous
transcoding, which is only observable by polling STATUS until it says succeeded
or failed. A tweet created before that finishes attaches nothing. The two paths
are separate functions on purpose: the image one is proven end to end and is
not touched by video support existing.

Every request goes through an injected `http` callable so the whole media state
machine is unit-testable without a socket. See test/x_post_test.py.

Never posts unless `post` is passed explicitly. No implicit writes on import.
"""
import argparse, base64, hashlib, hmac, json, os, secrets, sys, time, urllib.parse, urllib.request

ENVP = os.path.expanduser("~/.hermes/credentials/x-oauth1.env")


def load_env(path=ENVP):
    e = {}
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        e[k.strip().replace("export ", "")] = v.strip().strip('"').strip("'")
    return e


def enc(s):
    return urllib.parse.quote(str(s), safe="~")


def auth_header(method, url, e, extra_params=None):
    oauth = {
        "oauth_consumer_key": e["X_API_KEY"],
        "oauth_nonce": secrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_token": e["X_ACCESS_TOKEN"],
        "oauth_version": "1.0",
    }
    allp = {**(extra_params or {}), **oauth}
    norm = "&".join(f"{enc(k)}={enc(allp[k])}" for k in sorted(allp))
    base = "&".join([method.upper(), enc(url), enc(norm)])
    key = f"{enc(e['X_API_SECRET'])}&{enc(e['X_ACCESS_SECRET'])}".encode()
    oauth["oauth_signature"] = base64.b64encode(
        hmac.new(key, base.encode(), hashlib.sha1).digest()).decode()
    return "OAuth " + ", ".join(f'{enc(k)}="{enc(v)}"' for k, v in sorted(oauth.items()))


def call(method, url, e, body=None, params=None):
    hdr = auth_header(method, url, e, params)
    full = url + ("?" + urllib.parse.urlencode(params) if params else "")
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": hdr}
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(full, data=data, headers=headers, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=30)
        return r.status, r.read().decode()
    except urllib.error.HTTPError as ex:
        return ex.code, ex.read().decode()


# ---------------------------------------------------------------------------
# Media
# ---------------------------------------------------------------------------

MEDIA_URL = "https://upload.x.com/1.1/media/upload.json"

IMAGE_MAX_BYTES = 5 * 1024 * 1024
VIDEO_MAX_BYTES = 512 * 1024 * 1024
# X caps a segment at 5 MB. 4 MiB leaves room and keeps the arithmetic obvious.
CHUNK_BYTES = 4 * 1024 * 1024

# Transcoding is asynchronous and X tells us when to look again. These bound
# what it can ask for: an upload that never finishes has to become a failed
# publish with a reason, not a worker parked until something else kills it.
MAX_STATUS_POLLS = 40
MAX_PROCESSING_WAIT = 300
MAX_POLL_INTERVAL = 30
DEFAULT_POLL_INTERVAL = 5

# The extension is what decides the path, so it decides the declared type too.
# Kept to the two the calendar will upload — see ALLOWED_VIDEO_TYPES in
# src/attachments.ts, which is the same list on the other side.
VIDEO_TYPES = {".mp4": "video/mp4", ".mov": "video/quicktime"}
# A MAP, not a two-way guess: declaring everything-that-is-not-a-PNG as JPEG
# sent GIFs and WebPs up announced as something they are not, which X sometimes
# sniffed past and sometimes rejected — a media failure on a file that is fine,
# at the moment a post is due.
IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}
# One source: the classifier and the declared type cannot drift apart.
IMAGE_EXTS = tuple(IMAGE_TYPES)


class MediaUploadError(Exception):
    """Media did not go up. The caller must not create the tweet."""


def media_kind(path):
    """image, video, or None — from the extension, never from the bytes."""
    ext = os.path.splitext(path)[1].lower()
    if ext in VIDEO_TYPES:
        return "video"
    if ext in IMAGE_EXTS:
        return "image"
    return None


def image_mime(path):
    """The Content-Type to declare for an image, from its extension."""
    ext = os.path.splitext(path)[1].lower()
    mime = IMAGE_TYPES.get(ext)
    if not mime:
        raise MediaUploadError(
            f"not an image this publisher sends: {ext or os.path.basename(path)}")
    return mime


def safe_filename(name):
    """A file name that cannot break out of a multipart header.

    `filename="<name>"` is a HEADER value built by interpolation, so a name
    carrying CR, LF or a double quote ends the header early and everything
    after it is read as more headers or another part — header injection into
    X's upload endpoint, out of a name an operator types in an upload dialog.
    A path is one name by the time it is a `filename=` value, so it is reduced
    to its basename first.
    """
    name = os.path.basename(name or "")
    for bad in ('"', "\\", "\r", "\n"):
        name = name.replace(bad, "")
    return name or "upload"


def http_call(method, url, headers=None, data=None, params=None, timeout=120):
    """The real transport. Returns (status, body_text) and never raises for a
    non-2xx, so every caller handles failure the same way."""
    full = url + ("?" + urllib.parse.urlencode(params) if params else "")
    body = data
    if isinstance(body, dict):
        body = urllib.parse.urlencode(body).encode()
    req = urllib.request.Request(
        full, data=body, headers=headers or {}, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, r.read().decode()
    except urllib.error.HTTPError as ex:
        return ex.code, ex.read().decode()


def _multipart(fields, media=None):
    """A multipart body plus its boundary.

    Field values are written without a Content-Type line, the file part with
    one — the same shape X's own examples use.
    """
    boundary = "----untrace" + secrets.token_hex(12)
    body = b""
    for name, value in fields.items():
        body += (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{value}\r\n"
        ).encode()
    if media is not None:
        body += (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="media"; filename="chunk"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode() + media + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return body, boundary


def _json_or_fail(status, body, what):
    if status // 100 != 2:
        raise MediaUploadError(f"{what} failed HTTP {status}: {body[:300]}")
    if not body.strip():
        return {}
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        raise MediaUploadError(f"{what} returned unreadable body: {body[:200]}")


def upload_media(path, e, http=http_call):
    """Upload an IMAGE to X and return its media_id_string.

    Uses the v1.1 media/upload endpoint — v2 has no media upload. The request
    is multipart/form-data, and for multipart the OAuth1 signature base string
    contains ONLY the oauth_* params, never the file bytes (same rule as the
    JSON case above).

    UNCHANGED on the wire by video support: one POST, one body, same signature.
    """
    with open(path, "rb") as handle:
        raw = handle.read()
    if len(raw) > IMAGE_MAX_BYTES:
        raise MediaUploadError(
            f"image too large for X: {len(raw)/1e6:.1f} MB (limit 5 MB)")

    boundary = "----untrace" + secrets.token_hex(12)
    mime = image_mime(path)
    # A name that had header syntax in it is not sent in a mangled form: X
    # ignores this field, so a file whose name was carrying CR, LF or a quote
    # travels under a plain generated one instead of the leftovers of it.
    name = safe_filename(path)
    if name != os.path.basename(path):
        name = "upload" + os.path.splitext(path)[1].lower()
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="media"; filename="{name}"\r\n'
        f"Content-Type: {mime}\r\n\r\n"
    ).encode() + raw + f"\r\n--{boundary}--\r\n".encode()

    status, text = http(
        "POST", MEDIA_URL, data=body, timeout=120,
        headers={"Authorization": auth_header("POST", MEDIA_URL, e),
                 "Content-Type": f"multipart/form-data; boundary={boundary}"})
    payload = _json_or_fail(status, text, "media upload")
    media_id = payload.get("media_id_string")
    if not media_id:
        raise MediaUploadError(f"media upload returned no media_id: {text[:200]}")
    return media_id


def upload_video(path, e, http=http_call, sleep=time.sleep,
                 chunk_bytes=CHUNK_BYTES, max_polls=MAX_STATUS_POLLS,
                 max_wait=MAX_PROCESSING_WAIT):
    """Upload a VIDEO to X with the v1.1 chunked protocol.

    INIT declares the size and category, APPEND ships the bytes in ordered
    segments, FINALIZE closes the upload, and STATUS is polled until X has
    finished transcoding. Returns the media_id_string only once X reports
    `succeeded` — anything else raises, because a tweet built on a media_id
    that never finished processing posts with no video attached.
    """
    ext = os.path.splitext(path)[1].lower()
    media_type = VIDEO_TYPES.get(ext)
    if not media_type:
        raise MediaUploadError(f"not a video this publisher uploads: {path}")

    total = os.path.getsize(path)
    if total <= 0:
        raise MediaUploadError(f"video file is empty: {path}")
    if total > VIDEO_MAX_BYTES:
        raise MediaUploadError(
            f"video too large for X: {total/1e6:.1f} MB (limit 512 MB)")

    # --- INIT ---------------------------------------------------------------
    # Form-encoded, so unlike the multipart and JSON cases these parameters ARE
    # part of the OAuth signature base string.
    init = {
        "command": "INIT",
        "total_bytes": str(total),
        "media_type": media_type,
        "media_category": "tweet_video",
    }
    status, text = http(
        "POST", MEDIA_URL, data=init, timeout=60,
        headers={"Authorization": auth_header("POST", MEDIA_URL, e, init),
                 "Content-Type": "application/x-www-form-urlencoded"})
    media_id = _json_or_fail(status, text, "media INIT").get("media_id_string")
    if not media_id:
        raise MediaUploadError(f"media INIT returned no media_id: {text[:200]}")

    # --- APPEND -------------------------------------------------------------
    # Streamed, not slurped: the publish host is a 2 GB droplet and the file is
    # already a temp copy of the asset.
    with open(path, "rb") as handle:
        index = 0
        while True:
            chunk = handle.read(chunk_bytes)
            if not chunk:
                break
            body, boundary = _multipart(
                {"command": "APPEND", "media_id": media_id,
                 "segment_index": str(index)},
                media=chunk)
            status, text = http(
                "POST", MEDIA_URL, data=body, timeout=180,
                headers={
                    "Authorization": auth_header("POST", MEDIA_URL, e),
                    "Content-Type":
                        f"multipart/form-data; boundary={boundary}"})
            if status // 100 != 2:
                raise MediaUploadError(
                    f"media APPEND segment {index} failed HTTP {status}: "
                    f"{text[:200]}")
            index += 1

    # --- FINALIZE -----------------------------------------------------------
    final = {"command": "FINALIZE", "media_id": media_id}
    status, text = http(
        "POST", MEDIA_URL, data=final, timeout=60,
        headers={"Authorization": auth_header("POST", MEDIA_URL, e, final),
                 "Content-Type": "application/x-www-form-urlencoded"})
    info = _json_or_fail(status, text, "media FINALIZE").get("processing_info")

    return _await_processing(media_id, info, e, http, sleep, max_polls, max_wait)


def _poll_delay(info, waited, max_wait):
    """How long to wait before the next STATUS check.

    `check_after_secs` comes off the wire, so it is clamped: a missing value
    must not become a busy loop and an absurd one must not become an absurd
    sleep. The remaining budget is the hard ceiling.
    """
    asked = info.get("check_after_secs")
    try:
        delay = float(asked)
    except (TypeError, ValueError):
        delay = DEFAULT_POLL_INTERVAL
    if delay <= 0:
        delay = DEFAULT_POLL_INTERVAL
    return min(delay, MAX_POLL_INTERVAL, max(max_wait - waited, 0))


def _await_processing(media_id, info, e, http, sleep, max_polls, max_wait):
    """Poll STATUS until X says the video is usable, or give up with a reason.

    NO processing_info AT ALL MEANS DONE. X only returns that block when there
    is asynchronous work to wait for; for an upload it finished inline it
    simply answers with the media object. Treating its absence as "not ready"
    fails a video that is already usable, which is the same broken post as a
    transcode that really did fail — with no way to tell the two apart.
    """
    if not info:
        return media_id

    waited = 0.0
    polls = 0
    while info:
        state = str(info.get("state") or "").lower()
        if state == "succeeded":
            return media_id
        if state == "failed":
            err = info.get("error") or {}
            reason = err.get("message") or err.get("name") or json.dumps(info)[:200]
            raise MediaUploadError(f"X failed to process the video: {reason}")
        if state not in ("pending", "in_progress"):
            raise MediaUploadError(
                f"unexpected media processing state {state!r}")
        if polls >= max_polls or waited >= max_wait:
            break

        delay = _poll_delay(info, waited, max_wait)
        if delay <= 0:
            break
        sleep(delay)
        waited += delay
        polls += 1

        query = {"command": "STATUS", "media_id": media_id}
        status, text = http(
            "GET", MEDIA_URL, params=query, timeout=30,
            headers={"Authorization":
                     auth_header("GET", MEDIA_URL, e, query)})
        payload = _json_or_fail(status, text, "media STATUS")
        # A STATUS response with no processing_info is X saying it is done.
        info = payload.get("processing_info") or {"state": "succeeded"}

    raise MediaUploadError(
        f"X is still processing the video after {waited:.0f}s and "
        f"{polls} checks; the post was not created")


def upload_any(path, e, http=http_call, sleep=time.sleep):
    """Send whatever this file is up the path that fits it."""
    kind = media_kind(path)
    if kind == "video":
        return upload_video(path, e, http=http, sleep=sleep)
    if kind == "image":
        return upload_media(path, e, http=http)
    raise MediaUploadError(
        f"unsupported media type for X: {os.path.basename(path)}")


def add_alt_text(media_id, alt, e):
    """Alt text is an accessibility requirement, not a nicety."""
    url = "https://api.x.com/1.1/media/metadata/create.json"
    data = json.dumps({"media_id": media_id,
                       "alt_text": {"text": alt[:1000]}}).encode()
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Authorization": auth_header("POST", url, e),
                 "Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=30)
        return True
    except urllib.error.HTTPError:
        return False


def build_parser():
    """The argv this script accepts.

    `post [options] -- <caption>`: a caption may legitimately begin with a
    hyphen ("-40% this week" is an ordinary post) and as a bare positional
    argparse reads it as an option, so the publish died with `unrecognized
    arguments` and never reached X. The caller puts the options in front of the
    separator and the text behind it; this is the side that honours that.
    """
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("post")
    p.add_argument("--media", help="path to an image (PNG/JPEG/WebP/GIF) or a video (MP4/MOV)")
    p.add_argument("--alt", default="", help="alt text for the media")
    p.add_argument("text", help="the caption; pass it after -- so a leading hyphen is text")
    d = sub.add_parser("delete"); d.add_argument("id")
    g = sub.add_parser("get");    g.add_argument("id")
    return ap


def main():
    a = build_parser().parse_args()
    e = load_env()

    if a.cmd == "post":
        if len(a.text) > 280:
            sys.exit(f"too long: {len(a.text)} chars")
        payload = {"text": a.text}
        if getattr(a, "media", None):
            # A media failure ENDS the run. Posting the text without the video
            # it was written around is worse than not posting at all, and the
            # caller reads a non-zero exit plus this line as the reason.
            try:
                mid = upload_any(a.media, e)
            except MediaUploadError as ex:
                sys.exit(str(ex))
            print("MEDIA_ID:", mid)
            if a.alt:
                print("ALT:", "ok" if add_alt_text(mid, a.alt, e) else "FAILED")
            payload["media"] = {"media_ids": [mid]}
        st, body = call("POST", "https://api.x.com/2/tweets", e, body=payload)
        print("HTTP", st)
        print(body[:600])
        if st in (200, 201):
            tid = json.loads(body)["data"]["id"]
            print("TWEET_ID:", tid)
            print("URL: https://x.com/untracenetwork/status/" + tid)

    elif a.cmd == "delete":
        st, body = call("DELETE", f"https://api.x.com/2/tweets/{a.id}", e)
        print("HTTP", st)
        print(body[:400])

    elif a.cmd == "get":
        st, body = call("GET", f"https://api.x.com/2/tweets/{a.id}", e,
                        params={"tweet.fields": "created_at,public_metrics"})
        print("HTTP", st)
        print(body[:600])


if __name__ == "__main__":
    main()
