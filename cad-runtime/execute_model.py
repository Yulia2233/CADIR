from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
from typing import Any

import simplecadapi as scad

try:
    translate_model_json_to_fcstd = scad.translate_model_json_to_fcstd
except AttributeError:
    # The provided 2.0.1b1 source implements this documented public API but
    # omits its top-level re-export.
    from simplecadapi.translator.freecad_translator import translate_model_json_to_fcstd


def _load_build_model(source: Path):
    spec = importlib.util.spec_from_file_location("cadir_generated_model", source)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load generated model.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    build_model = getattr(module, "build_model", None)
    if not callable(build_model):
        raise RuntimeError("model.py must expose callable build_model()")
    return build_model


def _validate_result(result: Any) -> tuple[Any, Any]:
    if not isinstance(result, tuple) or len(result) != 2:
        raise RuntimeError("build_model() must return (final_shape, graph_session)")
    final_shape, session = result
    if not isinstance(session, scad.GraphSession):
        raise RuntimeError("build_model() second value must be GraphSession")
    if not hasattr(final_shape, "get_volume"):
        raise RuntimeError("build_model() first value must be a Solid")
    volume = float(final_shape.get_volume())
    if volume <= 0:
        raise RuntimeError("final Solid must have positive volume")
    return final_shape, session


def build_outputs(source: Path, output_dir: Path) -> dict[str, Any]:
    final_shape, session = _validate_result(_load_build_model(source)())
    model_json = scad.export_model_json(session)
    rebuilt = scad.replay_model_json(model_json, strict=True)
    if not rebuilt:
        raise RuntimeError("strict canonical model replay produced no shapes")

    (output_dir / "model.json").write_text(model_json, encoding="utf-8")
    scad.export_step(final_shape, str(output_dir / "model.step"))
    scad.export_stl(final_shape, str(output_dir / "model.stl"))

    views = {
        "isometric": "isometric",
        "front": "front",
        "top": "top",
        "right": "right",
    }
    image_paths = {}
    for name, view in views.items():
        image_paths[name] = scad.render_screenshot_rpath(
            final_shape,
            str(output_dir / f"render-{name}.png"),
            image_size=(1400, 900),
            view=view,
            show_axes=True,
            show_legend=True,
        )

    freecad_path = translate_model_json_to_fcstd(
        model_json,
        str(output_dir / "model.FCStd"),
        document_name="CADIRModel",
        freecad_cmd=os.environ.get("CADIR_FREECAD_CMD", "FreeCADCmd"),
    )
    validation = {
        "volume": float(final_shape.get_volume()),
        "faceCount": len(final_shape.get_faces()),
        "edgeCount": len(final_shape.get_edges()),
        "replayObjectCount": len(rebuilt),
        "freecadPath": str(freecad_path),
        "images": image_paths,
    }
    (output_dir / "validation.json").write_text(json.dumps(validation, indent=2), encoding="utf-8")
    print(
        f"CADIR_VALIDATION volume={validation['volume']:.6f} "
        f"faces={validation['faceCount']} replay={validation['replayObjectCount']}"
    )
    return validation


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    build_outputs(args.source.resolve(), args.output_dir.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
