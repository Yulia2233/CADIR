import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cad_runtime_import import load_runner


runner = load_runner()


class RunnerValidationTests(unittest.TestCase):
    def test_accepts_simplecad_build_model(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "model.py"
            source.write_text(
                "import simplecadapi as scad\n"
                "def build_model():\n"
                "    return scad.make_box_rsolid(1, 1, 1), scad.GraphSession()\n",
                encoding="utf-8",
            )
            runner.validate_model_source(source)

    def test_rejects_os_import(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "model.py"
            source.write_text("import os\ndef build_model():\n    pass\n", encoding="utf-8")
            with self.assertRaisesRegex(runner.RunnerError, "blocked import"):
                runner.validate_model_source(source)

    def test_rejects_open(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "model.py"
            source.write_text("def build_model():\n    return open('x')\n", encoding="utf-8")
            with self.assertRaisesRegex(runner.RunnerError, "blocked call"):
                runner.validate_model_source(source)

    def test_probe_accepts_focused_simplecadapi_diagnostics(self):
        runner.validate_probe_source(
            "import simplecadapi as scad\n"
            "query = scad.ql.select(items=[])\n"
            "print(type(query), hasattr(query, 'all'))\n"
        )

    def test_probe_rejects_file_process_and_dunder_access(self):
        blocked = (
            "import os\n",
            "open('result.txt', 'w')\n",
            "value.__class__\n",
            "shape.write_text('result.txt')\n",
            "from simplecadapi import export_step\nexport_step([], 'result.step')\n",
        )
        for source in blocked:
            with self.subTest(source=source):
                with self.assertRaises(runner.RunnerError):
                    runner.validate_probe_source(source)

    def test_job_path_cannot_escape_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "jobs"
            root.mkdir()
            with patch.dict(os.environ, {"CADIR_JOBS_ROOT": str(root)}):
                with self.assertRaisesRegex(runner.RunnerError, "escapes"):
                    runner.resolve_job_dir(str(Path(temporary) / "outside"))

    def test_publish_manifest_contains_required_cad_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            job = Path(temporary) / "job"
            run_dir = job / ".cadir" / "runs" / "test-run"
            run_dir.mkdir(parents=True)
            for name in runner.REQUIRED_OUTPUTS:
                content = "{}" if name == "validation.json" else "fixture"
                (run_dir / name).write_text(content, encoding="utf-8")
            (job / ".cadir" / "latest-run.json").write_text(
                '{"runId":"test-run","relativeRunDir":".cadir/runs/test-run"}',
                encoding="utf-8",
            )
            manifest = runner.publish_model(job)
            self.assertTrue(Path(manifest["artifacts"]["step"]).is_file())
            self.assertTrue(Path(manifest["artifacts"]["freecad"]).is_file())
            self.assertEqual(Path(manifest["artifacts"]["requirements"]).name, "requirements.md")
            self.assertTrue(Path(manifest["manifest"]).is_file())


if __name__ == "__main__":
    unittest.main()
