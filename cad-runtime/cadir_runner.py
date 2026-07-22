from __future__ import annotations

import argparse
import ast
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any


ALLOWED_IMPORT_ROOTS = {"math", "simplecadapi"}
BLOCKED_CALLS = {
    "breakpoint",
    "compile",
    "eval",
    "exec",
    "input",
    "open",
    "__import__",
    "delattr",
    "getattr",
    "globals",
    "help",
    "locals",
    "setattr",
    "vars",
}
BLOCKED_PROBE_ATTRIBUTES = {
    "chmod", "chown", "connect", "dump", "dumps", "fork", "kill", "makedirs",
    "mkdir", "open", "popen", "remove", "rename", "replace", "request", "rmdir",
    "save", "socket", "spawn", "system", "export_step", "export_stl",
    "render_screenshot_rpath", "translate_model_json_to_fcstd", "unlink", "urlopen",
    "write", "write_bytes", "write_text",
}
MAX_PROBE_CHARS = 12 * 1024
REQUIRED_OUTPUTS = (
    "model.py",
    "requirements.md",
    "model.json",
    "model.step",
    "model.stl",
    "model.FCStd",
    "render-isometric.png",
    "render-front.png",
    "render-top.png",
    "render-right.png",
    "validation.json",
)


class RunnerError(RuntimeError):
    pass


def _resolved_child(root: Path, candidate: Path) -> Path:
    resolved_root = root.resolve()
    resolved = candidate.resolve()
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise RunnerError(f"path escapes CADIR_JOBS_ROOT: {resolved}")
    return resolved


def resolve_job_dir(raw_path: str) -> Path:
    jobs_root = Path(os.environ.get("CADIR_JOBS_ROOT", "/workspace/jobs"))
    job_dir = _resolved_child(jobs_root, Path(raw_path))
    if not job_dir.is_dir():
        raise RunnerError(f"job directory does not exist: {job_dir}")
    return job_dir


def validate_model_source(source_path: Path) -> None:
    if source_path.name != "model.py":
        raise RunnerError("the modeling script must be named model.py")
    try:
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
    except (OSError, SyntaxError, UnicodeError) as exc:
        raise RunnerError(f"invalid model.py: {exc}") from exc

    has_build_model = False
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "build_model":
            has_build_model = True
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".", 1)[0] not in ALLOWED_IMPORT_ROOTS:
                    raise RunnerError(f"blocked import: {alias.name}")
        if isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if module.split(".", 1)[0] not in ALLOWED_IMPORT_ROOTS:
                raise RunnerError(f"blocked import: {module or '<relative>'}")
        if isinstance(node, ast.Call):
            name = node.func.id if isinstance(node.func, ast.Name) else None
            if name in BLOCKED_CALLS or name in BLOCKED_PROBE_ATTRIBUTES:
                raise RunnerError(f"blocked call: {name}")
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            raise RunnerError(f"dunder attribute access is blocked: {node.attr}")

    if not has_build_model:
        raise RunnerError("model.py must define build_model()")


def validate_probe_source(source: str) -> None:
    if not source.strip():
        raise RunnerError("probe code is required")
    if len(source) > MAX_PROBE_CHARS:
        raise RunnerError(f"probe code exceeds {MAX_PROBE_CHARS} characters")
    try:
        tree = ast.parse(source, filename="<cadir-python-probe>")
    except SyntaxError as exc:
        raise RunnerError(f"invalid probe code: {exc}") from exc
    if sum(1 for _ in ast.walk(tree)) > 2000:
        raise RunnerError("probe code is too complex")

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".", 1)[0] not in ALLOWED_IMPORT_ROOTS:
                    raise RunnerError(f"blocked import: {alias.name}")
        if isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level or module.split(".", 1)[0] not in ALLOWED_IMPORT_ROOTS:
                raise RunnerError(f"blocked import: {module or '<relative>'}")
        if isinstance(node, ast.Call):
            name = node.func.id if isinstance(node.func, ast.Name) else None
            if name in BLOCKED_CALLS or name in BLOCKED_PROBE_ATTRIBUTES:
                raise RunnerError(f"blocked call: {name}")
        if isinstance(node, ast.Name) and node.id.startswith("__"):
            raise RunnerError(f"dunder name access is blocked: {node.id}")
        if isinstance(node, ast.Attribute):
            if node.attr.startswith("__"):
                raise RunnerError(f"dunder attribute access is blocked: {node.attr}")
            if node.attr in BLOCKED_PROBE_ATTRIBUTES:
                raise RunnerError(f"blocked probe attribute: {node.attr}")


def _set_probe_limits(timeout_seconds: int) -> None:
    import resource

    resource.setrlimit(resource.RLIMIT_CPU, (timeout_seconds, timeout_seconds + 1))
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))


def run_probe(job_dir: Path, source: str, timeout_seconds: int) -> dict[str, Any]:
    validate_probe_source(source)
    worker = Path(__file__).with_name("probe_worker.py")
    state_dir = job_dir / ".cadir"
    state_dir.mkdir(exist_ok=True)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="probe-", dir=state_dir) as temporary:
        probe_root = Path(temporary)
        env = {
            "HOME": str(probe_root),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "MKL_NUM_THREADS": "1",
            "OPENBLAS_NUM_THREADS": "1",
            "OMP_NUM_THREADS": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        try:
            completed = subprocess.run(
                [sys.executable, "-B", "-I", str(worker)],
                cwd=probe_root,
                env=env,
                input=source,
                text=True,
                capture_output=True,
                timeout=timeout_seconds + 1,
                check=False,
                preexec_fn=lambda: _set_probe_limits(timeout_seconds),
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": f"probe timed out after {timeout_seconds}s", "stdout": "", "stderr": "", "durationMs": int((time.monotonic() - started) * 1000)}
    if completed.returncode in {-signal.SIGXCPU, -signal.SIGKILL}:
        return {"ok": False, "error": f"probe timed out after {timeout_seconds}s", "stdout": "", "stderr": "", "durationMs": int((time.monotonic() - started) * 1000)}
    if completed.returncode == -signal.SIGXFSZ:
        return {"ok": False, "error": "probe file output was blocked", "stdout": "", "stderr": "", "durationMs": int((time.monotonic() - started) * 1000)}
    if completed.returncode != 0:
        raise RunnerError(f"probe worker failed (exit {completed.returncode}): {completed.stderr.strip()[-2000:]}")
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RunnerError("probe worker returned invalid diagnostics") from exc
    result["durationMs"] = int((time.monotonic() - started) * 1000)
    return result


def _latest_pointer(job_dir: Path) -> Path:
    state_dir = job_dir / ".cadir"
    state_dir.mkdir(exist_ok=True)
    return state_dir / "latest-run.json"


def _read_latest_run(job_dir: Path) -> Path:
    pointer = _latest_pointer(job_dir)
    if not pointer.is_file():
        raise RunnerError("no successful CAD run is available")
    data = json.loads(pointer.read_text(encoding="utf-8"))
    run_dir = _resolved_child(job_dir, job_dir / data["relativeRunDir"])
    if not run_dir.is_dir():
        raise RunnerError("latest CAD run directory is missing")
    return run_dir


def run_model(job_dir: Path, timeout_seconds: int) -> dict[str, Any]:
    source_path = job_dir / "model.py"
    requirements_path = job_dir / "requirements.md"
    if not requirements_path.is_file():
        raise RunnerError("requirements.md is required before code execution")
    validate_model_source(source_path)

    run_id = f"{int(time.time())}-{uuid.uuid4().hex[:10]}"
    run_dir = job_dir / ".cadir" / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    shutil.copy2(source_path, run_dir / "model.py")
    shutil.copy2(requirements_path, run_dir / "requirements.md")

    worker = Path(__file__).with_name("execute_model.py")
    command = [
        sys.executable,
        "-B",
        str(worker),
        "--source",
        str(source_path),
        "--output-dir",
        str(run_dir),
    ]
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(job_dir / ".home"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "MPLCONFIGDIR": str(job_dir / ".matplotlib"),
        "CADIR_FREECAD_CMD": os.environ.get("CADIR_FREECAD_CMD", "FreeCADCmd"),
    }
    (job_dir / ".home").mkdir(exist_ok=True)
    (job_dir / ".matplotlib").mkdir(exist_ok=True)

    try:
        completed = subprocess.run(
            command,
            cwd=job_dir,
            env=env,
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RunnerError(f"CAD execution timed out after {timeout_seconds}s") from exc
    if completed.returncode != 0:
        stderr = completed.stderr.strip()[-4000:]
        stdout = completed.stdout.strip()[-2000:]
        raise RunnerError(f"CAD execution failed (exit {completed.returncode})\n{stdout}\n{stderr}")

    missing = [name for name in REQUIRED_OUTPUTS if not (run_dir / name).is_file()]
    if missing:
        raise RunnerError(f"CAD worker omitted required outputs: {', '.join(missing)}")

    pointer_payload = {
        "runId": run_id,
        "relativeRunDir": str(run_dir.relative_to(job_dir)).replace("\\", "/"),
    }
    pointer = _latest_pointer(job_dir)
    temporary_pointer = pointer.with_suffix(".tmp")
    temporary_pointer.write_text(json.dumps(pointer_payload, indent=2), encoding="utf-8")
    os.replace(temporary_pointer, pointer)

    validation = json.loads((run_dir / "validation.json").read_text(encoding="utf-8"))
    return {
        "ok": True,
        "runId": run_id,
        "runDir": str(run_dir),
        "stdout": completed.stdout.strip()[-4000:],
        "validation": validation,
        "images": [str(run_dir / name) for name in REQUIRED_OUTPUTS if name.endswith(".png")],
    }


def publish_model(job_dir: Path) -> dict[str, Any]:
    run_dir = _read_latest_run(job_dir)
    missing = [name for name in REQUIRED_OUTPUTS if not (run_dir / name).is_file()]
    if missing:
        raise RunnerError(f"cannot publish incomplete run: {', '.join(missing)}")

    artifacts = {
        "python": str(run_dir / "model.py"),
        "requirements": str(run_dir / "requirements.md"),
        "modelJson": str(run_dir / "model.json"),
        "step": str(run_dir / "model.step"),
        "stl": str(run_dir / "model.stl"),
        "freecad": str(run_dir / "model.FCStd"),
        "images": [
            str(run_dir / "render-isometric.png"),
            str(run_dir / "render-front.png"),
            str(run_dir / "render-top.png"),
            str(run_dir / "render-right.png"),
        ],
    }
    manifest = {
        "schemaVersion": 1,
        "publishedAt": int(time.time()),
        "runDir": str(run_dir),
        "artifacts": artifacts,
        "validation": json.loads((run_dir / "validation.json").read_text(encoding="utf-8")),
    }
    manifest_path = run_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    manifest["manifest"] = str(manifest_path)
    return manifest


def image_path(job_dir: Path, view: str) -> dict[str, Any]:
    if not re.fullmatch(r"isometric|front|top|right", view):
        raise RunnerError(f"unsupported view: {view}")
    run_dir = _read_latest_run(job_dir)
    path = run_dir / f"render-{view}.png"
    if not path.is_file():
        raise RunnerError(f"render is missing: {path}")
    return {"ok": True, "view": view, "path": str(path)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Controlled SimpleCADAPI job runner")
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--job-dir", required=True)
    run_parser.add_argument("--timeout", type=int, default=int(os.environ.get("CADIR_RUN_TIMEOUT_SECONDS", "180")))
    publish_parser = subparsers.add_parser("publish")
    publish_parser.add_argument("--job-dir", required=True)
    image_parser = subparsers.add_parser("image")
    image_parser.add_argument("--job-dir", required=True)
    image_parser.add_argument("--view", required=True)
    probe_parser = subparsers.add_parser("probe")
    probe_parser.add_argument("--job-dir", required=True)
    probe_parser.add_argument("--timeout", type=int, default=10)
    args = parser.parse_args()

    try:
        job_dir = resolve_job_dir(args.job_dir)
        if args.command == "run":
            result = run_model(job_dir, max(10, min(args.timeout, 600)))
        elif args.command == "publish":
            result = publish_model(job_dir)
        elif args.command == "image":
            result = image_path(job_dir, args.view)
        else:
            result = run_probe(job_dir, sys.stdin.read(MAX_PROBE_CHARS + 1), max(1, min(args.timeout, 15)))
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except (RunnerError, OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
