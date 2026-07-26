# Runtime Verification

## Build contract

- OpenCode is pinned to `opencode-ai@1.18.3` and starts with
  `opencode serve --hostname 0.0.0.0 --port 4096`.
- The local `SimpleCADAPI-master.zip` file contains the pinned
  `So3Lab/CADIR` dev source at commit
  `787a77df93dc446b5d9fb01e7fe2f615d3433334`; Docker installs its
  `CADIR-dev` package. The same source bundle provides the complete
  project-level `simplecadapi` skill.
- Debian's `freecad` package supplies `/usr/bin/freecadcmd`. The runtime passes
  that executable to public `translate_model_json_to_fcstd`.
- The supplied 2.0.1b1 ZIP documents that translator as a top-level export but
  omits it from `__init__.py`; the worker falls back to the same documented
  implementation in `simplecadapi.translator.freecad_translator`.
- The LLM key is read only from `CADIR_LLM_API_KEY` in the server environment.
  `opencode.json` uses `{env:CADIR_LLM_API_KEY}` and contains no credential.

## Rendering contract

`cad-runtime/execute_model.py` is the only renderer. It calls public
`render_screenshot_rpath` exactly once for each of `isometric`, `front`, `top`,
and `right`. No alternate rendering dependency or hand-written renderer exists.

## Archive contract

The API mounts `/workspace/rag-library` from the independent
`cadir-rag-library` volume. A successful final evolution creates
`entries/<jobId>/manifest.json` together with `model.py`, `model.json`, four
renders, `summary.md`, and `experience.md`. Deleting the source conversation
removes its job directory while leaving this archive entry intact. The current
release does not build embeddings, an index, or a retrieval path.

## Local checks

Run static tests without CAD dependencies:

```sh
python -m unittest discover -s cad-runtime/tests -v
python -m py_compile cad-runtime/cadir_runner.py cad-runtime/probe_worker.py cad-runtime/execute_model.py
docker compose config
```

Run the complete CAD smoke test inside the built runtime image:

```sh
docker compose build opencode
docker compose run --rm --no-deps \
  -v ./cad-runtime/examples:/workspace/jobs/smoke \
  opencode python3 /app/cad-runtime/cadir_runner.py run \
  --job-dir /workspace/jobs/smoke
```

The smoke test is successful only when it creates `model.json`, `model.step`,
`model.stl`, `model.FCStd`, four PNG views, and `validation.json`.

OpenCode port 4096 is exposed only to the Compose network. It is intentionally
not published on the Docker host; browsers communicate through the BFF.

## Verified 2026-07-23

- Replaced the runtime bundle and Agent skill with the trusted
  `So3Lab/CADIR` dev snapshot at commit
  `787a77df93dc446b5d9fb01e7fe2f615d3433334`.
- The runtime bundle exposes `apply_tag_rselection`, physical units, and
  tolerance graph APIs; the skill bundle includes their generated reference
  pages.

## Previous verification (2026-07-20)

- Built `cadir-opencode:latest` successfully with OpenCode 1.18.3, SimpleCADAPI
  2.0.1b1, cadquery-ocp 7.9.3.1.1, and Debian FreeCAD 0.20.2.
- Ran the example through the container runner and strict canonical replay.
  Validation reported volume `23830.353996706144`, 7 faces, 15 edges, and one
  replayed result.
- Generated non-empty JSON, STEP, STL, FCStd, four PNG views, validation, and
  publish manifest files. The FCStd output was 5883 bytes.
- Started the OpenCode server and verified `/global/health` reported version
  1.18.3, the only selectable non-system primary agent was `cadir-agent`, and
  all four `cadir_*` custom tools were registered.
- Started API and OpenCode together with Compose; API health reported both
  `healthy: true` and `openCodeHealthy: true` through the internal network.
- Verified both containers use UID/GID 10001: a job directory created by the API
  was writable by OpenCode. Also verified a fresh named OpenCode data volume was
  writable by UID/GID 10001.
- Five runner unit tests, Python bytecode compilation, 15 API tests, API
  TypeScript checking, and `docker compose config --quiet` passed.
- A live GPT-5.6 Sol request completed all four single-agent stages and published
  11 validated artifacts: requirements, Python, canonical JSON, STEP, STL,
  FCStd, four PNG views, and the final manifest.
- FreeCADCmd reopened the live artifacts successfully. The STEP contained one
  valid solid with volume 23321.416 mm3; the STL had 120 facets and an
  80 x 50 x 6 mm bounding box.
- Usage reconciliation recovered the live OpenCode session totals after API
  restart: 51,570 input, 4,130 output, 758 reasoning, 399,360 cache-read, and
  455,818 total tokens.
- The custom model declares text and image input modalities. After restart,
  OpenCode reported `capabilities.input.image: true`. A live read-tool probe on
  an isometric cylinder render correctly described the gray vertical cylinder
  and black background, proving pixels reached the model instead of only
  returning the file-level `Image read successfully` status.
- The BFF rejects `visual: complete` with `MODEL_IMAGE_INPUT_UNSUPPORTED` when
  OpenCode does not advertise image input, preventing false-positive visual
  acceptance for custom providers with missing modality metadata.
- OpenCode registered `cadir_python_probe` alongside the four workflow tools.
  A container probe imported SimpleCADAPI, constructed a box, and confirmed
  `Query.all()` in 744 ms. Python exceptions returned structured tracebacks,
  blocked imports were rejected before execution, a busy loop timed out, and
  no probe temporary directory or artifact remained afterward.

- The live OpenCode provider currently exposes the image-capable CAD models
  `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, and `gpt-5.6-terra`. Each is
  configured with `low`, `medium`, and `high` variants mapped to
  `reasoningEffort`; `/api/settings` filters its response against live
  `/provider` data.
