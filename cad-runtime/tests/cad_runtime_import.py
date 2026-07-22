import importlib.util
from pathlib import Path


def load_runner():
    path = Path(__file__).resolve().parents[1] / "cadir_runner.py"
    spec = importlib.util.spec_from_file_location("cadir_runner", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load cadir_runner")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
