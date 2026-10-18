#!/usr/bin/env python3
"""Regression checks for Apple's transient ticket-delivery failures."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("macos_build", Path(__file__).with_name("build-macos-app.py"))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
NETWORK_ERROR = 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."'


def result(code=0, output=""):
    return subprocess.CompletedProcess(["xcrun", "stapler"], code, stdout=output, stderr="")


class StaplerTests(unittest.TestCase):
    @patch.object(build.subprocess, "run")
    @patch("time.sleep")
    def test_success_needs_no_retry(self, sleep, run):
        run.return_value = result()
        build.stapler("validate", Path("Example.app"))
        run.assert_called_once_with(["xcrun", "stapler", "validate", "Example.app"], capture_output=True, text=True, timeout=120)
        sleep.assert_not_called()

    @patch.object(build.subprocess, "run")
    @patch("time.sleep")
    def test_network_failure_retries_same_artifact(self, sleep, run):
        run.side_effect = [result(68, NETWORK_ERROR), result()]
        build.stapler("staple", Path("Example.dmg"))
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args_list[0], run.call_args_list[1])
        sleep.assert_called_once_with(5)

    @patch.object(build.subprocess, "run")
    @patch("time.sleep")
    def test_repeated_network_failure_still_blocks_release(self, sleep, run):
        run.return_value = result(68, NETWORK_ERROR)
        with self.assertRaises(subprocess.CalledProcessError):
            build.stapler("validate", Path("Example.app"))
        self.assertEqual(run.call_count, 5)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [5, 10, 20, 40])

    @patch.object(build.subprocess, "run")
    @patch("time.sleep")
    def test_other_failures_are_not_retried(self, sleep, run):
        for code, output in [(68, "Could not validate ticket"), (65, NETWORK_ERROR), (66, "Invalid signature")]:
            with self.subTest(code=code, output=output):
                run.reset_mock()
                run.return_value = result(code, output)
                with self.assertRaises(subprocess.CalledProcessError):
                    build.stapler("validate", Path("Example.app"))
                run.assert_called_once()
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
