#!/usr/bin/env python3
"""Post a scheduled X post, with media. Called by the Paperclip content-calendar plugin.

Usage:
    x_publish.py '<json>'

JSON in:
    {"text": "...", "media": "/abs/path.mp4", "alt": "...", "dry": false}

JSON out (always, even on failure — the caller parses stdout):
    {"ok": true,  "id": "...", "url": "...", "media_id": "..."}
    {"ok": false, "error": "..."}

WHERE x-post.py COMES FROM

The SIBLING of this file. Both scripts are packaged into the installed plugin
artifact together, so "next to me" is the only path that is correct on every
host this is installed on — the previous `~/.hermes/scripts` default was the
layout of one particular machine, and anywhere else it was a publisher that
could not be found. PAPERCLIP_X_POST_SCRIPT still overrides it.

WHY THE LIMITS ARE PER TYPE

X's 5 MB cap is its IMAGE cap. Applying it to video rejected every clip before
a byte moved. Videos go up X's chunked path with a much larger ceiling; the
practical limit for this calendar is Paperclip's own 10 MiB attachment cap,
which has already been enforced at upload time by then.

Credentials are never read, printed, or passed here. x-post.py loads them
itself, out of a file this process never opens.
"""
import json
import os
import signal
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# The same two lists as ALLOWED_IMAGE_TYPES / ALLOWED_VIDEO_TYPES in
# src/attachments.ts, by extension. Anything not here is refused before a
# subprocess is started rather than after X rejects it.
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
VIDEO_EXTS = (".mp4", ".mov")

IMAGE_MAX_BYTES = 5 * 1024 * 1024
VIDEO_MAX_BYTES = 512 * 1024 * 1024

TEXT_LIMIT = 280
RUN_TIMEOUT_SECS = 600


def resolve_xpost(env=None):
    """The x-post.py this run will spawn."""
    env = os.environ if env is None else env
    override = (env.get("PAPERCLIP_X_POST_SCRIPT") or "").strip()
    return override or os.path.join(HERE, "x-post.py")


def limit_bytes(ext):
    """The byte ceiling for an extension, or None when it is not sendable."""
    ext = ext.lower()
    if ext in VIDEO_EXTS:
        return VIDEO_MAX_BYTES
    if ext in IMAGE_EXTS:
        return IMAGE_MAX_BYTES
    return None


def media_error(path):
    """Why this file cannot be posted, or None when it can."""
    if not os.path.exists(path):
        return f"media not found: {path}"
    ext = os.path.splitext(path)[1].lower()
    limit = limit_bytes(ext)
    if limit is None:
        return f"media type not supported for X: {ext or path}"
    size = os.path.getsize(path)
    if size <= 0:
        return f"media file is empty: {path}"
    if size > limit:
        return (f"media {size/1e6:.1f}MB exceeds X's "
                f"{limit // (1024 * 1024)}MB limit for {ext} files")
    return None


def build_command(xpost, text, media, alt):
    """The argv for one publish. A LIST, executed without a shell — the caption
    is operator- and agent-authored text and is never parsed by anything.

    OPTIONS FIRST, THEN `--`, THEN THE CAPTION. "-40% this week" is an ordinary
    post, and as a bare positional argparse read it as an option and ended the
    publish in `unrecognized arguments` instead of a tweet. Everything after the
    separator is positional whatever it starts with.
    """
    cmd = [sys.executable, xpost, "post"]
    if media:
        cmd += ["--media", media]
        if alt:
            cmd += ["--alt", alt]
    return cmd + ["--", text]


class PublisherTimeout(Exception):
    """x-post.py outlived its budget and its process group was killed."""


def start_publisher(cmd):
    """Spawn x-post.py in ITS OWN SESSION.

    A publish spawns children of its own, and a plain run-with-a-timeout only
    kills the direct child: the rest of the tree kept uploading to X with nobody
    reading it, and the pipes it inherited kept `communicate` blocked long past
    the timeout that was supposed to bound it. Its own session makes the process
    group exactly this tree, so it can be killed as one — and killing it can
    never reach the worker that spawned it.

    A list, no shell, ever.
    """
    return subprocess.Popen(cmd, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True,
                            start_new_session=True)


def kill_process_group(proc):
    """Signal the whole group and reap the child. Safe to call twice."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    try:
        proc.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()


def collect_publisher(proc, timeout=RUN_TIMEOUT_SECS):
    """Wait for a publish and return (returncode, stdout, stderr).

    On the timeout the entire group goes, and the child is reaped before the
    exception leaves — an orphaned upload is a post that may still appear with
    nothing recorded about it here.
    """
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_process_group(proc)
        raise PublisherTimeout(
            f"x-post timed out after {timeout}s") from None
    return proc.returncode, stdout, stderr


def parse_output(blob):
    """Pull the tweet id, url and media id out of x-post.py's stdout."""
    found = {"id": None, "url": None, "media_id": None}
    for line in blob.splitlines():
        if line.startswith("TWEET_ID:"):
            found["id"] = line.split(":", 1)[1].strip()
        elif line.startswith("URL:"):
            found["url"] = line.split(":", 1)[1].strip()
        elif line.startswith("MEDIA_ID:"):
            found["media_id"] = line.split(":", 1)[1].strip()
    return found


def out(obj, code=0):
    print(json.dumps(obj))
    sys.exit(code)


def main():
    if len(sys.argv) < 2:
        out({"ok": False, "error": "usage: x_publish.py '<json>'"}, 2)
    try:
        req = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        out({"ok": False, "error": f"bad json: {e}"}, 2)

    text = (req.get("text") or "").strip()
    if not text:
        out({"ok": False, "error": "text is empty"}, 2)
    if len(text) > TEXT_LIMIT:
        out({"ok": False,
             "error": f"text is {len(text)} chars, limit {TEXT_LIMIT}"}, 2)

    media = req.get("media")
    if media:
        media = os.path.expanduser(media)
        error = media_error(media)
        if error:
            out({"ok": False, "error": error}, 2)

    if req.get("dry"):
        out({"ok": True, "dry": True, "chars": len(text),
             "media": media, "alt": bool(req.get("alt"))})

    xpost = resolve_xpost()
    if not os.path.exists(xpost):
        out({"ok": False, "error": f"publisher not found: {xpost}"}, 2)

    cmd = build_command(xpost, text, media, req.get("alt"))
    # A video is uploaded in segments and then waited on while X transcodes it,
    # so this outlives the old 180s. x-post.py bounds its own polling, and the
    # plugin's spawn timeout bounds this.
    try:
        code, stdout, stderr = collect_publisher(start_publisher(cmd),
                                                 RUN_TIMEOUT_SECS)
    except PublisherTimeout as timeout:
        out({"ok": False, "error": str(timeout)}, 1)

    blob = (stdout or "") + (stderr or "")
    found = parse_output(blob)

    if code == 0 and found["id"]:
        out({"ok": True, "id": found["id"], "url": found["url"],
             "media_id": found["media_id"]})
    out({"ok": False, "error": (blob.strip() or f"exit {code}")[:500]}, 1)


if __name__ == "__main__":
    main()
