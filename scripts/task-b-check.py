"""Trusted Task B supervisor. The extension starts this file with isolated Python and JSON stdin."""

import io
import json
import os
from pathlib import Path
import re
import resource
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import sysconfig
import tarfile
import tempfile


PROJECT = Path(__file__).resolve().parents[1]
PIN = "22d924701a6ae2e4cd01e9a15bbaf3946094af65"
FIXTURE = PROJECT / "fixtures/flask-3.1.3"
VENV = PROJECT / "scratch/flask-task-a-agent-venv"
PYTHON = VENV / "bin/python"
SANDBOX = "/usr/bin/sandbox-exec"
OUTPUT_LIMIT = 1024 * 1024


class CheckFailed(Exception):
    """Only messages constructed by the trusted supervisor reach the caller."""


def git(root, *args):
    return subprocess.run(
        ["/usr/bin/git", "--no-optional-locks", "--no-replace-objects", "-c",
         "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, *args],
        env={"PATH": "/usr/bin:/bin", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"},
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        timeout=10, check=True,
    ).stdout


def check_worktree(root):
    marker = root / ".git"
    if marker.is_symlink() or not marker.is_file():
        raise CheckFailed("Expected a disposable linked worktree.")
    top, gitdir, common, head = git(
        root, "rev-parse", "--path-format=absolute", "--show-toplevel",
        "--absolute-git-dir", "--git-common-dir", "HEAD",
    ).decode().splitlines()
    admin = Path(gitdir)
    if (Path(top) != root or admin.parent != Path(common) / "worktrees"
            or Path((admin / "gitdir").read_text().rstrip("\n")).resolve() != marker):
        raise CheckFailed("Expected the root of a registered linked worktree.")
    if head != PIN:
        raise CheckFailed("The worktree HEAD differs from the pinned Flask commit.")
    if (git(root, "diff-index", "--cached", "--name-only", "-z", PIN, "--")
            or git(root, "ls-files", "--others", "--exclude-standard", "-z")):
        raise CheckFailed("Expected a clean worktree and index.")


def stage(root, files, tree):
    # Read blobs from the trusted commit. Ignored files, .git, filters and live-tree
    # symlinks must never become part of the executable snapshot.
    archive = git(FIXTURE, "archive", "--format=tar", PIN)
    regular = set()
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        for entry in tar:
            target = tree / entry.name
            if entry.isdir():
                target.mkdir()
                continue
            if not entry.isreg():
                raise CheckFailed("Unexpected non-regular file in pinned tree.")
            data = tar.extractfile(entry).read()
            source = root / entry.name
            if source.resolve() != source or not source.is_file():
                raise CheckFailed("Expected clean tracked regular files in the worktree.")
            if source.read_bytes() != data or bool(source.stat().st_mode & stat.S_IXUSR) != bool(entry.mode & 0o100):
                raise CheckFailed("Expected a clean worktree matching the pinned tree.")
            target.write_bytes(data)
            target.chmod(entry.mode & 0o755)
            regular.add(entry.name)
    if not isinstance(files, dict) or not all(k in regular and isinstance(v, str) for k, v in files.items()):
        raise CheckFailed("Each replacement must contain text for an exact tracked regular file.")


PROFILE = """
(version 1)
(deny default)
(import "dyld-support.sb")
(allow process-exec (literal (param "PYTHON")))
(allow file-read* file-map-executable
    (literal (param "PYTHON")) (subpath (param "LIB")) (subpath (param "VENV"))
    (subpath "/System/Library") (subpath "/usr/lib"))
(allow file-read-metadata
    (path-ancestors (param "VENV")) (path-ancestors (param "PYTHON"))
    (path-ancestors (param "LIB")) (path-ancestors (param "TREE")))
(allow file-read* (subpath (param "TREE")) (subpath (param "CHECKS"))
    (literal "/dev/null") (literal "/dev/urandom"))
(allow file-read* file-write* (subpath (param "TMP")))
(deny file-write-flags)
(allow sysctl-read)
(allow signal (target self))
"""

# Bypass all startup .pth files (this venv's editable Flask points at a live
# worktree). Only the private src and the trusted venv packages are added.
BOOTSTRAP = """
import os, runpy, sys
sys.path.append(os.environ["VERIFY_PACKAGES"])
sys.path.insert(0, os.environ["VERIFY_SRC"])
runpy.run_module(%r, run_name="__main__", alter_sys=True)
"""


def limit_child():
    resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
    resource.setrlimit(resource.RLIMIT_FSIZE, (OUTPUT_LIMIT, OUTPUT_LIMIT))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def run_check(tree, checks, cwd, label, module, *args):
    # Separate writable directories for each invocation. Tests cannot rewrite the
    # next command, its app, its inputs, or the supervisor's output files.
    with tempfile.TemporaryDirectory(dir=tree.parent) as scratch:
        params = {"PYTHON": PYTHON.resolve(), "VENV": VENV, "LIB": Path(sys.base_prefix) / "lib",
                  "TREE": tree, "CHECKS": checks, "TMP": scratch}
        command = [SANDBOX, "-p", PROFILE]
        for key, value in params.items():
            command.extend(["-D", f"{key}={value}"])
        command.extend([str(PYTHON.resolve()), "-I", "-S", "-B", "-c", BOOTSTRAP % module, *args])
        if module == "pytest":
            command.extend(["--log-file", f"{scratch}/pytest.log"])
        env = {"HOME": scratch, "TMPDIR": scratch, "LC_ALL": "C", "TZ": "UTC",
               "VERIFY_PACKAGES": sysconfig.get_path("purelib"), "VERIFY_SRC": str(tree / "src"),
               "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1"}
        with tempfile.TemporaryFile(dir=tree.parent) as stdout, tempfile.TemporaryFile(dir=tree.parent) as stderr:
            result = subprocess.run(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                    stdout=stdout, stderr=stderr, preexec_fn=limit_child, timeout=25)
            stdout.seek(0)
            stderr.seek(0)
            output, errors = stdout.read(OUTPUT_LIMIT), stderr.read(OUTPUT_LIMIT)
    if result.returncode:
        if errors.startswith(b"sandbox-exec:"):
            raise CheckFailed("macOS sandbox-exec could not start the isolated verifier.")
        details = (output + b"\n" + errors).decode("utf8", errors="replace")
        details = re.sub(r"/private/tmp/forge-task-b-[^/\s]+", "[isolated-tree]", details)
        details = re.sub(r"(?i)(SECRET|PASSWORD|TOKEN|KEY)[^\s]*[=:][^\s]+", "[masked]", details)
        raise CheckFailed(f"{label} failed (exit {result.returncode}): {details[-900:]}")
    return output.decode("utf8"), errors.decode("utf8", errors="replace")


def pytest_cli(tree, checks, cwd):
    output, _ = run_check(tree, checks, cwd, "pytest tests/test_cli.py -q", "pytest",
                          "tests/test_cli.py", "-q", "-c", str(checks / "pyproject.toml"),
                          "-p", "no:cacheprovider")
    counts = re.search(r"(?m)^(\d+) passed(?:, [^\n]+)? in [\d.]+s\s*$", output)
    if not counts:
        raise CheckFailed("pytest did not report passing CLI tests.")
    return counts[1] + " passed"


def check_cli(tree, checks):
    # The app has different public data for each loading mode and unique fake
    # secrets so misplaced values (including stderr leaks) cannot pass.
    secret = secrets.token_hex(16)
    keys = ("x_sEcReT_hint", "db_PASSWORD_v2", "refresh_tOKen_id", "signing_keY_id")
    probe = checks / "sample_app.py"
    probe.write_text(f"""
from datetime import timedelta
from flask import Flask

def create_app(label="factory"):
    app = Flask(__name__)
    app.config.update({dict.fromkeys(keys, secret)!r})
    app.config.update(DISPLAY_LABEL=label, PUBLIC_OPTIONS=[3, False, None],
                      RETENTION=timedelta(days=2), SECRET_KEY={secret!r})
    return app

app = create_app("instance")
""")
    help_output, _ = run_check(tree, checks, tree, "flask --help", "flask", "--help")
    if not re.search(r"(?m)^\s+config(?:[ \t]+[^\n]*)?$", help_output):
        raise CheckFailed("flask --help does not list the config command.")
    for target, label in (("create_app()", "factory"), ("app", "instance")):
        output, errors = run_check(tree, checks, tree, f"flask config ({label})", "flask",
                                   "--app", f"{probe}:{target}", "config")
        try:
            data = json.loads(output)
        except ValueError:
            raise CheckFailed(f"flask config ({label}) did not emit valid JSON.") from None
        if not isinstance(data, dict) or secret in output + errors or any(
            data.get(k) != "***" for k in (*keys, "SECRET_KEY")
        ):
            raise CheckFailed(f"flask config ({label}) failed the masking check.")
        if (data.get("DISPLAY_LABEL") != label or data.get("PUBLIC_OPTIONS") != [3, False, None]
                or data.get("RETENTION") in (None, "", "***")
                or data.get("PERMANENT_SESSION_LIFETIME") in (None, "", "***")):
            raise CheckFailed(f"flask config ({label}) lost public or non-native configuration values.")


def verify(request):
    if sys.platform != "darwin" or not Path(SANDBOX).is_file():
        raise CheckFailed("Verification requires macOS sandbox-exec.")
    root = Path(request["root"]).resolve(strict=True)
    files = request["files"]
    check_worktree(root)
    with tempfile.TemporaryDirectory(prefix="forge-task-b-", dir="/private/tmp") as workspace:
        tree, checks = Path(workspace) / "tree", Path(workspace) / "checks"
        tree.mkdir()
        checks.mkdir()
        stage(root, files, tree)
        shutil.copyfile(tree / "pyproject.toml", checks / "pyproject.toml")
        changed_tests = any(k.startswith("tests/") for k in files)
        if changed_tests:
            shutil.copytree(tree / "tests", checks / "tests")
        for name, content in files.items():
            (tree / name).write_text(content, encoding="utf8")
        if changed_tests:
            pytest_cli(tree, checks, checks)
        passed = pytest_cli(tree, checks, tree)
        try:
            check_cli(tree, checks)
        except CheckFailed as error:
            raise CheckFailed(f"pytest {passed}. {error}") from None
    return f"pytest {passed}. flask --help lists config; masked JSON passed for factory and instance."


def interrupt(*_):
    raise CheckFailed("Task B verification cancelled.")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupt)
    try:
        print(verify(json.load(sys.stdin)))
    except CheckFailed as error:
        print(error)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print("Task B verification timed out.")
        sys.exit(1)
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print(f"Could not prepare the isolated Task B check ({type(error).__name__}).")
        sys.exit(1)
