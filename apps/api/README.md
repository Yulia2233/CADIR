# CADIR API

Fastify BFF for the single-agent CADIR workflow. It owns the authoritative conversation/job state, persists every business event before broadcasting it, and proxies no credentials to the browser.

## Run

```bash
npm install
npm run dev
```

Copy environment names from `.env.example` into the deployment environment. Do not put credentials in `.env.example` or source control. `CADIR_LLM_API_KEY` and `CADIR_LLM_BASE_URL` are server-only values consumed by the OpenCode container/provider configuration; this BFF does not read, persist, log, or send them to a browser.

The default OpenCode model selection is provider `cadir`, model `gpt-5.6-sol`. Override it with `OPENCODE_MODEL_PROVIDER` and `CADIR_MODEL_ID`.

Without `OPENCODE_URL`, message submission is persisted and then moves to a terminal `failed` state with `OPENCODE_UNAVAILABLE`. Tests inject a fake adapter and need no model credentials.

## HTTP contract

- `POST /api/conversations`, `GET /api/conversations`, `GET /api/conversations/:id`
- `POST /api/conversations/:id/messages`
- `POST /api/conversations/:id/uploads` (`multipart/form-data`, field `file`, PNG/JPEG/WebP, 10 MiB maximum)
- `GET /api/uploads/:uploadId/download`
- `GET /api/jobs/:jobId`, `POST /api/jobs/:jobId/cancel`, `POST /api/jobs/:jobId/retry`
- `GET /api/jobs/:jobId/events?after=<seq>` (SSE replay followed by live events and heartbeat)
- `GET /api/jobs/:jobId/artifacts`, `GET /api/jobs/:jobId/artifacts/:artifactId/download`
- `POST /internal/stage-transition`, `POST /internal/artifacts`

Set `INTERNAL_API_TOKEN` in production. Internal callers then send it in `x-internal-token`. A stage transition is accepted only for the active job bound to the caller's OpenCode `sessionID`.

The requirements stage can only complete after a validated artifact named exactly `requirements.md` passes the UTF-8 and required-section checks. Codegen requires validated artifacts named exactly `model.py` and `model.json`. Visual feedback requires `render-isometric.png`, `render-front.png`, `render-top.png`, and `render-right.png`, all validated and registered against the current visual `StageRun`; uploaded reference images and renders from older attempts do not satisfy this guard. Final evolution requires validated `.step`, `.stl`, `.FCStd`, and `manifest.json` artifacts.

## Reconnect behavior

The browser first requests `GET /api/jobs/:jobId`, replaces local job state, then connects to the event endpoint using the snapshot's `lastSeq` as `after`. Events have stable IDs and monotonically increasing per-job sequence numbers. The SSE route registers a live buffer before reading replay events, so events committed during the handoff are delivered once and in order. Browser disconnect never cancels a job.

Run verification with:

```bash
npm test
npm run typecheck
```
