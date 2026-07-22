from __future__ import annotations

import builtins
import json
import sys
import traceback


ALLOWED_IMPORT_ROOTS = {"math", "simplecadapi"}
MAX_OUTPUT_CHARS = 12 * 1024


class OutputLimitExceeded(RuntimeError):
    pass


class CappedText:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.parts: list[str] = []
        self.length = 0

    def write(self, value: object) -> int:
        text = str(value)
        remaining = self.limit - self.length
        if remaining <= 0:
            raise OutputLimitExceeded(f"probe output exceeded {self.limit} characters")
        self.parts.append(text[:remaining])
        self.length += min(len(text), remaining)
        if len(text) > remaining:
            raise OutputLimitExceeded(f"probe output exceeded {self.limit} characters")
        return len(text)

    def flush(self) -> None:
        return None

    def value(self) -> str:
        return "".join(self.parts)


def safe_import(name: str, globals=None, locals=None, fromlist=(), level: int = 0):
    root = name.split(".", 1)[0]
    if level != 0 or root not in ALLOWED_IMPORT_ROOTS:
        raise ImportError(f"blocked import: {name}")
    return builtins.__import__(name, globals, locals, fromlist, level)


SAFE_BUILTINS = {
    "__build_class__": builtins.__build_class__,
    "__import__": safe_import,
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "callable": callable,
    "dict": dict,
    "dir": dir,
    "enumerate": enumerate,
    "Exception": Exception,
    "float": float,
    "hasattr": hasattr,
    "int": int,
    "isinstance": isinstance,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "print": print,
    "range": range,
    "repr": repr,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "type": type,
    "ValueError": ValueError,
    "zip": zip,
}


def main() -> int:
    source = sys.stdin.read()
    original_stdout = sys.stdout
    stdout = CappedText(MAX_OUTPUT_CHARS)
    stderr = CappedText(MAX_OUTPUT_CHARS)
    ok = True
    error = None
    try:
        sys.stdout = stdout
        sys.stderr = stderr
        scope = {"__builtins__": SAFE_BUILTINS, "__name__": "__cadir_probe__"}
        exec(compile(source, "<cadir-python-probe>", "exec"), scope, scope)
    except BaseException as exc:  # The worker converts probe failures into structured diagnostics.
        ok = False
        error = f"{type(exc).__name__}: {exc}"
        if not isinstance(exc, OutputLimitExceeded):
            try:
                traceback.print_exc(file=stderr)
            except OutputLimitExceeded:
                error = f"{error}; traceback truncated"
    finally:
        sys.stdout = original_stdout

    original_stdout.write(json.dumps({
        "ok": ok,
        "stdout": stdout.value(),
        "stderr": stderr.value(),
        "error": error,
    }, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
