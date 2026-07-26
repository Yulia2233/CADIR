import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelOption } from "../../../packages/contracts/src/index.js";
import type { AppConfig } from "../src/config.js";
import type { OpenCodeAdapter, OpenCodeEvent, OpenCodeSession, PromptModel } from "../src/opencode.js";
import type {
  CaseIndexRequest, HybridRetrievalQueryOptions, IndexTaskResponse, RetrievalAdapter, RetrievalQueryOptions, RetrievalResponse,
} from "../src/retrieval.js";
import { CadirService } from "../src/service.js";
import { JsonStore } from "../src/store.js";
import { OpenCodeEventSupervisor } from "../src/supervisor.js";

const validRequirements = `# \u5efa\u6a21\u9700\u6c42

## \u5bf9\u8c61
Spacer
## \u5355\u4f4d
mm
## \u5c3a\u5bf8
10 x 5 mm
## \u529f\u80fd\u4e0e\u51e0\u4f55\u7ea6\u675f
Concentric bore
## \u5047\u8bbe
Nominal tolerance
## \u5efa\u6a21\u6b65\u9aa4
1. Build body
## \u9a8c\u6536\u68c0\u67e5
Check dimensions
## \u5f85\u786e\u8ba4\u4fe1\u606f
None
`;

class FakeAdapter implements OpenCodeAdapter {
  prompts: Array<{ sessionId: string; content: string; model?: PromptModel }> = [];
  aborted: string[] = [];
  statuses: Record<string, unknown> = {};
  messageList: unknown[] = [];
  failCreate = false;
  imageInputSupported = true;
  async health(): Promise<boolean> { return true; }
  async supportsImageInput(): Promise<boolean> { return this.imageInputSupported; }
  async availableModels(): Promise<ModelOption[]> { return ["gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"].map((id) => ({ id, label: id, providerId: "cadir", imageInput: true, efforts: ["low", "medium", "high"] })); }
  async createSession(): Promise<OpenCodeSession> {
    if (this.failCreate) throw new Error(`provider rejected ${"s" + "k"}-secret-value`);
    return { id: "session-1" };
  }
  async prompt(sessionId: string, content: string, _directory: string, model?: PromptModel): Promise<void> { this.prompts.push({ sessionId, content, model }); }
  async abort(sessionId: string): Promise<void> { this.aborted.push(sessionId); }
  async deleteSession(sessionId: string): Promise<void> { this.aborted.push(`delete:${sessionId}`); }
  async sessionStatus(): Promise<Record<string, unknown>> { return this.statuses; }
  async messages(): Promise<unknown[]> { return this.messageList; }
  async *events(): AsyncIterable<OpenCodeEvent> { await new Promise(() => undefined); }
}

class FakeRetrievalAdapter implements RetrievalAdapter {
  textCalls: Array<{ query: string; options: RetrievalQueryOptions }> = [];
  hybridCalls: Array<{ query: string; options: HybridRetrievalQueryOptions }> = [];
  imageCalls: Array<{ filename: string; options: RetrievalQueryOptions }> = [];
  indexCalls: CaseIndexRequest[] = [];
  failQueries = false;
  async health(): Promise<boolean> { return true; }
  async retrieveText(query: string, options: RetrievalQueryOptions): Promise<RetrievalResponse> {
    this.textCalls.push({ query, options });
    if (this.failQueries) throw new Error("retrieval offline");
    return {
      results: [
        { caseId: "case-a", rank: 1, matchKind: "full", summary: "Full plate" },
        { caseId: "case-b", rank: 2, matchKind: "subgraph", summary: "Bracket feature", subgraphMatches: [{ subgraphId: "sub-b", nodeCount: 12, score: 0.8 }] },
      ],
    };
  }
  async retrieveHybrid(query: string, options: HybridRetrievalQueryOptions): Promise<RetrievalResponse> {
    this.hybridCalls.push({ query, options });
    if (this.failQueries) throw new Error("hybrid retrieval offline");
    return {
      requestedTextTopK: options.textTopK,
      requestedSubgraphTopK: options.subgraphTopK,
      results: [
        {
          caseId: "case-hybrid-both", rank: 1, matchKind: "summary_text+subgraph",
          provenance: ["summary_text", "subgraph"], textScore: 0.92, subgraphScore: 0.81,
          summary: "A summary and subgraph match", subgraphMatches: [{ subgraphId: "sub-hybrid", score: 0.81 }],
        },
        {
          caseId: "case-hybrid-text", rank: 2, matchKind: "summary_text",
          provenance: ["summary_text"], textScore: 0.88, summary: "A summary-only match",
        },
      ],
    };
  }
  async retrieveImage(image: { bytes: Uint8Array; filename: string }, options: RetrievalQueryOptions): Promise<RetrievalResponse> {
    this.imageCalls.push({ filename: image.filename, options });
    if (this.failQueries) throw new Error("image retrieval offline");
    return {
      results: [
        { caseId: "case-a", rank: 1, matchKind: "subgraph", summary: "Full plate", subgraphMatches: [{ subgraphId: "sub-a", nodeCount: 8, score: 0.9 }] },
        { caseId: "case-c", rank: 2, matchKind: "full", summary: "Image-similar case" },
      ],
    };
  }
  async indexCase(input: CaseIndexRequest): Promise<IndexTaskResponse> {
    this.indexCalls.push(input);
    return { taskId: `task-${input.revision}`, status: "ready" };
  }
  async indexTask(taskId: string): Promise<IndexTaskResponse> { return { taskId, status: "ready" }; }
  async readCase(caseId: string, options?: { subgraphId?: string; include?: string[] }): Promise<Record<string, unknown>> {
    return { caseId, summary: "A reinforced plate with a reusable bracket feature", ...options };
  }
}

async function fixture(options: { retrievalUrl?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "cadir-api-"));
  const jobsRoot = join(root, "jobs");
  await mkdir(jobsRoot);
  const config: AppConfig = {
    host: "127.0.0.1", port: 0, dataFile: join(root, "db.json"), jobsRoot, ragLibraryRoot: join(root, "rag-library"),
    corsOrigin: "*", heartbeatMs: 50, watchdogMs: 1_000, failureGraceMs: 0, openCodeUrl: "http://fake",
    openCodeUsername: "opencode", openCodeAgent: "cadir-agent", modelProvider: "cadir", modelId: "gpt-5.6-sol",
    retrievalUrl: options.retrievalUrl,
  };
  const store = new JsonStore(config.dataFile);
  await store.init();
  const adapter = new FakeAdapter();
  const retrieval = new FakeRetrievalAdapter();
  const service = new CadirService(store, adapter, config, retrieval);
  return { root, jobsRoot, config, store, adapter, retrieval, service };
}

test("creates an authoritative running snapshot and replayable monotonic events", async () => {
  const { service, adapter } = await fixture();
  const conversation = await service.createConversation();
  const snapshot = await service.submitMessage(conversation.id, { content: "Create a mounting bracket" });
  assert.equal(snapshot.job.status, "running");
  assert.equal(snapshot.job.currentStage, "requirements");
  assert.equal(snapshot.stageRuns[0].status, "running");
  assert.equal(snapshot.messages[0].content, "Create a mounting bracket");
  assert.deepEqual(service.eventsAfter(snapshot.job.id, 0).map((event) => event.seq), [1, 2]);
  assert.equal(service.eventsAfter(snapshot.job.id, 1)[0].seq, 2);
  assert.equal(adapter.prompts[0].sessionId, "session-1");
});

test("model settings use available image-capable models and snapshot onto new jobs", async () => {
  const { service, adapter } = await fixture();
  const available = await service.getModelSettings();
  assert.deepEqual(available.models.map((item) => item.id), ["gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);
  const updated = await service.updateModelSettings({ modelId: "gpt-5.5", effort: "high" });
  assert.deepEqual(updated.settings, {
    modelId: "gpt-5.5", effort: "high", selfEvolutionEnabled: true, retrievalMode: "full_and_subgraph", retrievalPool: "both",
    subgraphMaxNodes: 16, retrievalTextTopK: 5, retrievalSubgraphTopK: 5,
  });
  const conversation = await service.createConversation();
  const snapshot = await service.submitMessage(conversation.id, { content: "Use the selected model" });
  assert.deepEqual({ modelId: snapshot.job.modelId, modelProvider: snapshot.job.modelProvider, effort: snapshot.job.effort }, { modelId: "gpt-5.5", modelProvider: "cadir", effort: "high" });
  assert.equal(snapshot.job.selfEvolutionEnabled, true);
  assert.deepEqual({
    retrievalMode: snapshot.job.retrievalMode, retrievalPool: snapshot.job.retrievalPool,
    subgraphMaxNodes: snapshot.job.subgraphMaxNodes, retrievalTextTopK: snapshot.job.retrievalTextTopK,
    retrievalSubgraphTopK: snapshot.job.retrievalSubgraphTopK,
  }, {
    retrievalMode: "full_and_subgraph", retrievalPool: "both", subgraphMaxNodes: 16,
    retrievalTextTopK: 5, retrievalSubgraphTopK: 5,
  });
  assert.deepEqual(adapter.prompts.at(-1)?.model, { modelId: "gpt-5.5", providerId: "cadir", effort: "high" });
  await assert.rejects(service.updateModelSettings({ modelId: "gpt-5.6", effort: "medium" }), (error: any) => error.code === "MODEL_NOT_ALLOWED");
  await assert.rejects(service.updateModelSettings({ modelId: "gpt-5.5", effort: "xhigh" as any }), (error: any) => error.code === "EFFORT_INVALID");
  await assert.rejects(service.updateModelSettings({ retrievalTextTopK: 0 }), (error: any) => error.code === "RETRIEVAL_TEXT_TOP_K_INVALID");
  await assert.rejects(service.updateModelSettings({ retrievalSubgraphTopK: 101 }), (error: any) => error.code === "RETRIEVAL_SUBGRAPH_TOP_K_INVALID");
});

test("hybrid retrieval uses configured summary-text and subgraph counts in one backend call", async () => {
  const { service, retrieval, adapter } = await fixture();
  await service.updateModelSettings({
    retrievalMode: "hybrid", retrievalPool: "base", retrievalTextTopK: 2,
    retrievalSubgraphTopK: 3, subgraphMaxNodes: 20,
  });
  const conversation = await service.createConversation();
  const snapshot = await service.submitMessage(conversation.id, { content: "Create a reinforced flange" });
  const response = await service.retrieveCases({
    sessionID: snapshot.job.openCodeSessionId!, query: "reinforced flange", includeImages: true, topK: 9,
  });

  assert.equal(retrieval.hybridCalls.length, 1);
  assert.equal(retrieval.textCalls.length, 0);
  assert.equal(retrieval.imageCalls.length, 0);
  assert.deepEqual(retrieval.hybridCalls[0].options.sources, ["base"]);
  assert.equal(retrieval.hybridCalls[0].options.textTopK, 2);
  assert.equal(retrieval.hybridCalls[0].options.subgraphTopK, 3);
  assert.equal(retrieval.hybridCalls[0].options.subgraphMaxNodes, 20);
  assert.equal(response.requestedTextTopK, 2);
  assert.equal(response.requestedSubgraphTopK, 3);
  assert.equal(response.requestedTopK, 5);
  assert.equal(response.returnedCount, 2);
  assert.equal(response.partial, true);
  assert.match(adapter.prompts.at(-1)?.content ?? "", /hybrid retrieval: 2 summary-text Cases plus 3 3D-subgraph Cases/);
  const completed = service.eventsAfter(snapshot.job.id, 0).find((event) => event.type === "retrieval.completed");
  assert.equal(completed?.data.textTopK, 2);
  assert.equal((completed?.data.cases as Array<Record<string, unknown>>)[0].matchKind, "summary_text+subgraph");
  assert.match(service.getSnapshot(snapshot.job.id).stageRuns[0].toolActivities?.[0].summary ?? "", /summary_text\+subgraph/);
});

test("retrieval settings drive pool-scoped multimodal unique Case results and scoped Case reads", async () => {
  const { service, retrieval, adapter, config } = await fixture();
  await service.updateModelSettings({ retrievalMode: "full_and_subgraph", retrievalPool: "dynamic", subgraphMaxNodes: 24 });
  const conversation = await service.createConversation();
  const upload = await service.createUpload(conversation.id, {
    filename: "reference.png", mimeType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  });
  const snapshot = await service.submitMessage(conversation.id, {
    content: "Create a plate with a reinforced bracket", imageArtifactIds: [upload.id],
  });
  const response = await service.retrieveCases({
    sessionID: snapshot.job.openCodeSessionId!, query: "reinforced plate bracket", includeImages: true, topK: 5,
  });
  const results = response.results as Array<Record<string, any>>;
  assert.equal(response.returnedCount, 3);
  assert.deepEqual(new Set(results.map((item) => item.caseId)), new Set(["case-a", "case-b", "case-c"]));
  assert.equal(results.find((item) => item.caseId === "case-a")?.matchKind, "both");
  assert.equal(retrieval.textCalls[0].options.scope, "full_and_subgraph");
  assert.deepEqual(retrieval.textCalls[0].options.sources, ["dynamic"]);
  assert.equal(retrieval.textCalls[0].options.subgraphMaxNodes, 24);
  assert.equal(retrieval.imageCalls.length, 1);
  assert.deepEqual(retrieval.imageCalls[0].options.sources, ["dynamic"]);
  const detail = await service.readRetrievedCase({ sessionID: snapshot.job.openCodeSessionId!, caseId: "case-a", subgraphId: "sub-a" });
  assert.equal((detail.case as any).caseId, "case-a");
  await assert.rejects(
    service.readRetrievedCase({ sessionID: snapshot.job.openCodeSessionId!, caseId: "case-missing" }),
    (error: any) => error.code === "CASE_NOT_RETRIEVED",
  );
  const events = service.eventsAfter(snapshot.job.id, 0).map((event) => event.type);
  assert.equal(events.includes("retrieval.started"), true);
  assert.equal(events.includes("retrieval.completed"), true);
  assert.equal(events.includes("case.read.started"), true);
  assert.equal(events.includes("case.read.completed"), true);
  const activities = service.getSnapshot(snapshot.job.id).stageRuns[0].toolActivities ?? [];
  assert.deepEqual(activities.map((item) => [item.tool, item.status]), [
    ["cadir_retrieve", "completed"],
    ["cadir_case_read", "completed"],
  ]);
  assert.equal(activities[0].resultCount, 3);
  assert.match(activities[0].summary ?? "", /Full plate/);
  assert.match(activities[1].summary ?? "", /reinforced plate/);
  const reloaded = new JsonStore(config.dataFile);
  await reloaded.init();
  const reloadedService = new CadirService(reloaded, adapter, config, retrieval);
  assert.deepEqual(
    reloadedService.getSnapshot(snapshot.job.id).stageRuns[0].toolActivities?.map((item) => item.tool),
    ["cadir_retrieve", "cadir_case_read"],
  );
});

test("disabled or unavailable retrieval never fails the CAD job", async () => {
  const disabledFixture = await fixture();
  await disabledFixture.service.updateModelSettings({ retrievalMode: "none" });
  const conversation = await disabledFixture.service.createConversation();
  const snapshot = await disabledFixture.service.submitMessage(conversation.id, { content: "Create a washer" });
  const disabled = await disabledFixture.service.retrieveCases({ sessionID: snapshot.job.openCodeSessionId!, query: "washer" });
  assert.equal(disabled.enabled, false);
  assert.equal(disabledFixture.retrieval.textCalls.length, 0);

  const failedFixture = await fixture();
  failedFixture.retrieval.failQueries = true;
  const failedConversation = await failedFixture.service.createConversation();
  const failedSnapshot = await failedFixture.service.submitMessage(failedConversation.id, { content: "Create a flange" });
  const failed = await failedFixture.service.retrieveCases({ sessionID: failedSnapshot.job.openCodeSessionId!, query: "flange" });
  assert.equal(failed.ok, false);
  assert.equal(failedFixture.service.getSnapshot(failedSnapshot.job.id).job.status, "running");
  assert.equal(failedFixture.service.eventsAfter(failedSnapshot.job.id, 0).at(-1)?.type, "retrieval.failed");
  assert.equal(failedFixture.service.getSnapshot(failedSnapshot.job.id).stageRuns[0].toolActivities?.[0].status, "failed");
});

test("pending archived Cases are asynchronously indexed without blocking jobs", async () => {
  const { service, retrieval, store, root } = await fixture({ retrievalUrl: "http://retrieval.test" });
  const conversation = await service.createConversation();
  const snapshot = await service.submitMessage(conversation.id, { content: "Create an indexed plate" });
  const entryPath = join(root, "rag-library", "entries", snapshot.job.id);
  await mkdir(entryPath, { recursive: true });
  await writeFile(join(entryPath, "model.json"), JSON.stringify({ graph: { nodes: [{ node_id: "solid", op: "make_extrude_rsolid", inputs: [] }] } }));
  await writeFile(join(entryPath, "manifest.json"), "{}");
  await store.transaction((state) => {
    state.ragEntries.push({
      id: snapshot.job.id, sourceConversationId: conversation.id, sourceJobId: snapshot.job.id,
      sourceTitle: conversation.title, path: entryPath, summary: "Indexed plate", revision: 1,
      files: [{ name: "model.json", relativePath: "model.json", mimeType: "application/json", size: 1, sha256: "model-hash" }],
      createdAt: new Date().toISOString(), indexStatus: "pending",
    });
  });
  service.resumePendingIndexing();
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline && store.read((state) => state.ragEntries[0].indexStatus) !== "ready") {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const entry = store.read((state) => state.ragEntries[0]);
  assert.equal(entry.indexStatus, "ready");
  assert.equal(entry.indexedRevision, 1);
  assert.equal(retrieval.indexCalls.length, 1);
  assert.equal(retrieval.indexCalls[0].modelJsonPath, `entries/${snapshot.job.id}/model.json`);
  assert.equal(retrieval.indexCalls[0].manifestPath, `entries/${snapshot.job.id}/manifest.json`);
  assert.deepEqual(retrieval.indexCalls[0].files?.map((file) => file.name), ["model.json"]);
  assert.equal(service.getSnapshot(snapshot.job.id).job.status, "running");
});

test("OpenCode part events resolve the job through part.sessionID", async () => {
  const { service } = await fixture();
  const conversation = await service.createConversation();
  const initial = await service.submitMessage(conversation.id, { content: "Create a clip" });
  await service.ingestOpenCodeEvent({
    type: "message.part.updated",
    properties: { delta: "Streaming text", part: { type: "text", sessionID: "session-1" } },
  });
  const snapshot = service.getSnapshot(initial.job.id);
  assert.equal(snapshot.messages.find((message) => message.role === "assistant")?.content, "Streaming text");
  assert.equal(snapshot.stageRuns[0].output, "Streaming text");
  assert.equal(service.eventsAfter(initial.job.id, 0).some((event) => event.type === "message.delta"), true);
});

test("usage reconciliation retains cache metrics without counting them in total", async () => {
  const { service } = await fixture();
  const conversation = await service.createConversation();
  const initial = await service.submitMessage(conversation.id, { content: "Create a plate" });
  const messages = [
    { info: { role: "user" } },
    { info: { role: "assistant", tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 2 }, total: 177 } } },
    { info: { role: "assistant", tokens: { input: 10, output: 4, reasoning: 1, cache: { read: 8 } } } },
  ];
  await service.reconcileUsage(initial.job.id, messages);
  await service.reconcileUsage(initial.job.id, messages);
  const snapshot = service.getSnapshot(initial.job.id);
  assert.deepEqual(snapshot.usage, { input: 110, output: 24, reasoning: 6, cacheRead: 58, cacheWrite: 2, total: 140 });
  assert.equal(service.eventsAfter(initial.job.id, 0).filter((event) => event.type === "usage.updated").length, 1);
});

test("stage retries subtract the OpenCode usage baseline", async () => {
  const { service, adapter } = await fixture();
  const conversation = await service.createConversation();
  const initial = await service.submitMessage(conversation.id, { content: "Create a chair" });
  const firstMessage = { info: { role: "assistant", tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50 }, total: 175 } } };
  adapter.messageList = [firstMessage];
  await service.reconcileUsage(initial.job.id, adapter.messageList);

  await service.transition({ sessionID: "session-1", stage: "requirements", action: "retry", summary: "Retry requirements" });
  const secondMessage = { info: { role: "assistant", tokens: { input: 12, output: 4, reasoning: 1, cache: { read: 8 }, total: 25 } } };
  adapter.messageList = [firstMessage, secondMessage];
  await service.reconcileUsage(initial.job.id, adapter.messageList);

  const snapshot = service.getSnapshot(initial.job.id);
  assert.deepEqual(snapshot.stageRuns.map((run) => run.usage), [
    { input: 100, output: 20, reasoning: 5, cacheRead: 50, cacheWrite: 0, total: 125 },
    { input: 12, output: 4, reasoning: 1, cacheRead: 8, cacheWrite: 0, total: 17 },
  ]);
  assert.deepEqual(snapshot.stageRuns[1].usageBaseline, { input: 100, output: 20, reasoning: 5, cacheRead: 50, cacheWrite: 0, total: 125 });
});

test("terminal jobs with zero usage are reconciled by the supervisor", async () => {
  const { service, adapter, config } = await fixture();
  const conversation = await service.createConversation();
  const initial = await service.submitMessage(conversation.id, { content: "Create a plate" });
  await service.failJob(initial.job.id, "TEST_DONE", "terminal fixture");
  adapter.messageList = [{ info: { role: "assistant", tokens: { input: 30, output: 7, cache: { read: 12 }, total: 49 } } }];
  const supervisor = new OpenCodeEventSupervisor(service, adapter, config);
  await (supervisor as any).tick();
  assert.equal(service.getSnapshot(initial.job.id).usage.total, 37);
  assert.equal(service.usageReconciliationJobs().some((job) => job.id === initial.job.id), false);
});

test("supervisor refines generic terminal failures with safe provider details", async () => {
  const { service, adapter, config } = await fixture();
  const conversation = await service.createConversation();
  const initial = await service.submitMessage(conversation.id, { content: "Create a cup" });
  await service.failJob(initial.job.id, "OPENCODE_ERROR", "OpenCode reported an execution error");
  adapter.messageList = [{
    info: {
      role: "assistant",
      error: { name: "UnknownError", data: { message: `Concurrency limit exceeded for account, key ${"s" + "k"}-secret-value, please retry later` } },
      tokens: { input: 0, output: 0, total: 0 },
    },
  }];
  const supervisor = new OpenCodeEventSupervisor(service, adapter, config);
  await (supervisor as any).tick();
  const snapshot = service.getSnapshot(initial.job.id);
  assert.equal(snapshot.job.error?.code, "PROVIDER_CONCURRENCY_LIMIT");
  assert.equal(snapshot.job.error?.message, "模型服务当前并发已满，请稍后重新运行。");
  assert.equal(snapshot.job.error?.retryable, true);
  assert.equal(snapshot.job.error?.source, "model_provider");
  assert.match(snapshot.job.error?.detail ?? "", /Concurrency limit exceeded/);
  assert.doesNotMatch(snapshot.job.error?.detail ?? "", /secret-value/);
  assert.equal(snapshot.stageRuns[0].error?.code, "PROVIDER_CONCURRENCY_LIMIT");
  assert.equal(service.eventsAfter(initial.job.id, 0).at(-1)?.data.refined, true);
});

test("OpenCode error events persist classified provider failures immediately", async () => {
  const { service } = await fixture();
  const conversation = await service.createConversation();
  const initial = await service.submitMessage(conversation.id, { content: "Create a lid" });
  await service.ingestOpenCodeEvent({
    type: "session.error",
    properties: { sessionID: "session-1", error: { data: { message: "Request timed out while contacting provider" } } },
  });
  const snapshot = service.getSnapshot(initial.job.id);
  assert.equal(snapshot.job.error?.code, "PROVIDER_TIMEOUT");
  assert.equal(snapshot.job.error?.retryable, true);
  assert.equal(snapshot.job.error?.detail, "Request timed out while contacting provider");
});

test("OpenCode failures drain in-flight retrieval callbacks before becoming terminal", async () => {
  const { service, config, retrieval } = await fixture();
  config.failureGraceMs = 40;
  const conversation = await service.createConversation();
  const initial = await service.submitMessage(conversation.id, { content: "Create a delayed retrieval test" });

  await service.ingestOpenCodeEvent({
    type: "session.error",
    properties: { sessionID: "session-1", error: { data: { message: "Upstream HTTP/2 stream failed" } } },
  });
  await service.failJob(initial.job.id, "OPENCODE_ERROR", "duplicate watchdog failure", {
    detail: "OpenCode reported a failed session state", source: "opencode", retryable: true,
  });
  assert.equal(service.getSnapshot(initial.job.id).job.status, "running");

  const response = await service.retrieveCases({ sessionID: "session-1", query: "delayed retrieval" });
  assert.equal(response.ok, true);
  assert.equal(retrieval.textCalls.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 70));
  const snapshot = service.getSnapshot(initial.job.id);
  assert.equal(snapshot.job.status, "failed");
  assert.equal(snapshot.job.error?.source, "opencode");
  assert.equal(snapshot.job.error?.detail, "Upstream HTTP/2 stream failed");
  assert.equal(service.eventsAfter(initial.job.id, 0).some((event) => event.type === "retrieval.completed"), true);
});

test("late tool errors do not replace the original OpenCode failure", async () => {
  const { service } = await fixture();
  const conversation = await service.createConversation();
  const initial = await service.submitMessage(conversation.id, { content: "Preserve the provider error" });
  await service.failJob(initial.job.id, "OPENCODE_ERROR", "OpenCode failed", {
    detail: "Upstream HTTP/2 stream failed", source: "model_provider", retryable: true,
  });
  await service.failJobFromMessages(initial.job.id, [{
    info: { role: "assistant" },
    parts: [{ type: "tool", state: { status: "error", error: "ACTIVE_JOB_NOT_FOUND" } }],
  }]);
  const snapshot = service.getSnapshot(initial.job.id);
  assert.equal(snapshot.job.error?.source, "model_provider");
  assert.equal(snapshot.job.error?.detail, "Upstream HTTP/2 stream failed");
});

test("tool errors remain recoverable across a stage retry", async () => {
  const { service, adapter, config } = await fixture();
  const conversation = await service.createConversation();
  const initial = await service.submitMessage(conversation.id, { content: "Create a chair" });
  const toolPart = {
    type: "tool", tool: "cadir_run", sessionID: "session-1",
    state: { status: "error", error: "CAD execution failed: union_rsolid returned 6 disconnected solids" },
  };
  await service.ingestOpenCodeEvent({ type: "tool.error", properties: { part: toolPart } });

  let snapshot = service.getSnapshot(initial.job.id);
  assert.equal(snapshot.job.status, "running");
  assert.equal(snapshot.job.error, undefined);
  assert.equal(snapshot.stageRuns[0].toolError?.code, "TOOL_EXECUTION_FAILED");
  assert.equal(service.eventsAfter(initial.job.id, 0).some((event) => event.type === "job.failed"), false);

  adapter.messageList = [{ info: { role: "assistant", tokens: { total: 0 } }, parts: [toolPart] }];
  adapter.statuses = { "session-1": { type: "busy" } };
  const supervisor = new OpenCodeEventSupervisor(service, adapter, config);
  await (supervisor as any).tick();
  assert.equal(service.getSnapshot(initial.job.id).job.status, "running");

  await service.transition({ sessionID: "session-1", stage: "requirements", action: "retry", summary: "Repair the disconnected solids" });
  await (supervisor as any).tick();
  snapshot = service.getSnapshot(initial.job.id);
  assert.equal(snapshot.job.status, "running");
  assert.equal(snapshot.stageRuns[0].status, "failed");
  assert.equal(snapshot.stageRuns[0].error?.code, "TOOL_EXECUTION_FAILED");
  assert.equal(snapshot.stageRuns[1].status, "running");
});

test("supervisor reconciles an idle non-terminal session to a terminal failure", async () => {
  const { service, adapter, config } = await fixture();
  const conversation = await service.createConversation();
  const initial = await service.submitMessage(conversation.id, { content: "Create a latch" });
  adapter.statuses = { "session-1": { type: "idle" } };
  config.watchdogMs = -1;
  const supervisor = new OpenCodeEventSupervisor(service, adapter, config);
  await (supervisor as any).tick();
  const snapshot = service.getSnapshot(initial.job.id);
  assert.equal(snapshot.job.status, "failed");
  assert.equal(snapshot.job.error?.code, "OPENCODE_SESSION_LOST");
});

test("requirements guard only accepts a validated requirements.md", async () => {
  const { service, jobsRoot } = await fixture();
  const conversation = await service.createConversation();
  const initial = await service.submitMessage(conversation.id, { content: "Create a flange" });
  await assert.rejects(
    service.transition({ sessionID: "session-1", stage: "requirements", action: "complete" }),
    (error: any) => error.code === "REQUIREMENTS_MISSING",
  );
  const jobDirectory = join(jobsRoot, initial.job.id);
  await mkdir(jobDirectory, { recursive: true });
  const path = join(jobDirectory, "requirements.md");
  await writeFile(path, "# incomplete\n");
  await service.registerArtifact({ sessionID: "session-1", path, kind: "requirements", validated: true });
  await assert.rejects(
    service.transition({ sessionID: "session-1", stage: "requirements", action: "complete" }),
    (error: any) => error.code === "REQUIREMENTS_HEADING_MISSING",
  );
  await writeFile(path, validRequirements);
  const next = await service.transition({ sessionID: "session-1", stage: "requirements", action: "complete", summary: "Requirements confirmed" });
  assert.equal(next.job.currentStage, "codegen");
  assert.equal(next.stageRuns.find((run) => run.stage === "requirements")?.status, "completed");
  assert.equal(next.stageRuns.find((run) => run.stage === "codegen")?.status, "running");
  assert.equal(next.artifacts[0].name, "requirements.md");
  assert.equal(next.artifacts.some((item) => item.name.endsWith(".json")), false);
});

test("OpenCode startup errors are persisted as terminal failures without leaking keys", async () => {
  const { service, adapter } = await fixture();
  adapter.failCreate = true;
  const conversation = await service.createConversation();
  const snapshot = await service.submitMessage(conversation.id, { content: "Create a gear" });
  assert.equal(snapshot.job.status, "failed");
  assert.equal(snapshot.stageRuns[0].status, "failed");
  assert.equal(snapshot.job.error?.code, "OPENCODE_UNAVAILABLE");
  assert.doesNotMatch(snapshot.job.error?.message ?? "", /secret-value/);
  assert.equal(service.eventsAfter(snapshot.job.id, 0).at(-1)?.type, "job.failed");
});

test("cancel is committed before best-effort OpenCode abort", async () => {
  const { service, adapter } = await fixture();
  const conversation = await service.createConversation();
  const initial = await service.submitMessage(conversation.id, { content: "Create a case" });
  const cancelled = await service.cancel(initial.job.id);
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(cancelled.stageRuns[0].status, "cancelled");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(adapter.aborted, ["session-1"]);
});

test("cancelled jobs resume in the same OpenCode session", async () => {
  const { service, adapter } = await fixture();
  const conversation = await service.createConversation();
  const initial = await service.submitMessage(conversation.id, { content: "Create a resumable bracket" });
  await service.cancel(initial.job.id);
  const resumed = await service.retryJob(initial.job.id);
  assert.equal(resumed.job.status, "running");
  assert.equal(resumed.job.openCodeSessionId, initial.job.openCodeSessionId);
  assert.equal(adapter.prompts.at(-1)?.sessionId, initial.job.openCodeSessionId);
  assert.equal(resumed.stageRuns.at(-1)?.attempt, 2);
});

test("snapshots survive a store restart", async () => {
  const { service, adapter, config } = await fixture();
  const conversation = await service.createConversation();
  const initial = await service.submitMessage(conversation.id, { content: "Create a knob" });
  const reloaded = new JsonStore(config.dataFile);
  await reloaded.init();
  const secondService = new CadirService(reloaded, adapter, config);
  assert.equal(secondService.getSnapshot(initial.job.id).lastSeq, 2);
  assert.equal(secondService.getSnapshot(initial.job.id).messages[0].content, "Create a knob");
});

test("image uploads are scoped to the conversation and become prompt artifacts", async () => {
  const { service, adapter } = await fixture();
  const conversation = await service.createConversation();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("image")]);
  const upload = await service.createUpload(conversation.id, { filename: "reference.png", mimeType: "image/png", data: png });
  const snapshot = await service.submitMessage(conversation.id, { content: "Match this reference", imageArtifactIds: [upload.id] });
  assert.equal(snapshot.artifacts[0].kind, "image");
  assert.deepEqual(snapshot.messages[0].imageArtifactIds, [snapshot.artifacts[0].id]);
  assert.ok(snapshot.artifacts[0].path.startsWith(`${snapshot.job.workspacePath}\\inputs\\`) || snapshot.artifacts[0].path.startsWith(`${snapshot.job.workspacePath}/inputs/`));
  assert.match(adapter.prompts[0].content, new RegExp(snapshot.artifacts[0].path.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
  const other = await service.createConversation();
  await assert.rejects(service.submitMessage(other.id, { content: "Wrong owner", imageArtifactIds: [upload.id] }), (error: any) => error.code === "UPLOAD_NOT_FOUND");
});

test("an uploaded reference image cannot satisfy the visual feedback guard", async () => {
  const { service, jobsRoot, adapter } = await fixture();
  const conversation = await service.createConversation();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("reference")]);
  const upload = await service.createUpload(conversation.id, { filename: "input.png", mimeType: "image/png", data: png });
  const initial = await service.submitMessage(conversation.id, { content: "Create from reference", imageArtifactIds: [upload.id] });
  const directory = join(jobsRoot, initial.job.id);
  const requirementsPath = join(directory, "requirements.md");
  await writeFile(requirementsPath, validRequirements);
  await service.registerArtifact({ sessionID: "session-1", path: requirementsPath, kind: "requirements", validated: true });
  await service.transition({ sessionID: "session-1", stage: "requirements", action: "complete" });
  const modelPath = join(directory, "model.py");
  const jsonPath = join(directory, "model.json");
  await writeFile(modelPath, "# model");
  await writeFile(jsonPath, "{}");
  await service.registerArtifact({ sessionID: "session-1", path: modelPath, kind: "python", validated: true });
  await service.registerArtifact({ sessionID: "session-1", path: jsonPath, kind: "other", validated: true });
  await service.transition({ sessionID: "session-1", stage: "codegen", action: "complete" });
  await assert.rejects(
    service.transition({ sessionID: "session-1", stage: "visual", action: "complete" }),
    (error: any) => error.code === "VISUAL_ARTIFACT_MISSING",
  );
  for (const name of ["render-isometric.png", "render-front.png", "render-top.png"]) {
    const path = join(directory, name);
    await writeFile(path, "render");
    await service.registerArtifact({ sessionID: "session-1", path, kind: "image", validated: true });
  }
  await assert.rejects(
    service.transition({ sessionID: "session-1", stage: "visual", action: "complete" }),
    (error: any) => error.code === "VISUAL_ARTIFACT_MISSING" && error.message.includes("render-right.png"),
  );
  const rightPath = join(directory, "render-right.png");
  await writeFile(rightPath, "render");
  await service.registerArtifact({ sessionID: "session-1", path: rightPath, kind: "image", validated: true });
  adapter.imageInputSupported = false;
  await assert.rejects(
    service.transition({ sessionID: "session-1", stage: "visual", action: "complete" }),
    (error: any) => error.code === "MODEL_IMAGE_INPUT_UNSUPPORTED",
  );
  adapter.imageInputSupported = true;
  const repair = await service.transition({ sessionID: "session-1", stage: "visual", action: "retry", summary: "View proportions are wrong" });
  assert.equal(repair.job.currentStage, "codegen");
  assert.equal(repair.stageRuns.some((run) => run.stage === "evolution"), false, "visual failure must not start evolution");
  await assert.rejects(
    service.transition({ sessionID: "session-1", stage: "codegen", action: "complete" }),
    (error: any) => error.code === "CODEGEN_ARTIFACTS_MISSING",
  );
  await service.registerArtifact({ sessionID: "session-1", path: modelPath, kind: "python", validated: true });
  await service.registerArtifact({ sessionID: "session-1", path: jsonPath, kind: "other", validated: true });
  const repaired = await service.transition({ sessionID: "session-1", stage: "codegen", action: "complete" });
  assert.equal(repaired.job.currentStage, "visual");
  for (const name of ["render-isometric.png", "render-front.png", "render-top.png", "render-right.png"]) {
    await service.registerArtifact({ sessionID: "session-1", path: join(directory, name), kind: "image", validated: true });
  }
  const passed = await service.transition({ sessionID: "session-1", stage: "visual", action: "complete" });
  assert.equal(passed.job.currentStage, "evolution");
});

test("final evolution transition is the authoritative completion boundary", async () => {
  const { service, jobsRoot, store, adapter } = await fixture();
  const conversation = await service.createConversation();
  const initial = await service.submitMessage(conversation.id, { content: "Create a spacer" });
  const directory = join(jobsRoot, initial.job.id);
  await mkdir(directory, { recursive: true });
  const add = async (name: string, kind: any) => {
    const path = join(directory, name);
    await writeFile(path, `test ${name}`);
    return await service.registerArtifact({ sessionID: "session-1", path, kind, validated: true });
  };
  await writeFile(join(directory, "requirements.md"), validRequirements);
  await service.registerArtifact({ sessionID: "session-1", path: join(directory, "requirements.md"), kind: "requirements", validated: true });
  await service.transition({ sessionID: "session-1", stage: "requirements", action: "complete" });
  await add("model.py", "python");
  await add("model.json", "other");
  await service.transition({ sessionID: "session-1", stage: "codegen", action: "complete" });
  for (const name of ["render-isometric.png", "render-front.png", "render-top.png", "render-right.png"]) await add(name, "image");
  const visuallyComplete = await service.transition({ sessionID: "session-1", stage: "visual", action: "complete", summary: "Model generated" });
  assert.equal(visuallyComplete.job.status, "running", "stage completion must not pre-empt publish");
  assert.equal(visuallyComplete.job.currentStage, "evolution");
  await add("model.step", "step");
  await add("model.stl", "stl");
  await add("model.FCStd", "freecad");
  await add("summary.md", "summary");
  await add("experience.md", "experience");
  const manifest = await add("manifest.json", "other");
  assert.equal(service.getSnapshot(manifest.jobId).job.status, "running", "artifact registration alone must not complete a job");
  const complete = await service.transition({ sessionID: "session-1", stage: "evolution", action: "skipped", summary: "No repair needed" });
  assert.equal(complete.job.status, "completed");
  assert.equal(service.eventsAfter(manifest.jobId, 0).at(-1)?.type, "job.completed");
  const archive = store.read((state) => state.ragEntries.find((entry) => entry.sourceJobId === manifest.jobId));
  assert.ok(archive);
  assert.deepEqual(archive.files.map((file) => file.name).sort(), [
    "experience.md", "manifest.json", "model.json", "model.py", "render-front.png", "render-isometric.png",
    "render-right.png", "render-top.png", "summary.md",
  ]);
  assert.equal(JSON.parse(await readFile(join(archive.path, "manifest.json"), "utf8")).sourceJobId, manifest.jobId);

  adapter.messageList = [{ info: { role: "assistant", tokens: { input: 20, output: 10, total: 30 } } }];
  const modification = await service.submitMessage(conversation.id, { content: "Add a shallow groove to the spacer" });
  assert.equal(modification.job.id, initial.job.id, "a Session must keep one stable Job");
  assert.equal(modification.job.revision, 2);
  assert.equal(modification.job.currentStage, "codegen", "modifications start at codegen");
  assert.equal(modification.stageRuns.find((run) => run.revision === 2)?.usageBaseline?.total, 30);
  assert.equal(adapter.prompts.at(-1)?.sessionId, "session-1", "the OpenCode conversation is reused");
  assert.match(adapter.prompts.at(-1)?.content ?? "", /modification request/i);
  await add("model.py", "python");
  await add("model.json", "other");
  await service.transition({ sessionID: "session-1", stage: "codegen", action: "complete" });
  for (const name of ["render-isometric.png", "render-front.png", "render-top.png", "render-right.png"]) await add(name, "image");
  await service.transition({ sessionID: "session-1", stage: "visual", action: "complete", summary: "Updated visual review" });
  await add("model.step", "step");
  await add("model.stl", "stl");
  await add("model.FCStd", "freecad");
  await writeFile(join(directory, "summary.md"), "summary revision 2");
  await writeFile(join(directory, "experience.md"), "experience revisions 1 and 2");
  await service.registerArtifact({ sessionID: "session-1", path: join(directory, "summary.md"), kind: "summary", validated: true });
  await service.registerArtifact({ sessionID: "session-1", path: join(directory, "experience.md"), kind: "experience", validated: true });
  await add("manifest.json", "other");
  const secondComplete = await service.transition({ sessionID: "session-1", stage: "evolution", action: "skipped", summary: "Updated model published" });
  assert.equal(secondComplete.job.status, "completed");
  const updatedArchive = store.read((state) => state.ragEntries.filter((entry) => entry.sourceJobId === initial.job.id));
  assert.equal(updatedArchive.length, 1, "a Job must have one replaceable RAG Case");
  assert.equal(updatedArchive[0].revision, 2);
  assert.equal(await readFile(join(updatedArchive[0].path, "summary.md"), "utf8"), "summary revision 2");
  assert.equal(JSON.parse(await readFile(join(updatedArchive[0].path, "manifest.json"), "utf8")).revision, 2);

  const deleted = await service.deleteConversation(conversation.id);
  assert.equal(deleted.retainedRagEntries, 1);
  assert.equal(service.listConversations().some((item) => item.id === conversation.id), false);
  await assert.rejects(access(directory));
  await access(join(archive.path, "model.py"));
  assert.equal(store.read((state) => state.ragEntries.some((entry) => entry.sourceJobId === manifest.jobId)), true);
});

test("disabled self-evolution publishes from visual and completes without a dynamic Case", async () => {
  const { service, jobsRoot, store, retrieval, adapter } = await fixture({ retrievalUrl: "http://retrieval" });
  const settings = await service.updateModelSettings({ selfEvolutionEnabled: false });
  assert.equal(settings.settings.selfEvolutionEnabled, false);
  await assert.rejects(
    service.updateModelSettings({ selfEvolutionEnabled: "no" as any }),
    (error: any) => error.code === "SELF_EVOLUTION_INVALID",
  );

  const conversation = await service.createConversation();
  const initial = await service.submitMessage(conversation.id, { content: "Create a plain spacer without archiving" });
  assert.equal(initial.job.selfEvolutionEnabled, false);
  assert.match(adapter.prompts.at(-1)?.content ?? "", /Self-evolution is disabled for this revision/);
  const directory = join(jobsRoot, initial.job.id);
  const add = async (name: string, kind: any, content = `test ${name}`) => {
    const path = join(directory, name);
    await writeFile(path, content);
    return await service.registerArtifact({ sessionID: "session-1", path, kind, validated: true });
  };

  await add("requirements.md", "requirements", validRequirements);
  await service.transition({ sessionID: "session-1", stage: "requirements", action: "complete" });
  await add("model.py", "python");
  await add("model.json", "other", "{}");
  await service.transition({ sessionID: "session-1", stage: "codegen", action: "complete" });
  for (const name of ["render-isometric.png", "render-front.png", "render-top.png", "render-right.png"]) await add(name, "image");

  await assert.rejects(
    service.transition({ sessionID: "session-1", stage: "evolution", action: "running" }),
    (error: any) => error.code === "SELF_EVOLUTION_DISABLED",
  );
  await assert.rejects(
    service.transition({ sessionID: "session-1", stage: "visual", action: "complete" }),
    (error: any) => error.code === "FINAL_ARTIFACTS_MISSING",
  );
  assert.equal(service.getSnapshot(initial.job.id).job.currentStage, "visual");

  await add("model.step", "step");
  await add("model.stl", "stl");
  await add("model.FCStd", "freecad");
  await add("summary.md", "summary", "Final spacer summary");
  await add("experience.md", "experience", "Reusable spacer experience");
  await add("manifest.json", "other", "{}");
  const complete = await service.transition({ sessionID: "session-1", stage: "visual", action: "complete", summary: "Published without self-evolution" });

  assert.equal(complete.job.status, "completed");
  assert.equal(complete.job.currentStage, undefined);
  assert.equal(complete.stageRuns.some((run) => run.stage === "evolution"), false);
  assert.equal(service.eventsAfter(initial.job.id, 0).at(-1)?.type, "job.completed");
  assert.equal(store.read((state) => state.ragEntries.some((entry) => entry.sourceJobId === initial.job.id)), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retrieval.indexCalls.length, 0);
});

test("deleting an active conversation aborts OpenCode and removes all session-owned files", async () => {
  const { service, adapter, jobsRoot, store } = await fixture();
  const conversation = await service.createConversation("Disposable session");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("image")]);
  await service.createUpload(conversation.id, { filename: "reference.png", mimeType: "image/png", data: png });
  const snapshot = await service.submitMessage(conversation.id, { content: "Create a disposable part" });
  await service.retrieveCases({ sessionID: snapshot.job.openCodeSessionId!, query: "disposable part" });
  assert.equal(store.read((state) => state.retrievalGrants.some((item) => item.jobId === snapshot.job.id)), true);
  const result = await service.deleteConversation(conversation.id);
  assert.equal(result.deleted, true);
  assert.deepEqual(adapter.aborted, ["session-1", "delete:session-1"]);
  await assert.rejects(access(snapshot.job.workspacePath));
  await assert.rejects(access(join(jobsRoot, "uploads", conversation.id)));
  assert.throws(() => service.getConversation(conversation.id), (error: any) => error.code === "NOT_FOUND");
  assert.throws(() => service.getSnapshot(snapshot.job.id), (error: any) => error.code === "NOT_FOUND");
  assert.equal(store.read((state) => state.retrievalGrants.some((item) => item.jobId === snapshot.job.id)), false);
  const repeated = await service.deleteConversation(conversation.id);
  assert.equal(repeated.alreadyDeleted, true);
});
