import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import type { CreateMessageRequest, ModelSettings, Stage, StageTransitionRequest } from "../../../packages/contracts/src/index.js";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import type { OpenCodeAdapter } from "./opencode.js";
import type { RetrievalAdapter } from "./retrieval.js";
import { CadirService } from "./service.js";
import { JsonStore } from "./store.js";

const integer = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

export interface BuildAppOptions { config: AppConfig; adapter: OpenCodeAdapter; retrieval?: RetrievalAdapter; store?: JsonStore }

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: { redact: ["req.headers.authorization", "req.headers.x-internal-token"] } });
  await app.register(cors, { origin: options.config.corsOrigin });
  await app.register(multipart, { limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 0 } });
  const store = options.store ?? new JsonStore(options.config.dataFile);
  await store.init();
  const service = new CadirService(store, options.adapter, options.config, options.retrieval);
  app.decorate("cadirService", service);

  app.setErrorHandler((error, _request, reply) => {
    const multipartError = (error as any).code === "FST_REQ_FILE_TOO_LARGE"
      ? new AppError(413, "IMAGE_TOO_LARGE", "image exceeds the 10 MiB limit") : undefined;
    const appError = error instanceof AppError ? error : multipartError ?? new AppError(500, "INTERNAL_ERROR", "Internal server error");
    if (!(error instanceof AppError)) app.log.error({ err: error }, "request failed");
    void reply.status(appError.statusCode).send({ error: { code: appError.code, message: appError.message } });
  });

  app.get("/api/health", async () => ({ healthy: true, openCodeHealthy: await options.adapter.health(), retrievalHealthy: await service.retrievalHealthy(), serverTime: new Date().toISOString() }));
  app.post<{ Body: { title?: string } }>("/api/conversations", async (request, reply) => reply.code(201).send(await service.createConversation(request.body?.title)));
  app.get("/api/conversations", async () => ({ conversations: service.listConversations() }));
  app.get("/api/settings", async () => await service.getModelSettings());
  app.patch<{ Body: Partial<ModelSettings> }>("/api/settings", async (request) => await service.updateModelSettings(request.body ?? {}));
  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (request) => {
    const conversation = service.getConversation(request.params.id);
    return { conversation, snapshot: conversation.latestJobId ? service.getSnapshot(conversation.latestJobId) : null };
  });
  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (request) => {
    return await service.deleteConversation(request.params.id);
  });
  app.post<{ Params: { id: string }; Body: CreateMessageRequest }>("/api/conversations/:id/messages", async (request, reply) => {
    const snapshot = await service.submitMessage(request.params.id, request.body);
    return reply.code(202).send({ jobId: snapshot.job.id, snapshot });
  });
  app.post<{ Params: { id: string } }>("/api/conversations/:id/uploads", async (request, reply) => {
    const file = await request.file();
    if (!file || file.fieldname !== "file") throw new AppError(400, "IMAGE_FILE_REQUIRED", "multipart field 'file' is required");
    const upload = await service.createUpload(request.params.id, { filename: file.filename, mimeType: file.mimetype, data: await file.toBuffer() });
    return reply.code(201).send({ upload, artifactId: upload.id });
  });
  app.get<{ Params: { uploadId: string } }>("/api/uploads/:uploadId/download", async (request, reply) => {
    const { upload, stream } = service.uploadDownload(request.params.uploadId);
    reply.header("content-type", upload.mimeType).header("content-length", upload.size).header("content-disposition", `inline; filename="${upload.name.replace(/["\r\n]/g, "_")}"`);
    return reply.send(stream);
  });
  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (request) => service.getSnapshot(request.params.jobId));
  app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/cancel", async (request) => service.cancel(request.params.jobId));
  app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/retry", async (request) => service.retryJob(request.params.jobId));
  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId/artifacts", async (request) => ({ artifacts: service.listArtifacts(request.params.jobId) }));
  app.get<{ Params: { jobId: string; artifactId: string } }>("/api/jobs/:jobId/artifacts/:artifactId/download", async (request, reply) => {
    const { artifact, stream } = service.artifactDownload(request.params.jobId, request.params.artifactId);
    // Artifact metadata can describe a prior revision of a workspace file. Do
    // not advertise a stale content length; the stream's actual EOF is the
    // authoritative boundary for downloads.
    reply.header("content-type", artifact.mimeType).header("content-disposition", `attachment; filename="${artifact.name.replace(/["\r\n]/g, "_")}"`);
    return reply.send(stream);
  });

  app.get<{ Params: { jobId: string }; Querystring: { after?: string } }>("/api/jobs/:jobId/events", async (request, reply) => {
    const jobId = request.params.jobId;
    let cursor = integer(request.query.after ?? request.headers["last-event-id"]);
    service.getSnapshot(jobId);
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform",
      connection: "keep-alive", "x-accel-buffering": "no",
    });
    let replaying = true;
    const pending: ReturnType<typeof service.eventsAfter> = [];
    const write = (event: ReturnType<typeof service.eventsAfter>[number]): void => {
      if (event.seq <= cursor || response.destroyed) return;
      if (!response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) response.destroy();
      cursor = event.seq;
    };
    const unsubscribe = store.subscribe(jobId, (event) => replaying ? pending.push(event) : write(event));
    for (const event of service.eventsAfter(jobId, cursor)) write(event);
    replaying = false;
    pending.sort((a, b) => a.seq - b.seq).forEach(write);
    const heartbeat = setInterval(() => {
      if (response.destroyed) return;
      try {
        const snapshot = service.getSnapshot(jobId);
        if (!response.write(`event: heartbeat\ndata: ${JSON.stringify({ serverTime: snapshot.serverTime, jobStatus: snapshot.job.status, lastSeq: snapshot.lastSeq, backendHealthy: true })}\n\n`)) response.destroy();
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
        response.end();
      }
    }, options.config.heartbeatMs);
    const close = (): void => { clearInterval(heartbeat); unsubscribe(); if (!response.destroyed) response.end(); };
    request.raw.once("close", close);
  });

  const requireInternal = (headers: Record<string, unknown>): void => {
    const expected = process.env.INTERNAL_API_TOKEN;
    if (expected && headers["x-internal-token"] !== expected) throw new AppError(401, "UNAUTHORIZED", "invalid internal token");
  };
  type AgentStageBody = {
    sessionID?: string; sessionId?: string; stage: Stage | "visual_feedback";
    action?: StageTransitionRequest["action"] | "failed"; state?: StageTransitionRequest["action"] | "failed";
    summary?: string; message?: string; error?: { code: string; message: string };
  };
  app.post<{ Body: AgentStageBody }>("/internal/stage-transition", async (request) => {
    requireInternal(request.headers);
    const body = request.body;
    const action = body.action ?? body.state;
    if (!body.sessionID && !body.sessionId) throw new AppError(400, "SESSION_ID_REQUIRED", "sessionID is required");
    if (!action) throw new AppError(400, "ACTION_REQUIRED", "stage action is required");
    return service.transition({
      sessionID: body.sessionID ?? body.sessionId!,
      stage: body.stage === "visual_feedback" ? "visual" : body.stage,
      action: action === "failed" ? "fail" : action,
      summary: body.summary ?? body.message,
      error: body.error,
    });
  });
  app.post<{ Body: { sessionID: string; path: string; kind: any; mimeType?: string; validated?: boolean; partial?: boolean } }>("/internal/artifacts", async (request, reply) => {
    requireInternal(request.headers);
    return reply.code(201).send(await service.registerArtifact(request.body));
  });
  app.post<{ Body: { sessionID: string; query: string; topK?: number; includeImages?: boolean } }>("/internal/retrieve", async (request) => {
    requireInternal(request.headers);
    return await service.retrieveCases(request.body);
  });
  app.post<{ Body: { sessionID: string; caseId: string; subgraphId?: string; include?: string[] } }>("/internal/retrieved-case", async (request) => {
    requireInternal(request.headers);
    return await service.readRetrievedCase(request.body);
  });
  service.resumePendingIndexing();
  return app;
}

declare module "fastify" {
  interface FastifyInstance { cadirService: CadirService }
}
