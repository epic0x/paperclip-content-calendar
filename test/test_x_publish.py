"""The publisher shim the plugin actually spawns.

`x_publish.py` is what src/channels.ts runs. It does no HTTP of its own: it
validates the request, then invokes `x-post.py` as a subprocess so the OAuth
credentials stay in that one script and never enter the worker, the plugin
config, or the database.

Two things about it were wrong for video and are asserted here:

  1. it resolved `x-post.py` through `~/.hermes/scripts`, a path that exists on
     one particular machine. The installed plugin ships both scripts together,
     so the sibling next to this file is the one that must be run;
  2. it rejected anything over 5 MB. That is X's IMAGE limit. Applying it to a
     video rejects the file before a single byte is uploaded.

Nothing here starts a subprocess or opens a socket: the command is asserted as
a list, which is also how it is executed — argv, never a shell string.
"""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from importlib import util as importlib_util

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(name, filename):
    spec = importlib_util.spec_from_file_location(
        name, os.path.join(REPO, "scripts", filename))
    module = importlib_util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


publish = load("x_publish", "x_publish.py")


def sized(suffix, size):
    handle = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    handle.write(b"x" * size)
    handle.close()
    return handle.name


class ResolveXPostTest(unittest.TestCase):
    def test_the_sibling_script_is_the_default(self):
        # Both scripts are packaged together, so "next to me" is the only path
        # that is right on every host this is installed on.
        resolved = publish.resolve_xpost({})
        self.assertEqual(resolved, os.path.join(REPO, "scripts", "x-post.py"))
        self.assertTrue(os.path.exists(resolved), "the sibling really is there")

    def test_an_explicit_override_still_wins(self):
        self.assertEqual(
            publish.resolve_xpost({"PAPERCLIP_X_POST_SCRIPT": "/opt/x-post.py"}),
            "/opt/x-post.py",
        )

    def test_an_empty_override_is_not_an_override(self):
        self.assertEqual(
            publish.resolve_xpost({"PAPERCLIP_X_POST_SCRIPT": "   "}),
            os.path.join(REPO, "scripts", "x-post.py"),
        )


class MediaLimitTest(unittest.TestCase):
    def test_a_video_is_not_held_to_the_image_limit(self):
        path = sized(".mp4", 6 * 1024 * 1024)
        self.addCleanup(os.unlink, path)
        self.assertIsNone(publish.media_error(path),
                          "6 MB is fine for a video and was the old rejection")

    def test_an_image_is_still_held_to_x_s_5_mb(self):
        path = sized(".png", 6 * 1024 * 1024)
        self.addCleanup(os.unlink, path)
        error = publish.media_error(path)
        self.assertIsNotNone(error)
        self.assertIn("5", error)

    def test_a_video_past_x_s_own_limit_is_refused(self):
        # Asserted on the limit function rather than by writing 512 MB to disk.
        self.assertEqual(publish.limit_bytes(".mp4"), 512 * 1024 * 1024)
        self.assertEqual(publish.limit_bytes(".mov"), 512 * 1024 * 1024)
        self.assertEqual(publish.limit_bytes(".png"), 5 * 1024 * 1024)

    def test_a_type_this_publisher_does_not_send_is_refused_early(self):
        path = sized(".webm", 1024)
        self.addCleanup(os.unlink, path)
        error = publish.media_error(path)
        self.assertIsNotNone(error)
        self.assertIn("webm", error)

    def test_a_missing_file_is_refused_before_anything_is_spawned(self):
        error = publish.media_error("/tmp/definitely-not-here-9f2a.mp4")
        self.assertIsNotNone(error)
        self.assertIn("not found", error)

    def test_an_empty_file_is_refused(self):
        path = sized(".mp4", 0)
        self.addCleanup(os.unlink, path)
        self.assertIsNotNone(publish.media_error(path))


class BuildCommandTest(unittest.TestCase):
    def test_the_command_is_argv_and_never_a_shell_string(self):
        cmd = publish.build_command("/opt/x-post.py", "hello", "/tmp/a.mp4",
                                    "a demo")
        self.assertIsInstance(cmd, list)
        self.assertEqual(cmd[:3], [sys.executable, "/opt/x-post.py", "post"])
        self.assertIn("--media", cmd)
        self.assertEqual(cmd[cmd.index("--media") + 1], "/tmp/a.mp4")
        self.assertEqual(cmd[cmd.index("--alt") + 1], "a demo")

    def test_caption_text_is_one_argv_element_however_it_is_punctuated(self):
        # An argv list is why this is safe; assert the shape that makes it so.
        nasty = 'hi"; rm -rf / #'
        cmd = publish.build_command("/opt/x-post.py", nasty, None, None)
        self.assertIn(nasty, cmd)
        self.assertEqual(len(cmd), 5, "no media, no alt: exe, script, post, --, text")

    def test_no_alt_means_no_alt_flag(self):
        cmd = publish.build_command("/opt/x-post.py", "hi", "/tmp/a.png", "")
        self.assertNotIn("--alt", cmd)


class LeadingHyphenCaptionTest(unittest.TestCase):
    """"-40% this week" is an ordinary post, and it was unpublishable.

    The caption is the positional argument of `x-post.py post`, so a caption
    starting with a hyphen was read by argparse as an option and the publish
    ended in `unrecognized arguments` — an exit code and a usage line, never a
    tweet. Options first, then `--`, then the text: everything after the
    separator is a positional whatever it starts with.
    """

    def test_the_caption_comes_last_behind_a_double_dash(self):
        cmd = publish.build_command("/opt/x-post.py", "-40% off", "/tmp/a.mp4",
                                    "a demo")
        self.assertEqual(cmd[-2:], ["--", "-40% off"])
        # The options are all in front of the separator, so they stay options.
        self.assertLess(cmd.index("--media"), cmd.index("--"))
        self.assertLess(cmd.index("--alt"), cmd.index("--"))

    def test_a_hyphen_caption_survives_the_round_trip_into_x_post(self):
        # The two sides have to agree, so parse the argv we build with the
        # parser that will actually receive it.
        xpost = load("xpost", "x-post.py")
        for caption in ("-40%-off", "--dry-run", "-h"):
            cmd = publish.build_command("/opt/x-post.py", caption,
                                        "/tmp/a.png", "alt")
            args = xpost.build_parser().parse_args(cmd[2:])
            self.assertEqual(args.text, caption)
            self.assertEqual(args.media, "/tmp/a.png")
            self.assertEqual(args.alt, "alt")

    def test_an_ordinary_caption_still_arrives_unchanged(self):
        xpost = load("xpost", "x-post.py")
        cmd = publish.build_command("/opt/x-post.py", "hello world", None, None)
        args = xpost.build_parser().parse_args(cmd[2:])
        self.assertEqual(args.text, "hello world")
        self.assertIsNone(args.media)


class TimeoutLeavesNothingBehindTest(unittest.TestCase):
    """A publisher that times out must not leave a process group running.

    `subprocess.run(..., timeout=…)` kills the direct child and then waits for
    it — but x-post.py's own children (and anything they spawn) are not touched,
    so a timed-out publish left an upload still running against X with nobody
    reading its output, and the pipe it inherited kept `communicate` blocked
    long past the timeout it was supposed to enforce. The child gets its own
    session, and the whole group is killed and reaped.

    Real processes, no network: the child spawns a grandchild that sleeps, and
    the test asserts on the grandchild's pid afterwards.
    """

    def child_that_spawns_a_grandchild(self, pidfile):
        return [sys.executable, "-c", (
            "import subprocess, sys, time\n"
            "child = subprocess.Popen([sys.executable, '-c',"
            " 'import time; time.sleep(120)'])\n"
            "open(sys.argv[1], 'w').write(str(child.pid))\n"
            "time.sleep(120)\n"
        ), pidfile]

    def alive(self, pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def grandchild_pid(self, pidfile, deadline=10.0):
        waited = 0.0
        while waited < deadline:
            if os.path.exists(pidfile):
                raw = Path(pidfile).read_text().strip()
                if raw:
                    return int(raw)
            time.sleep(0.05)
            waited += 0.05
        self.fail("the child never reported its grandchild")

    def test_a_timeout_kills_the_whole_group_and_reaps_it(self):
        handle = tempfile.NamedTemporaryFile(delete=False)
        handle.close()
        self.addCleanup(os.unlink, handle.name)

        started = publish.start_publisher(
            self.child_that_spawns_a_grandchild(handle.name))
        self.addCleanup(publish.kill_process_group, started)
        grandchild = self.grandchild_pid(handle.name)
        self.assertTrue(self.alive(grandchild), "the grandchild is running")

        with self.assertRaises(publish.PublisherTimeout):
            publish.collect_publisher(started, timeout=1)

        # The direct child is reaped — not a zombie, not still running.
        self.assertIsNotNone(started.poll())
        # And the grandchild, which subprocess.run would have orphaned, is gone.
        for _ in range(100):
            if not self.alive(grandchild):
                break
            time.sleep(0.05)
        self.assertFalse(self.alive(grandchild),
                         f"pid {grandchild} was orphaned by the timeout")

    def test_the_publisher_is_its_own_session_so_the_group_is_only_it(self):
        started = publish.start_publisher(
            [sys.executable, "-c", "import time; time.sleep(120)"])
        self.addCleanup(publish.kill_process_group, started)
        # Its own session, or killpg would signal the worker that spawned it.
        self.assertEqual(os.getpgid(started.pid), started.pid)
        self.assertNotEqual(os.getpgid(started.pid), os.getpgid(0))

    def test_a_run_that_finishes_in_time_is_returned_normally(self):
        started = publish.start_publisher(
            [sys.executable, "-c", "print('TWEET_ID: 7')"])
        code, stdout, stderr = publish.collect_publisher(started, timeout=30)
        self.assertEqual(code, 0)
        self.assertIn("TWEET_ID: 7", stdout)
        self.assertEqual(stderr, "")

    def test_nothing_here_ever_goes_through_a_shell(self):
        source = Path(os.path.join(REPO, "scripts", "x_publish.py")).read_text()
        self.assertNotIn("shell=True", source)
        self.assertIn("start_new_session=True", source)
        self.assertNotIn("subprocess.run(", source,
                         "run() cannot kill a process group")


class ParseOutputTest(unittest.TestCase):
    def test_the_tweet_id_and_url_are_read_back_off_the_publisher(self):
        blob = ("MEDIA_ID: 1500\nHTTP 201\nTWEET_ID: 99\n"
                "URL: https://x.com/untracenetwork/status/99\n")
        self.assertEqual(publish.parse_output(blob),
                         {"id": "99",
                          "url": "https://x.com/untracenetwork/status/99",
                          "media_id": "1500"})

    def test_a_run_that_printed_no_tweet_id_is_not_a_success(self):
        self.assertIsNone(publish.parse_output("MEDIA_ID: 5\n")["id"])


if __name__ == "__main__":
    unittest.main()
