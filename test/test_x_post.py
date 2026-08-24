"""X media upload — the chunked video path, with no network anywhere.

WHY THIS IS A UNIT TEST AND NOT A LIVE ONE

`scripts/x-post.py` is the one part of this system that is proven end to end
against the real API, and the image upload in it must not move. Video cannot go
up the same way: X's v1.1 `media/upload.json` takes an image as a single
multipart POST, but a video has to be INIT'd, APPENDed in segments, FINALIZEd,
and then POLLED until X finishes transcoding it. That is four request shapes and
a state machine, and every one of them is a place to be wrong.

So the transport is injected. `http` and `sleep` are parameters, the fakes below
record what would have been sent, and the file bytes come from a tempfile. No
socket is opened by this file, and no credential is read: the `e` dict is
fictional and only has to be shaped like the real one.
"""
import json
import os
import sys
import tempfile
import unittest
from importlib import util as importlib_util

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(name, filename):
    """Import a script by path — `x-post.py` is not a legal module name."""
    spec = importlib_util.spec_from_file_location(
        name, os.path.join(REPO, "scripts", filename))
    module = importlib_util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


xpost = load("xpost", "x-post.py")

# Shaped like the real credential set, valued like nothing at all.
FAKE_ENV = {
    "X_API_KEY": "key",
    "X_API_SECRET": "secret",
    "X_ACCESS_TOKEN": "token",
    "X_ACCESS_SECRET": "token-secret",
}

UPLOAD_URL = "https://upload.x.com/1.1/media/upload.json"


class FakeHttp:
    """Records every request and replays a scripted list of responses."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers=None, data=None, params=None,
                 timeout=None):
        self.calls.append({
            "method": method,
            "url": url,
            "headers": headers or {},
            "data": data,
            "params": params or {},
        })
        if not self.responses:
            raise AssertionError(f"unexpected extra request: {method} {url}")
        status, body = self.responses.pop(0)
        return status, body

    def of(self, command):
        """Every recorded call whose command is `command`."""
        return [c for c in self.calls if command_of(c) == command]


def command_of(call):
    """The v1.1 upload command a recorded call carries, wherever it lives."""
    if call["params"].get("command"):
        return call["params"]["command"]
    data = call["data"]
    if isinstance(data, dict):
        return data.get("command")
    if isinstance(data, (bytes, bytearray)):
        blob = bytes(data)
        for command in (b"INIT", b"APPEND", b"FINALIZE", b"STATUS"):
            if b'name="command"' in blob and command in blob:
                return command.decode()
    return None


def ok(payload):
    return (200, json.dumps(payload))


def video_file(size=9 * 1024 * 1024, suffix=".mp4"):
    """A temp file of `size` deterministic bytes. Never a real video."""
    handle = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    handle.write(bytes(range(256)) * (size // 256) + b"\x00" * (size % 256))
    handle.close()
    return handle.name


class Sleeps(list):
    def __call__(self, seconds):
        self.append(seconds)


class ChunkedUploadTest(unittest.TestCase):
    def setUp(self):
        self.path = video_file()
        self.addCleanup(os.unlink, self.path)
        self.size = os.path.getsize(self.path)

    # --- the happy path -----------------------------------------------------

    def test_init_append_finalize_status_in_that_order(self):
        http = FakeHttp([
            ok({"media_id_string": "1500"}),                      # INIT
            (204, ""),                                            # APPEND 0
            (204, ""),                                            # APPEND 1
            (204, ""),                                            # APPEND 2
            ok({"media_id_string": "1500",
                "processing_info": {"state": "pending",
                                    "check_after_secs": 5}}),     # FINALIZE
            ok({"processing_info": {"state": "in_progress",
                                    "check_after_secs": 3,
                                    "progress_percent": 60}}),    # STATUS
            ok({"processing_info": {"state": "succeeded"}}),       # STATUS
        ])
        sleeps = Sleeps()

        media_id = xpost.upload_video(
            self.path, FAKE_ENV, http=http, sleep=sleeps,
            chunk_bytes=4 * 1024 * 1024)

        self.assertEqual(media_id, "1500")
        self.assertEqual(
            [command_of(c) for c in http.calls],
            ["INIT", "APPEND", "APPEND", "APPEND", "FINALIZE", "STATUS",
             "STATUS"])
        # X says when to come back. Guessing an interval either hammers the
        # endpoint or posts minutes after the slot it was scheduled for.
        self.assertEqual(sleeps, [5, 3])

    def test_init_declares_the_real_size_type_and_category(self):
        http = FakeHttp([ok({"media_id_string": "1"}), (204, ""), (204, ""),
                         (204, ""), ok({"media_id_string": "1"})])
        xpost.upload_video(self.path, FAKE_ENV, http=http, sleep=Sleeps(),
                           chunk_bytes=4 * 1024 * 1024)

        init = http.of("INIT")[0]
        self.assertEqual(init["method"], "POST")
        self.assertEqual(init["url"], UPLOAD_URL)
        self.assertEqual(init["data"]["total_bytes"], str(self.size))
        self.assertEqual(init["data"]["media_type"], "video/mp4")
        # Without tweet_video X transcodes it as something else and the tweet
        # attaches nothing.
        self.assertEqual(init["data"]["media_category"], "tweet_video")

    def test_a_mov_is_declared_as_quicktime(self):
        path = video_file(size=1024, suffix=".mov")
        self.addCleanup(os.unlink, path)
        http = FakeHttp([ok({"media_id_string": "1"}), (204, ""),
                         ok({"media_id_string": "1"})])
        xpost.upload_video(path, FAKE_ENV, http=http, sleep=Sleeps())
        self.assertEqual(http.of("INIT")[0]["data"]["media_type"],
                         "video/quicktime")

    def test_every_byte_is_appended_exactly_once_in_order(self):
        # A dropped or reordered segment is a FINALIZE that fails with
        # "SegmentIndex out of order" — or worse, a video that transcodes into
        # garbage and posts.
        http = FakeHttp([ok({"media_id_string": "42"}), (204, ""), (204, ""),
                         (204, ""), ok({"media_id_string": "42"})])
        xpost.upload_video(self.path, FAKE_ENV, http=http, sleep=Sleeps(),
                           chunk_bytes=4 * 1024 * 1024)

        appends = http.of("APPEND")
        self.assertEqual(len(appends), 3, "9 MiB in 4 MiB chunks is 3 segments")
        self.assertEqual([segment_index_of(c) for c in appends], ["0", "1", "2"])
        sent = b"".join(media_part_of(c) for c in appends)
        with open(self.path, "rb") as f:
            self.assertEqual(sent, f.read())

    def test_a_finalize_with_no_processing_info_is_already_done(self):
        # X answers small uploads without a processing_info at all. Polling
        # STATUS anyway is a request that can only fail.
        http = FakeHttp([ok({"media_id_string": "7"}), (204, ""),
                         ok({"media_id_string": "7"})])
        sleeps = Sleeps()
        path = video_file(size=1024)
        self.addCleanup(os.unlink, path)

        media_id = xpost.upload_video(path, FAKE_ENV, http=http, sleep=sleeps)

        self.assertEqual(media_id, "7")
        self.assertEqual(http.of("STATUS"), [])
        self.assertEqual(sleeps, [])

    def test_status_is_a_signed_get_carrying_the_media_id(self):
        http = FakeHttp([
            ok({"media_id_string": "9"}), (204, ""),
            ok({"media_id_string": "9",
                "processing_info": {"state": "pending", "check_after_secs": 1}}),
            ok({"processing_info": {"state": "succeeded"}}),
        ])
        path = video_file(size=1024)
        self.addCleanup(os.unlink, path)

        xpost.upload_video(path, FAKE_ENV, http=http, sleep=Sleeps())

        status = http.of("STATUS")[0]
        self.assertEqual(status["method"], "GET")
        self.assertEqual(status["params"]["media_id"], "9")
        self.assertEqual(status["params"]["command"], "STATUS")

    def test_every_request_is_authenticated_and_no_secret_is_ever_printed(self):
        http = FakeHttp([ok({"media_id_string": "1"}), (204, ""),
                         ok({"media_id_string": "1"})])
        path = video_file(size=1024)
        self.addCleanup(os.unlink, path)

        xpost.upload_video(path, FAKE_ENV, http=http, sleep=Sleeps())

        for call in http.calls:
            header = call["headers"].get("Authorization", "")
            self.assertTrue(header.startswith("OAuth "), call["url"])
            # The signature is derived from the secrets; the secrets themselves
            # never travel, and nothing here goes anywhere near stdout.
            self.assertNotIn(FAKE_ENV["X_API_SECRET"], header)
            self.assertNotIn(FAKE_ENV["X_ACCESS_SECRET"], header)

    # --- the ways it goes wrong ---------------------------------------------

    def test_a_failed_transcode_raises_with_the_reason_x_gave(self):
        # THE failure this exists to catch: X accepts the bytes, transcoding
        # fails minutes later, and the tweet must not be created. Silently
        # posting text-only here would drop the whole point of the post.
        http = FakeHttp([
            ok({"media_id_string": "5"}), (204, ""),
            ok({"media_id_string": "5",
                "processing_info": {"state": "pending", "check_after_secs": 1}}),
            ok({"processing_info": {
                "state": "failed",
                "error": {"code": 1, "name": "InvalidMedia",
                          "message": "Unsupported video format"}}}),
        ])
        path = video_file(size=1024)
        self.addCleanup(os.unlink, path)

        with self.assertRaises(xpost.MediaUploadError) as caught:
            xpost.upload_video(path, FAKE_ENV, http=http, sleep=Sleeps())
        self.assertIn("Unsupported video format", str(caught.exception))

    def test_polling_is_bounded_rather_than_forever(self):
        # An upload stuck in in_progress must end as a failed publish with a
        # reason, not as a worker blocked until its 180s timeout kills it.
        forever = [ok({"media_id_string": "5"}), (204, "")]
        forever.append(ok({"media_id_string": "5",
                           "processing_info": {"state": "pending",
                                               "check_after_secs": 1}}))
        forever.extend([ok({"processing_info": {"state": "in_progress",
                                                "check_after_secs": 1}})] * 500)
        http = FakeHttp(forever)
        sleeps = Sleeps()
        path = video_file(size=1024)
        self.addCleanup(os.unlink, path)

        with self.assertRaises(xpost.MediaUploadError) as caught:
            xpost.upload_video(path, FAKE_ENV, http=http, sleep=sleeps,
                               max_polls=5, max_wait=60)

        self.assertLessEqual(len(http.of("STATUS")), 5)
        self.assertIn("still processing", str(caught.exception).lower())

    def test_a_poll_interval_x_asks_for_is_clamped(self):
        # check_after_secs comes off the wire. A silly value must not become a
        # silly sleep, and a missing one must not become a busy loop.
        http = FakeHttp([
            ok({"media_id_string": "5"}), (204, ""),
            ok({"media_id_string": "5",
                "processing_info": {"state": "pending",
                                    "check_after_secs": 99999}}),
            ok({"processing_info": {"state": "in_progress"}}),
            ok({"processing_info": {"state": "succeeded"}}),
        ])
        sleeps = Sleeps()
        path = video_file(size=1024)
        self.addCleanup(os.unlink, path)

        xpost.upload_video(path, FAKE_ENV, http=http, sleep=sleeps, max_wait=60)

        self.assertTrue(all(0 < s <= 30 for s in sleeps), sleeps)
        self.assertLessEqual(sum(sleeps), 60)

    def test_an_http_error_on_init_stops_before_any_bytes_move(self):
        http = FakeHttp([(400, '{"errors":[{"message":"Invalid media_type"}]}')])
        with self.assertRaises(xpost.MediaUploadError) as caught:
            xpost.upload_video(self.path, FAKE_ENV, http=http, sleep=Sleeps())
        self.assertIn("Invalid media_type", str(caught.exception))
        self.assertEqual(http.of("APPEND"), [])

    def test_a_rejected_segment_stops_the_upload(self):
        http = FakeHttp([ok({"media_id_string": "1"}), (503, "upstream error")])
        with self.assertRaises(xpost.MediaUploadError) as caught:
            xpost.upload_video(self.path, FAKE_ENV, http=http, sleep=Sleeps(),
                               chunk_bytes=4 * 1024 * 1024)
        self.assertIn("503", str(caught.exception))
        self.assertEqual(len(http.of("APPEND")), 1, "it stopped at the failure")

    def test_an_init_that_returns_no_media_id_is_a_failure(self):
        http = FakeHttp([ok({"nothing": "useful"})])
        with self.assertRaises(xpost.MediaUploadError):
            xpost.upload_video(self.path, FAKE_ENV, http=http, sleep=Sleeps())

    def test_an_empty_file_never_starts_an_upload(self):
        path = video_file(size=0)
        self.addCleanup(os.unlink, path)
        http = FakeHttp([])
        with self.assertRaises(xpost.MediaUploadError):
            xpost.upload_video(path, FAKE_ENV, http=http, sleep=Sleeps())
        self.assertEqual(http.calls, [])


class MediaKindTest(unittest.TestCase):
    def test_the_upload_path_is_chosen_from_the_extension(self):
        self.assertEqual(xpost.media_kind("/tmp/a.mp4"), "video")
        self.assertEqual(xpost.media_kind("/tmp/a.MOV"), "video")
        self.assertEqual(xpost.media_kind("/tmp/a.png"), "image")
        self.assertEqual(xpost.media_kind("/tmp/a.jpeg"), "image")
        self.assertEqual(xpost.media_kind("/tmp/a.gif"), "image")
        self.assertIsNone(xpost.media_kind("/tmp/a.webm"))
        self.assertIsNone(xpost.media_kind("/tmp/a"))


class ImageUploadUnchangedTest(unittest.TestCase):
    """The proven path, asserted to still be exactly one multipart POST."""

    def test_an_image_is_still_a_single_multipart_post(self):
        handle = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        handle.write(b"\x89PNG\r\n\x1a\n" + b"x" * 100)
        handle.close()
        self.addCleanup(os.unlink, handle.name)

        http = FakeHttp([ok({"media_id_string": "img-1"})])
        media_id = xpost.upload_media(handle.name, FAKE_ENV, http=http)

        self.assertEqual(media_id, "img-1")
        self.assertEqual(len(http.calls), 1, "no INIT, no APPEND, no FINALIZE")
        call = http.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["url"], UPLOAD_URL)
        self.assertIn("multipart/form-data; boundary=",
                      call["headers"]["Content-Type"])
        self.assertIn(b'name="media"', bytes(call["data"]))
        self.assertIn(b"\x89PNG", bytes(call["data"]))
        self.assertTrue(call["headers"]["Authorization"].startswith("OAuth "))

    def test_an_oversized_image_is_still_refused_by_the_image_path(self):
        handle = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        handle.write(b"x" * (6 * 1024 * 1024))
        handle.close()
        self.addCleanup(os.unlink, handle.name)

        http = FakeHttp([])
        with self.assertRaises(xpost.MediaUploadError):
            xpost.upload_media(handle.name, FAKE_ENV, http=http)
        self.assertEqual(http.calls, [], "refused before the request")


class ImageContentTypeTest(unittest.TestCase):
    """The declared type of an image is a MAP, not a two-way guess.

    `upload_media` declared `image/png` for a `.png` and `image/jpeg` for
    EVERYTHING ELSE, so a GIF went up announced as a JPEG and a WebP as a JPEG
    too. X sniffs the bytes as well, so this sometimes survived and sometimes
    came back as a media upload failure on a file that was fine — which is the
    worst kind of bug to hit at the moment a post is due.
    """

    def image_file(self, suffix, size=64):
        handle = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        handle.write(b"\x89PNG" + b"0" * size)
        handle.close()
        self.addCleanup(os.unlink, handle.name)
        return handle.name

    def test_every_accepted_extension_maps_to_its_own_type(self):
        self.assertEqual(xpost.IMAGE_TYPES, {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
        })
        # The classifier and the map cannot drift: one list, one source.
        self.assertEqual(sorted(xpost.IMAGE_EXTS), sorted(xpost.IMAGE_TYPES))

    def test_the_declared_type_follows_the_file(self):
        for suffix, expected in ((".gif", "image/gif"),
                                 (".webp", "image/webp"),
                                 (".jpeg", "image/jpeg"),
                                 (".jpg", "image/jpeg"),
                                 (".PNG", "image/png")):
            path = self.image_file(suffix)
            http = FakeHttp([ok({"media_id_string": "9"})])
            xpost.upload_media(path, FAKE_ENV, http=http)
            body = bytes(http.calls[0]["data"])
            self.assertIn(f"Content-Type: {expected}".encode(), body,
                          f"{suffix} must be declared as {expected}")

    def test_a_type_this_script_does_not_send_never_gets_a_declared_type(self):
        path = self.image_file(".bmp")
        with self.assertRaises(xpost.MediaUploadError):
            xpost.image_mime(path)


class FilenameSanitisationTest(unittest.TestCase):
    """The file name is interpolated into a multipart HEADER.

    `Content-Disposition: form-data; name="media"; filename="<name>"` was built
    by f-string from `os.path.basename(path)`. A name carrying CR, LF or a
    double quote therefore ends the header early and writes whatever follows as
    more headers or another part — header injection into X's upload endpoint,
    from a file name an operator can choose in an upload dialog.
    """

    def written(self, name, size=64):
        directory = tempfile.mkdtemp()
        path = os.path.join(directory, name)
        with open(path, "wb") as handle:
            handle.write(b"0" * size)
        self.addCleanup(lambda: (os.unlink(path), os.rmdir(directory)))
        return path

    def test_crlf_and_quotes_are_stripped_out_of_the_name(self):
        self.assertEqual(
            xpost.safe_filename('a"\r\nX-Injected: 1\r\n\r\n<b>.png'),
            "aX-Injected: 1<b>.png",
        )
        self.assertEqual(xpost.safe_filename("clean-name.png"), "clean-name.png")
        self.assertEqual(xpost.safe_filename('quo"ted\\.png'), "quoted.png")
        # A path is one name by the time it is a filename= value.
        self.assertEqual(xpost.safe_filename("../../etc/passwd"), "passwd")
        self.assertEqual(xpost.safe_filename(""), "upload")
        self.assertEqual(xpost.safe_filename('"""'), "upload")

    def test_the_multipart_header_cannot_be_broken_out_of(self):
        path = self.written('evil"\r\nX-Injected: 1.png')
        http = FakeHttp([ok({"media_id_string": "9"})])
        xpost.upload_media(path, FAKE_ENV, http=http)

        blob = bytes(http.calls[0]["data"])
        header = blob[:blob.index(b"\r\n\r\n")]
        self.assertNotIn(b"X-Injected", header,
                         "the injected header must not survive")
        self.assertEqual(header.count(b'filename="'), 1)
        # Exactly two header lines: the disposition and the content type.
        self.assertEqual(len(header.split(b"\r\n")), 3, header)


class LeadingHyphenCaptionTest(unittest.TestCase):
    """A caption may legitimately start with a hyphen.

    "-40% this week" is a perfectly ordinary social post. It is passed to this
    script as a positional argument, and argparse reads a leading hyphen as an
    option — so the publish died with `unrecognized arguments` and an exit code,
    never reaching X. The caller separates options from text with `--`; this
    asserts the parser on this side honours it.
    """

    def parse(self, argv):
        return xpost.build_parser().parse_args(argv)

    def test_text_after_a_double_dash_is_text_however_it_starts(self):
        for caption in ("-40%-off", "--dry-run", "-", "-h", "--help"):
            args = self.parse(["post", "--media", "/tmp/a.png", "--", caption])
            self.assertEqual(args.text, caption)
            self.assertEqual(args.media, "/tmp/a.png")

    def test_the_options_before_it_are_still_options(self):
        args = self.parse(
            ["post", "--media", "/tmp/a.mp4", "--alt", "a demo", "--", "-40% off"])
        self.assertEqual(args.cmd, "post")
        self.assertEqual(args.media, "/tmp/a.mp4")
        self.assertEqual(args.alt, "a demo")
        self.assertEqual(args.text, "-40% off")

    def test_an_ordinary_caption_is_unaffected(self):
        args = self.parse(["post", "--", "hello world"])
        self.assertEqual(args.text, "hello world")
        self.assertEqual(args.alt, "")
        self.assertIsNone(args.media)

    def test_without_the_separator_a_hyphen_caption_is_still_rejected(self):
        # Why the separator is required rather than nice to have.
        with self.assertRaises(SystemExit):
            self.parse(["post", "-40%-off"])


def segment_index_of(call):
    return field_of(bytes(call["data"]), b"segment_index").decode()


def field_of(blob, name):
    """Read one multipart field's value out of a recorded body."""
    marker = b'name="' + name + b'"\r\n\r\n'
    start = blob.index(marker) + len(marker)
    return blob[start:blob.index(b"\r\n--", start)]


def media_part_of(call):
    blob = bytes(call["data"])
    marker = b'name="media"'
    start = blob.index(marker)
    start = blob.index(b"\r\n\r\n", start) + 4
    return blob[start:blob.rindex(b"\r\n--")]


if __name__ == "__main__":
    unittest.main()
