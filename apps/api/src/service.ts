import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  emptyUsage, isTerminalJob,
  type Artifact, type ArtifactKind, type Conversation, type CreateMessageRequest,
  type Job, type JobError, type JobEvent, type JobSnapshot, type RagArchiveEntry, type RagArchiveFile,
  type ModelEffort, type ModelOption, type ModelSettings, type ModelSettingsResponse,
  type Stage, type StageTransitionRequest, type TokenUsage, type Upload,
} from "../../../packages/contracts/src/index.js";
import type { AppConfig } from "./config.js";
import { AppError, notFound } from "./errors.js";
import type { OpenCodeAdapter, OpenCodeEvent } from "./opencode.js";
import { JsonStore } from "./store.js";
import type { DatabaseState } from "./types.js";

const now = (): string => new Date().toISOString();
const eventName = (stage: Stage): string => ({ requirements: "Requirements", codegen: "Code generation", visual: "Visual feedback", evolution: "Self evolution" })[stage];
const modelLabels: Record<string, string> = {
  "gpt-5.5": "GPT-5.5",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
};
const modelIds = new Set(Object.keys(modelLabels));
const effortIds: ModelEffort[] = ["low", "medium", "high"];

function sumUsage(values: TokenUsage[]): TokenUsage {
  return values.reduce((sum, item) => ({
    input: sum.input + item.input, output: sum.output + item.output,
    reasoning: sum.reasoning + item.reasoning, cacheRead: sum.cacheRead + item.cacheRead,
    cacheWrite: sum.cacheWrite + item.cacheWrite, total: sum.total + item.total,
  }), emptyUsage());
}

function tokenUsage(tokens: any): TokenUsage {
  const finite = (value: unknown): number => {
    const number = Number(value ?? 0);
    return Number.isFinite(number) && number > 0 ? number : 0;
  };
  const usage: TokenUsage = {
    input: finite(tokens?.input),
    output: finite(tokens?.output),
    reasoning: finite(tokens?.reasoning),
    cacheRead: finite(tokens?.cache?.read ?? tokens?.cacheRead),
    cacheWrite: finite(tokens?.cache?.write ?? tokens?.cacheWrite),
    total: finite(tokens?.total),
  };
  if (!usage.total) usage.total = usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite;
  return usage;
}

function usageFromMessages(messages: unknown[]): TokenUsage {
  return sumUsage(messages
    .filter((entry: any) => entry?.info?.role === "assistant" && entry.info.tokens)
    .map((entry: any) => tokenUsage(entry.info.tokens)));
}

function subtractUsage(current: TokenUsage, baseline: TokenUsage): TokenUsage {
  return {
    input: Math.max(0, current.input - baseline.input),
    output: Math.max(0, current.output - baseline.output),
    reasoning: Math.max(0, current.reasoning - baseline.reasoning),
    cacheRead: Math.max(0, current.cacheRead - baseline.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - baseline.cacheWrite),
    total: Math.max(0, current.total - baseline.total),
  };
}

export class CadirService {
  private readonly deletionTasks = new Map<string, Promise<DeleteConversationResult>>();

  constructor(
    readonly store: JsonStore,
    private readonly adapter: OpenCodeAdapter,
    private readonly config: AppConfig,
  ) {}

  async createConversation(title = "New CAD session"): Promise<Conversation> {
    return await this.store.transaction((state) => {
      const timestamp = now();
      const conversation: Conversation = { id: randomUUID(), title, revision: 1, createdAt: timestamp, updatedAt: timestamp };
      state.conversations.push(conversation);
      return conversation;
    });
  }

  listConversations(): Conversation[] {
    return this.store.read((state) => [...state.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }

  getConversation(id: string): Conversation {
    const item = this.store.read((state) => state.conversations.find((entry) => entry.id === id));
    if (!item) throw notFound("conversation");
    return item;
  }

  async getModelSettings(): Promise<ModelSettingsResponse> {
    const settings = this.store.read((state) => state.modelSettings ?? { modelId: this.config.modelId, effort: "medium" as ModelEffort });
    const models = (await this.adapter.availableModels()).filter((item) => modelIds.has(item.id) && item.imageInput);
    return { settings, models, efforts: effortIds };
  }

  async updateModelSettings(input: Partial<ModelSettings>): Promise<ModelSettingsResponse> {
    if (!input.modelId || !modelIds.has(input.modelId)) throw new AppError(400, "MODEL_NOT_ALLOWED", "model is not an allowed CADIR model");
    if (!input.effort || !effortIds.includes(input.effort)) throw new AppError(400, "EFFORT_INVALID", "effort must be low, medium, or high");
    const models = (await this.adapter.availableModels()).filter((item) => modelIds.has(item.id) && item.imageInput);
    const selected = models.find((item) => item.id === input.modelId);
    if (!selected) throw new AppError(409, "MODEL_UNAVAILABLE", "selected model is not currently available for image-enabled CAD tasks");
    if (!selected.efforts.includes(input.effort)) throw new AppError(409, "EFFORT_UNAVAILABLE", "selected effort is not supported by this model");
    await this.store.transaction((state) => {
      state.modelSettings = { modelId: input.modelId!, effort: input.effort! };
    });
    return await this.getModelSettings();
  }

  async deleteConversation(conversationId: string): Promise<DeleteConversationResult> {
    const pending = this.deletionTasks.get(conversationId);
    if (pending) return await pending;
    const exists = this.store.read((state) => state.conversations.some((item) => item.id === conversationId));
    if (!exists) return { deleted: true, alreadyDeleted: true, conversationId, retainedRagEntries: 0 };
    const task = this.performConversationDeletion(conversationId);
    this.deletionTasks.set(conversationId, task);
    try { return await task; }
    finally { this.deletionTasks.delete(conversationId); }
  }

  async submitMessage(conversationId: string, request: CreateMessageRequest): Promise<JobSnapshot> {
    if (!request.content?.trim()) throw new AppError(400, "MESSAGE_EMPTY", "message content is required");
    const conversation = this.getConversation(conversationId);
    if (conversation.deletionStatus) throw new AppError(409, "CONVERSATION_DELETING", "conversation is being deleted");
    if (request.resumeJobId) return await this.resumeJob(conversation, request);

    const active = this.store.read((state) => state.jobs.find((job) => job.conversationId === conversationId && !isTerminalJob(job.status)));
    if (active) throw new AppError(409, "JOB_ALREADY_ACTIVE", "conversation already has an active job");

    const jobId = randomUUID();
    const selectedSettings = this.store.read((state) => state.modelSettings ?? { modelId: this.config.modelId, effort: "medium" as ModelEffort });
    const workspacePath = resolve(this.config.jobsRoot, jobId);
    await mkdir(workspacePath, { recursive: true });
    const uploads = await this.localizeUploads(workspacePath, this.resolveUploads(conversationId, request.imageArtifactIds ?? []));
    const prompt = uploads.length
      ? `${request.content.trim()}\n\nInput reference images (read these exact paths before modeling):\n${uploads.map((item) => `- ${item.localPath}`).join("\n")}`
      : request.content.trim();
    const timestamp = now();
    const initialEvents = await this.store.transaction((state) => {
      const liveConversation = state.conversations.find((item) => item.id === conversationId)!;
      const job: Job = {
        id: jobId, conversationId, status: "running", currentStage: "requirements", workspacePath,
        createdAt: timestamp, startedAt: timestamp, updatedAt: timestamp, backendHeartbeatAt: timestamp,
        modelId: selectedSettings.modelId, modelProvider: this.config.modelProvider, effort: selectedSettings.effort,
      };
      state.jobs.push(job);
      state.stageRuns.push({ id: randomUUID(), jobId, stage: "requirements", attempt: 1, status: "running", usage: emptyUsage(), usageBaseline: emptyUsage(), startedAt: timestamp });
      const inputArtifacts = uploads.map(({ upload, localPath }): Artifact => {
        const id = randomUUID();
        return { id, jobId, name: upload.name, kind: "image", path: localPath, mimeType: upload.mimeType, size: upload.size, validated: true, partial: false, createdAt: timestamp, downloadUrl: upload.downloadUrl };
      });
      state.artifacts.push(...inputArtifacts);
      state.messages.push({
        id: randomUUID(), conversationId, jobId, role: "user", content: request.content.trim(),
        imageArtifactIds: inputArtifacts.map((item) => item.id), createdAt: timestamp, completedAt: timestamp,
      });
      liveConversation.latestJobId = jobId;
      liveConversation.latestJobStatus = "running";
      liveConversation.title = liveConversation.revision === 1 && liveConversation.title === "New CAD session" ? request.content.trim().slice(0, 40) : liveConversation.title;
      liveConversation.revision += 1;
      liveConversation.updatedAt = timestamp;
      return [
        this.appendEvent(state, job, "job.started", { status: "running" }),
        this.appendEvent(state, job, "stage.updated", { stage: "requirements", status: "running", attempt: 1, label: eventName("requirements") }),
      ];
    });
    this.store.publish(initialEvents);

    try {
      const session = await this.adapter.createSession(conversation.title, workspacePath);
      await this.bindSession(jobId, session.id);
      await this.adapter.prompt(session.id, prompt, workspacePath, { modelId: selectedSettings.modelId, providerId: this.config.modelProvider, effort: selectedSettings.effort });
    } catch (error) {
      await this.failJob(jobId, "OPENCODE_UNAVAILABLE", this.safeError(error));
    }
    return this.getSnapshot(jobId);
  }

  private async resumeJob(conversation: Conversation, request: CreateMessageRequest): Promise<JobSnapshot> {
    const jobId = request.resumeJobId!;
    const resumedJob = this.getSnapshot(jobId).job;
    const usageBaseline = await this.readUsageBaseline(resumedJob);
    const uploads = await this.localizeUploads(resumedJob.workspacePath, this.resolveUploads(conversation.id, request.imageArtifactIds ?? []));
    const prompt = uploads.length
      ? `${request.content.trim()}\n\nAdditional reference images (read these exact paths):\n${uploads.map((item) => `- ${item.localPath}`).join("\n")}`
      : request.content.trim();
    const events = await this.store.transaction(async (state) => {
      const job = state.jobs.find((item) => item.id === jobId && item.conversationId === conversation.id);
      if (!job) throw notFound("job");
      if (job.status !== "waiting_input") throw new AppError(409, "JOB_NOT_WAITING", "job is not waiting for input");
      const timestamp = now();
      const old = state.stageRuns.find((run) => run.jobId === job.id && run.status === "waiting_input");
      const attempt = old ? old.attempt + 1 : 1;
      const inputArtifacts = uploads.map(({ upload, localPath }): Artifact => {
        const id = randomUUID();
        return { id, jobId, name: upload.name, kind: "image", path: localPath, mimeType: upload.mimeType, size: upload.size, validated: true, partial: false, createdAt: timestamp, downloadUrl: upload.downloadUrl };
      });
      state.artifacts.push(...inputArtifacts);
      state.messages.push({ id: randomUUID(), conversationId: conversation.id, jobId, role: "user", content: request.content.trim(), imageArtifactIds: inputArtifacts.map((item) => item.id), createdAt: timestamp, completedAt: timestamp });
      state.stageRuns.push({ id: randomUUID(), jobId, stage: job.currentStage ?? "requirements", attempt, status: "running", usage: emptyUsage(), usageBaseline, startedAt: timestamp });
      job.status = "running"; job.updatedAt = timestamp; job.error = undefined;
      this.touchConversation(state, job);
      return [this.appendEvent(state, job, "stage.updated", { stage: job.currentStage, status: "running", attempt })];
    });
    this.store.publish(events);
    try {
      if (!conversation.openCodeSessionId) throw new Error("OpenCode session is missing");
      const job = this.getSnapshot(jobId).job;
      await this.adapter.prompt(conversation.openCodeSessionId, prompt, job.workspacePath, this.promptModel(job));
    } catch (error) { await this.failJob(jobId, "OPENCODE_UNAVAILABLE", this.safeError(error)); }
    return this.getSnapshot(jobId);
  }

  private async bindSession(jobId: string, sessionId: string): Promise<void> {
    await this.store.transaction((state) => {
      const job = state.jobs.find((item) => item.id === jobId)!;
      const conversation = state.conversations.find((item) => item.id === job.conversationId)!;
      job.openCodeSessionId = sessionId;
      conversation.openCodeSessionId = sessionId;
      conversation.updatedAt = now(); conversation.revision += 1;
    });
  }

  getSnapshot(jobId: string): JobSnapshot {
    return this.store.read((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job) throw notFound("job");
      const stageRuns = state.stageRuns.filter((run) => run.jobId === jobId);
      const messages = state.messages.filter((message) => message.jobId === jobId);
      const artifacts = state.artifacts.filter((artifact) => artifact.jobId === jobId);
      const events = state.events.filter((event) => event.jobId === jobId);
      return { serverTime: now(), lastSeq: events.at(-1)?.seq ?? 0, job, stageRuns, messages, usage: sumUsage(stageRuns.map((run) => run.usage)), artifacts };
    });
  }

  eventsAfter(jobId: string, after: number): JobEvent[] {
    this.getSnapshot(jobId);
    return this.store.read((state) => state.events.filter((event) => event.jobId === jobId && event.seq > after));
  }

  async transition(request: StageTransitionRequest): Promise<JobSnapshot> {
    const transitionJob = this.store.read((state) => [...state.jobs].reverse().find((item) => item.openCodeSessionId === request.sessionID && !isTerminalJob(item.status)));
    const usageBaseline = await this.readUsageBaseline(transitionJob);
    if (request.stage === "visual" && request.action === "complete" && !await this.adapter.supportsImageInput(transitionJob?.modelId ?? this.config.modelId)) {
      throw new AppError(
        409,
        "MODEL_IMAGE_INPUT_UNSUPPORTED",
        `OpenCode model ${this.config.modelProvider}/${transitionJob?.modelId ?? this.config.modelId} is not configured for image attachments`,
      );
    }
    const events = await this.store.transaction(async (state) => {
      const job = [...state.jobs].reverse().find((item) => item.openCodeSessionId === request.sessionID);
      if (!job) throw new AppError(404, "ACTIVE_JOB_NOT_FOUND", "no active job for this OpenCode session");
      if (isTerminalJob(job.status)) return [];
      if (request.action === "running") {
        const existing = [...state.stageRuns].reverse().find((item) => item.jobId === job.id && item.stage === request.stage && item.status === "running");
        if (existing) return [];
        if (request.stage !== "evolution" && job.currentStage !== request.stage) throw new AppError(409, "INVALID_STAGE", `expected ${job.currentStage}, received ${request.stage}`);
        const attempt = Math.max(0, ...state.stageRuns.filter((item) => item.jobId === job.id && item.stage === request.stage).map((item) => item.attempt)) + 1;
        job.currentStage = request.stage;
        state.stageRuns.push({ id: randomUUID(), jobId: job.id, stage: request.stage, attempt, status: "running", usage: emptyUsage(), usageBaseline, startedAt: now() });
        job.updatedAt = now(); this.touchConversation(state, job);
        return [this.appendEvent(state, job, "stage.updated", { stage: request.stage, status: "running", attempt })];
      }
      if (request.action === "skipped") {
        if (request.stage !== "evolution") throw new AppError(409, "INVALID_SKIP", "only evolution may be skipped");
        const existing = [...state.stageRuns].reverse().find((item) => item.jobId === job.id && item.stage === "evolution");
        const timestamp = now();
        if (existing?.status === "skipped") return [];
        if (existing?.status === "running") { existing.status = "skipped"; existing.completedAt = timestamp; existing.summary = request.summary; }
        else state.stageRuns.push({ id: randomUUID(), jobId: job.id, stage: "evolution", attempt: 1, status: "skipped", usage: emptyUsage(), usageBaseline, startedAt: timestamp, completedAt: timestamp, summary: request.summary });
        const emitted = [this.appendEvent(state, job, "stage.updated", { stage: "evolution", status: "skipped", summary: request.summary })];
        const latestVisual = [...state.stageRuns].reverse().find((item) => item.jobId === job.id && item.stage === "visual");
        if (latestVisual?.status === "completed") {
          this.assertPublishArtifacts(state, job.id);
          await this.archiveEvolution(state, job, request.summary);
          job.status = "completed"; job.summary = request.summary ?? job.summary; job.completedAt = timestamp;
          emitted.push(this.appendEvent(state, job, "job.completed", { summary: job.summary, artifacts: state.artifacts.filter((item) => item.jobId === job.id && item.validated).map((item) => ({ name: item.name, path: item.path, downloadUrl: item.downloadUrl })) }));
        } else if (latestVisual?.status === "failed") throw new AppError(409, "EVOLUTION_SKIP_INVALID", "evolution cannot be skipped after failed visual feedback");
        else job.currentStage = "visual";
        job.updatedAt = timestamp; this.touchConversation(state, job);
        return emitted;
      }
      if (job.currentStage !== request.stage) throw new AppError(409, "INVALID_STAGE", `expected ${job.currentStage}, received ${request.stage}`);
      const run = [...state.stageRuns].reverse().find((item) => item.jobId === job.id && item.stage === request.stage && item.status === "running");
      if (!run) {
        const completed = [...state.stageRuns].reverse().find((item) => item.jobId === job.id && item.stage === request.stage && item.status === "completed");
        if (request.action === "complete" && completed) return [];
        throw new AppError(409, "STAGE_NOT_RUNNING", "stage is not running");
      }
      const timestamp = now();
      const emitted: JobEvent[] = [];

      if (request.action === "complete") {
        await this.assertStageArtifacts(state, job.id, request.stage, run.id);
        run.status = "completed"; run.completedAt = timestamp; run.summary = request.summary; run.toolError = undefined;
        emitted.push(this.appendEvent(state, job, "stage.updated", { stage: request.stage, status: "completed", attempt: run.attempt, summary: request.summary }));
        const next = request.stage === "requirements" ? "codegen" : request.stage === "codegen" ? "visual" : request.stage === "visual" ? "evolution" : undefined;
        if (next) {
          job.currentStage = next;
          const attempt = Math.max(0, ...state.stageRuns.filter((item) => item.jobId === job.id && item.stage === next).map((item) => item.attempt)) + 1;
          state.stageRuns.push({ id: randomUUID(), jobId: job.id, stage: next, attempt, status: "running", usage: emptyUsage(), usageBaseline, startedAt: timestamp });
          emitted.push(this.appendEvent(state, job, "stage.updated", { stage: next, status: "running", attempt, label: eventName(next) }));
        } else if (request.stage === "evolution") {
          const latestVisual = [...state.stageRuns].reverse().find((item) => item.jobId === job.id && item.stage === "visual");
          if (latestVisual?.status !== "completed") throw new AppError(409, "EVOLUTION_REQUIRES_VISUAL_PASS", "evolution starts only after visual feedback passes");
          this.assertPublishArtifacts(state, job.id);
          await this.archiveEvolution(state, job, request.summary);
          job.status = "completed"; job.summary = request.summary ?? job.summary; job.completedAt = timestamp;
          emitted.push(this.appendEvent(state, job, "job.completed", {
            summary: job.summary,
            artifacts: state.artifacts.filter((item) => item.jobId === job.id && item.validated).map((item) => ({ name: item.name, path: item.path, downloadUrl: item.downloadUrl })),
          }));
        }
      } else if (request.action === "retry") {
        run.status = "failed"; run.completedAt = timestamp; run.error = request.error ?? run.toolError ?? { code: "STAGE_RETRY", message: request.summary ?? "stage retry requested" };
        emitted.push(this.appendEvent(state, job, "stage.updated", { stage: request.stage, status: "failed", attempt: run.attempt, retry: true }));
        const retryStage: Stage = request.stage === "visual" ? "codegen" : request.stage;
        const attempt = Math.max(0, ...state.stageRuns.filter((item) => item.jobId === job.id && item.stage === retryStage).map((item) => item.attempt)) + 1;
        job.currentStage = retryStage;
        state.stageRuns.push({ id: randomUUID(), jobId: job.id, stage: retryStage, attempt, status: "running", usage: emptyUsage(), usageBaseline, startedAt: timestamp });
        emitted.push(this.appendEvent(state, job, "stage.updated", { stage: retryStage, status: "running", attempt, retry: true }));
      } else if (request.action === "needs_input") {
        run.status = "waiting_input"; run.completedAt = timestamp; run.summary = request.summary;
        job.status = "waiting_input";
        emitted.push(this.appendEvent(state, job, "job.needs_input", { stage: request.stage, summary: request.summary }));
      } else {
        run.status = "failed"; run.completedAt = timestamp; run.error = request.error ?? run.toolError ?? { code: "STAGE_FAILED", message: request.summary ?? "stage failed" };
        job.status = "failed"; job.error = run.error; job.completedAt = timestamp;
        emitted.push(this.appendEvent(state, job, "stage.updated", { stage: request.stage, status: "failed", error: run.error }));
        emitted.push(this.appendEvent(state, job, "job.failed", { error: job.error }));
      }
      job.updatedAt = timestamp; job.backendHeartbeatAt = timestamp;
      this.touchConversation(state, job);
      return emitted;
    });
    this.store.publish(events);
    const jobId = events[0]?.jobId ?? this.store.read((state) => [...state.jobs].reverse().find((item) => item.openCodeSessionId === request.sessionID)?.id);
    if (!jobId) throw new AppError(404, "ACTIVE_JOB_NOT_FOUND", "job not found");
    return this.getSnapshot(jobId);
  }

  async cancel(jobId: string): Promise<JobSnapshot> {
    let sessionId: string | undefined;
    const events = await this.store.transaction((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job) throw notFound("job");
      if (isTerminalJob(job.status)) return [];
      const timestamp = now(); sessionId = job.openCodeSessionId;
      job.status = "cancelled"; job.completedAt = timestamp; job.updatedAt = timestamp;
      for (const run of state.stageRuns.filter((item) => item.jobId === jobId && item.status === "running")) { run.status = "cancelled"; run.completedAt = timestamp; }
      for (const artifact of state.artifacts.filter((item) => item.jobId === jobId)) artifact.partial = true;
      this.touchConversation(state, job);
      return [this.appendEvent(state, job, "job.cancelled", {})];
    });
    this.store.publish(events);
    if (sessionId) void this.adapter.abort(sessionId, this.getSnapshot(jobId).job.workspacePath).catch(() => undefined);
    return this.getSnapshot(jobId);
  }

  async retryJob(jobId: string): Promise<JobSnapshot> {
    let sessionId: string | undefined;
    const usageBaseline = await this.readUsageBaseline(this.getSnapshot(jobId).job);
    const events = await this.store.transaction((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job) throw notFound("job");
      if (job.status !== "failed") throw new AppError(409, "JOB_NOT_FAILED", "only a failed job can be retried");
      sessionId = job.openCodeSessionId;
      if (!sessionId) throw new AppError(409, "OPENCODE_SESSION_MISSING", "job has no OpenCode session");
      const stage = job.currentStage ?? "requirements";
      const attempt = Math.max(0, ...state.stageRuns.filter((item) => item.jobId === jobId && item.stage === stage).map((item) => item.attempt)) + 1;
      const timestamp = now();
      job.status = "running"; job.error = undefined; job.completedAt = undefined; job.updatedAt = timestamp;
      state.stageRuns.push({ id: randomUUID(), jobId, stage, attempt, status: "running", usage: emptyUsage(), usageBaseline, startedAt: timestamp });
      this.touchConversation(state, job);
      return [this.appendEvent(state, job, "stage.updated", { stage, attempt, status: "running", retry: true })];
    });
    this.store.publish(events);
    try {
      const job = this.getSnapshot(jobId).job;
      await this.adapter.prompt(sessionId!, "Continue the current CAD task from the failed stage. Inspect the previous error, repair it, and proceed.", job.workspacePath, this.promptModel(job));
    }
    catch (error) { await this.failJob(jobId, "OPENCODE_UNAVAILABLE", this.safeError(error)); }
    return this.getSnapshot(jobId);
  }

  listArtifacts(jobId: string): Artifact[] { return this.getSnapshot(jobId).artifacts; }

  async createUpload(conversationId: string, input: { filename: string; mimeType: string; data: Buffer }): Promise<Upload> {
    const conversation = this.getConversation(conversationId);
    if (conversation.deletionStatus) throw new AppError(409, "CONVERSATION_DELETING", "conversation is being deleted");
    const extensions: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
    const extension = extensions[input.mimeType];
    if (!extension) throw new AppError(415, "IMAGE_TYPE_UNSUPPORTED", "only PNG, JPEG and WebP images are supported");
    if (!input.data.length || input.data.length > 10 * 1024 * 1024) throw new AppError(413, "IMAGE_SIZE_INVALID", "image must be between 1 byte and 10 MiB");
    const validSignature = input.mimeType === "image/png"
      ? input.data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : input.mimeType === "image/jpeg"
        ? input.data[0] === 0xff && input.data[1] === 0xd8 && input.data[2] === 0xff
        : input.data.subarray(0, 4).toString("ascii") === "RIFF" && input.data.subarray(8, 12).toString("ascii") === "WEBP";
    if (!validSignature) throw new AppError(415, "IMAGE_SIGNATURE_INVALID", "file content does not match its image MIME type");
    const id = randomUUID();
    const directory = resolve(this.config.jobsRoot, "uploads", conversationId);
    await mkdir(directory, { recursive: true });
    const path = resolve(directory, `${id}${extension}`);
    await writeFile(path, input.data, { flag: "wx" });
    const originalBase = basename(input.filename, extname(input.filename)).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "reference";
    const upload: Upload = {
      id, conversationId, name: `${originalBase}${extension}`, path, mimeType: input.mimeType as Upload["mimeType"], size: input.data.length,
      createdAt: now(), downloadUrl: `/api/uploads/${id}/download`,
    };
    await this.store.transaction((state) => { state.uploads.push(upload); });
    return upload;
  }

  uploadDownload(uploadId: string): { upload: Upload; stream: ReturnType<typeof createReadStream> } {
    const upload = this.store.read((state) => state.uploads.find((item) => item.id === uploadId));
    if (!upload) throw notFound("upload");
    return { upload, stream: createReadStream(upload.path) };
  }

  async registerArtifact(input: { sessionID: string; path: string; kind: ArtifactKind; mimeType?: string; validated?: boolean; partial?: boolean }): Promise<Artifact> {
    const absolute = resolve(input.path);
    const jobsRoot = resolve(this.config.jobsRoot);
    if (absolute !== jobsRoot && !absolute.startsWith(`${jobsRoot}${sep}`)) throw new AppError(400, "ARTIFACT_OUTSIDE_JOBS_ROOT", "artifact path is outside jobs root");
    const file = await stat(absolute);
    if (!file.isFile()) throw new AppError(400, "ARTIFACT_NOT_FILE", "artifact must be a file");
    const emitted: JobEvent[] = [];
    const artifact = await this.store.transaction((state) => {
      const job = state.jobs.find((item) => item.openCodeSessionId === input.sessionID && !isTerminalJob(item.status));
      if (!job) throw new AppError(404, "ACTIVE_JOB_NOT_FOUND", "active job not found");
      const run = [...state.stageRuns].reverse().find((item) => item.jobId === job.id && item.status === "running");
      const id = randomUUID();
      const item: Artifact = {
        id, jobId: job.id, stageRunId: run?.id, name: basename(absolute), kind: input.kind, path: absolute,
        mimeType: input.mimeType ?? "application/octet-stream", size: file.size, validated: input.validated ?? false,
        partial: input.partial ?? false, createdAt: now(), downloadUrl: `/api/jobs/${job.id}/artifacts/${id}/download`,
      };
      state.artifacts.push(item);
      emitted.push(this.appendEvent(state, job, "artifact.created", { artifact: item }));
      if (item.kind === "image") emitted.push(this.appendEvent(state, job, "image.read", { artifactId: item.id, path: item.path }));
      return item;
    });
    this.store.publish(emitted);
    return artifact;
  }

  artifactDownload(jobId: string, artifactId: string): { artifact: Artifact; stream: ReturnType<typeof createReadStream> } {
    const artifact = this.store.read((state) => state.artifacts.find((item) => item.jobId === jobId && item.id === artifactId));
    if (!artifact) throw notFound("artifact");
    return { artifact, stream: createReadStream(artifact.path) };
  }

  async ingestOpenCodeEvent(raw: OpenCodeEvent): Promise<void> {
    const properties = raw.properties ?? {};
    const part = properties.part as any;
    const sessionId = String(properties.sessionID ?? properties.sessionId ?? (properties.info as any)?.sessionID ?? part?.sessionID ?? part?.sessionId ?? "");
    if (!sessionId) return;
    const job = this.store.read((state) => [...state.jobs].reverse().find((item) => item.openCodeSessionId === sessionId));
    if (!job) return;
    const type = raw.type;
    const isToolEvent = type.includes("tool") || part?.type === "tool" || Boolean(properties.tool);
    const delta = properties.delta;
    if (!isTerminalJob(job.status) && type.includes("part") && typeof delta === "string") await this.appendAssistantDelta(job.id, delta);
    const info = properties.info as any;
    if ((type === "session.idle" || (type.includes("message") && info?.role === "assistant" && info?.tokens)) && job.openCodeSessionId) {
      try { await this.reconcileUsage(job.id, await this.adapter.messages(job.openCodeSessionId, job.workspacePath)); }
      catch { /* The supervisor retries reconciliation without disrupting event ingestion. */ }
    }
    if (!isTerminalJob(job.status) && isToolEvent) await this.recordToolEvent(job.id, type, properties);
    if (type === "session.idle") await this.completeAssistantMessage(job.id);
    if (type.includes("error") && !isToolEvent) {
      const error = this.classifyOpenCodeError(this.extractErrorText({
        error: properties.error,
        info: properties.info,
        part: properties.part,
        type,
      }));
      await this.failJob(job.id, error.code, error.message, error);
    }
    await this.store.transaction((state) => {
      const current = state.jobs.find((item) => item.id === job.id);
      if (current) { current.lastOpenCodeEventAt = now(); current.backendHeartbeatAt = now(); }
    });
  }

  private async recordToolEvent(jobId: string, rawType: string, properties: Record<string, unknown>): Promise<void> {
    const events = await this.store.transaction((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job || isTerminalJob(job.status)) return [];
      const part = properties.part as any;
      const tool = properties.tool ?? part?.tool;
      const status = properties.status ?? part?.state?.status;
      const detail = status === "error" || rawType.includes("error")
        ? this.extractErrorText(part?.state?.error ?? part?.error ?? properties.error)
        : undefined;
      const error = detail ? this.classifyOpenCodeError(detail, "tool") : undefined;
      const run = [...state.stageRuns].reverse().find((item) => item.jobId === jobId && item.status === "running");
      if (run && error) run.toolError = error;
      if (run && status === "completed" && tool === "cadir_run") run.toolError = undefined;
      const safe = { tool, status, rawType, error, clearToolError: status === "completed" && tool === "cadir_run" };
      return [this.appendEvent(state, job, "tool.updated", safe)];
    });
    this.store.publish(events);
  }

  async heartbeatActive(): Promise<void> {
    await this.store.transaction((state) => {
      const timestamp = now();
      for (const job of state.jobs) if (!isTerminalJob(job.status)) job.backendHeartbeatAt = timestamp;
    });
  }

  activeJobs(): Job[] {
    return this.store.read((state) => state.jobs.filter((job) => !isTerminalJob(job.status)));
  }

  usageReconciliationJobs(): Job[] {
    return this.store.read((state) => state.jobs.filter((job) => {
      if (!job.openCodeSessionId) return false;
      if (!isTerminalJob(job.status)) return true;
      const total = sumUsage(state.stageRuns.filter((run) => run.jobId === job.id).map((run) => run.usage)).total;
      return total === 0;
    }));
  }

  private async completeAssistantMessage(jobId: string): Promise<void> {
    const events = await this.store.transaction((state) => {
      const job = state.jobs.find((item) => item.id === jobId)!;
      const message = [...state.messages].reverse().find((item) => item.jobId === jobId && item.role === "assistant" && !item.completedAt);
      if (!message) return [];
      message.completedAt = now();
      return [this.appendEvent(state, job, "message.completed", { messageId: message.id })];
    });
    this.store.publish(events);
  }

  async reconcileUsage(jobId: string, messages: unknown[]): Promise<void> {
    const expected = usageFromMessages(messages);
    const events = await this.store.transaction((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job) return [];
      const runs = state.stageRuns.filter((item) => item.jobId === jobId);
      const runningIndex = [...runs].reverse().findIndex((item) => item.status === "running");
      const runIndex = runningIndex >= 0 ? runs.length - 1 - runningIndex : runs.length - 1;
      const run = runs[runIndex];
      if (!run) return [];
      // Legacy StageRuns have no baseline; prior attempts are the closest safe approximation.
      const baseline = run.usageBaseline ?? sumUsage(runs.slice(0, runIndex).map((item) => item.usage));
      const delta = subtractUsage(subtractUsage(expected, baseline), run.usage);
      if (Object.values(delta).every((value) => value === 0)) return [];
      run.usage = {
        input: run.usage.input + delta.input,
        output: run.usage.output + delta.output,
        reasoning: run.usage.reasoning + delta.reasoning,
        cacheRead: run.usage.cacheRead + delta.cacheRead,
        cacheWrite: run.usage.cacheWrite + delta.cacheWrite,
        total: run.usage.total + delta.total,
      };
      return [this.appendEvent(state, job, "usage.updated", { stageRunId: run.id, usage: run.usage, cumulative: expected, baseline })];
    });
    this.store.publish(events);
  }

  private async readUsageBaseline(job?: Job): Promise<TokenUsage> {
    if (!job?.openCodeSessionId) return emptyUsage();
    try {
      return usageFromMessages(await this.adapter.messages(job.openCodeSessionId, job.workspacePath));
    } catch {
      return emptyUsage();
    }
  }

  private async appendAssistantDelta(jobId: string, delta: string): Promise<void> {
    const events = await this.store.transaction((state) => {
      const job = state.jobs.find((item) => item.id === jobId)!;
      const run = [...state.stageRuns].reverse().find((item) => item.jobId === jobId && item.status === "running");
      if (run) run.output = `${run.output ?? ""}${delta}`;
      let message = [...state.messages].reverse().find((item) => item.jobId === jobId && item.role === "assistant" && !item.completedAt);
      const emitted: JobEvent[] = [];
      if (!message) {
        message = { id: randomUUID(), conversationId: job.conversationId, jobId, role: "assistant", content: "", imageArtifactIds: [], createdAt: now() };
        state.messages.push(message);
        emitted.push(this.appendEvent(state, job, "message.started", { messageId: message.id }));
      }
      message.content += delta;
      emitted.push(this.appendEvent(state, job, "message.delta", { messageId: message.id, delta }));
      return emitted;
    });
    this.store.publish(events);
  }

  async failJob(jobId: string, code: string, message: string, errorDetails: Partial<JobError> = {}): Promise<void> {
    const error: JobError = { code, message, ...errorDetails };
    await this.persistJobFailure(jobId, error, false);
  }

  async failJobFromMessages(jobId: string, messages: unknown[]): Promise<boolean> {
    const includeToolErrors = this.store.read((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      return Boolean(job && isTerminalJob(job.status));
    });
    const raw = this.findMessageError(messages, includeToolErrors);
    if (!raw) return false;
    await this.persistJobFailure(jobId, this.classifyOpenCodeError(raw.detail, raw.source), true);
    return true;
  }

  private async persistJobFailure(jobId: string, error: JobError, refineTerminal: boolean): Promise<void> {
    const events = await this.store.transaction((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job) return [];
      if (isTerminalJob(job.status)) {
        if (!refineTerminal || job.status !== "failed" || job.error?.detail === error.detail) return [];
        job.error = error;
        const failedRun = [...state.stageRuns].reverse().find((item) => item.jobId === job.id && item.status === "failed");
        if (failedRun) failedRun.error = error;
        job.updatedAt = now();
        this.touchConversation(state, job);
        return [this.appendEvent(state, job, "job.failed", { error, refined: true })];
      }
      const timestamp = now(); job.status = "failed"; job.error = error; job.updatedAt = timestamp; job.completedAt = timestamp;
      for (const run of state.stageRuns.filter((item) => item.jobId === job.id && item.status === "running")) { run.status = "failed"; run.completedAt = timestamp; run.error = error; }
      this.touchConversation(state, job);
      return [this.appendEvent(state, job, "job.failed", { error })];
    });
    this.store.publish(events);
  }

  private findMessageError(messages: unknown[], includeToolErrors = false): { detail: string; source?: JobError["source"] } | undefined {
    for (const entry of [...messages].reverse() as any[]) {
      const info = entry?.info ?? {};
      const parts = Array.isArray(entry?.parts) ? entry.parts : [];
      const candidates: Array<{ value: unknown; source?: JobError["source"] }> = [
        { value: info.error, source: "model_provider" },
        { value: entry?.error, source: "model_provider" },
      ];
      if (includeToolErrors) candidates.push(...parts.map((part: any) => ({ value: part?.error ?? part?.state?.error, source: "tool" as const })));
      for (const candidate of candidates) {
        const detail = this.extractErrorText(candidate.value);
        if (detail) return { detail, source: candidate.source };
      }
    }
    return undefined;
  }

  private extractErrorText(value: unknown, depth = 0): string | undefined {
    if (depth > 4 || value === undefined || value === null) return undefined;
    if (typeof value === "string") return value.trim() || undefined;
    if (value instanceof Error) return value.message;
    if (typeof value !== "object") return String(value);
    const record = value as Record<string, unknown>;
    for (const key of ["message", "detail", "error", "data", "cause", "body"]) {
      const nested = this.extractErrorText(record[key], depth + 1);
      if (nested) return nested;
    }
    try { return JSON.stringify(value); } catch { return undefined; }
  }

  private classifyOpenCodeError(detail: string | undefined, sourceHint?: JobError["source"]): JobError {
    const safeDetail = this.sanitizeDetail(detail ?? "OpenCode reported an execution error");
    const lower = safeDetail.toLowerCase();
    if (lower.includes("concurrency limit") || lower.includes("too many concurrent")) {
      return { code: "PROVIDER_CONCURRENCY_LIMIT", message: "模型服务当前并发已满，请稍后重新运行。", detail: safeDetail, retryable: true, source: "model_provider" };
    }
    if (lower.includes("rate limit") || lower.includes("status code 429") || lower.includes("too many requests")) {
      return { code: "PROVIDER_RATE_LIMIT", message: "模型服务请求频率受限，请稍后重新运行。", detail: safeDetail, retryable: true, source: "model_provider" };
    }
    if (lower.includes("timeout") || lower.includes("timed out")) {
      return { code: "PROVIDER_TIMEOUT", message: "模型服务响应超时，可以重新运行。", detail: safeDetail, retryable: true, source: "model_provider" };
    }
    if (lower.includes("unauthorized") || lower.includes("authentication") || lower.includes("invalid api key") || lower.includes("status code 401")) {
      return { code: "PROVIDER_AUTH_FAILED", message: "模型服务鉴权失败，请检查服务端 API 配置。", detail: safeDetail, retryable: false, source: "model_provider" };
    }
    if (lower.includes("model not found") || lower.includes("does not exist") || lower.includes("status code 404")) {
      return { code: "MODEL_UNAVAILABLE", message: "当前模型不可用，请在 User 设置中选择其他模型。", detail: safeDetail, retryable: false, source: "model_provider" };
    }
    if (lower.includes("context length") || lower.includes("maximum context") || lower.includes("token limit")) {
      return { code: "CONTEXT_LIMIT_EXCEEDED", message: "当前任务超出模型上下文限制，请新建任务后重试。", detail: safeDetail, retryable: false, source: "model_provider" };
    }
    if (sourceHint === "tool" || lower.includes("tool")) {
      return { code: "TOOL_EXECUTION_FAILED", message: "CAD 工具执行失败，请检查阶段详情后重试。", detail: safeDetail, retryable: true, source: "tool" };
    }
    return { code: "OPENCODE_ERROR", message: "OpenCode 执行失败，请查看技术详情。", detail: safeDetail, retryable: true, source: sourceHint ?? "opencode" };
  }

  private sanitizeDetail(value: string): string {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
      .replace(/(sk-[A-Za-z0-9_-]+)/g, "[REDACTED]")
      .replace(/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
      .slice(0, 1000);
  }

  private async assertStageArtifacts(state: DatabaseState, jobId: string, stage: Stage, stageRunId: string): Promise<void> {
    const artifacts = state.artifacts.filter((item) => item.jobId === jobId && item.validated);
    const has = (suffix: string): boolean => artifacts.some((item) => item.name.toLowerCase().endsWith(suffix.toLowerCase()));
    if (stage === "requirements") {
      const requirements = artifacts.find((item) => item.name === "requirements.md" && item.kind === "requirements");
      if (!requirements) throw new AppError(409, "REQUIREMENTS_MISSING", "validated requirements.md is required");
      await this.validateRequirementsMarkdown(requirements.path);
    }
    const currentStageArtifacts = artifacts.filter((item) => item.stageRunId === stageRunId);
    if (stage === "codegen" && !(currentStageArtifacts.some((item) => item.name === "model.py" && item.kind === "python") && currentStageArtifacts.some((item) => item.name === "model.json"))) {
      throw new AppError(409, "CODEGEN_ARTIFACTS_MISSING", "validated model.py and model.json artifacts are required");
    }
    if (stage === "visual") {
      const requiredViews = ["render-isometric.png", "render-front.png", "render-top.png", "render-right.png"];
      const currentRenderNames = new Set(artifacts
        .filter((item) => item.kind === "image" && item.stageRunId === stageRunId)
        .map((item) => basename(item.name).toLowerCase()));
      const missing = requiredViews.filter((name) => !currentRenderNames.has(name));
      if (missing.length) throw new AppError(409, "VISUAL_ARTIFACT_MISSING", `current visual attempt is missing validated renders: ${missing.join(", ")}`);
    }
  }

  private async validateRequirementsMarkdown(path: string): Promise<void> {
    let document: string;
    try { document = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)); }
    catch { throw new AppError(409, "REQUIREMENTS_INVALID_UTF8", "requirements.md must be valid UTF-8"); }
    const lines = document.replace(/\r\n/g, "\n").split("\n");
    if (!lines.some((line) => line.trim() === "# \u5efa\u6a21\u9700\u6c42")) throw new AppError(409, "REQUIREMENTS_HEADING_MISSING", "requirements.md must contain the required title");
    const headings = ["\u5bf9\u8c61", "\u5355\u4f4d", "\u5c3a\u5bf8", "\u529f\u80fd\u4e0e\u51e0\u4f55\u7ea6\u675f", "\u5047\u8bbe", "\u5efa\u6a21\u6b65\u9aa4", "\u9a8c\u6536\u68c0\u67e5", "\u5f85\u786e\u8ba4\u4fe1\u606f"];
    const indexes = headings.map((heading) => lines.findIndex((line) => line.trim() === `## ${heading}`));
    if (indexes.some((index) => index < 0) || indexes.some((index, position) => position > 0 && index <= indexes[position - 1])) {
      throw new AppError(409, "REQUIREMENTS_SECTIONS_INVALID", "requirements.md must contain all required sections in order");
    }
    for (let position = 0; position < indexes.length; position += 1) {
      const body = lines.slice(indexes[position] + 1, indexes[position + 1] ?? lines.length).join("\n").trim();
      if (!body) throw new AppError(409, "REQUIREMENTS_SECTION_EMPTY", `requirements.md section ${headings[position]} must not be empty`);
    }
  }

  private resolveUploads(conversationId: string, ids: string[]): Upload[] {
    if (new Set(ids).size !== ids.length) throw new AppError(400, "DUPLICATE_UPLOAD", "image upload IDs must be unique");
    return this.store.read((state) => ids.map((id) => {
      const upload = state.uploads.find((item) => item.id === id && item.conversationId === conversationId);
      if (!upload) throw new AppError(400, "UPLOAD_NOT_FOUND", `image upload ${id} does not belong to this conversation`);
      return upload;
    }));
  }

  private async localizeUploads(workspacePath: string, uploads: Upload[]): Promise<Array<{ upload: Upload; localPath: string }>> {
    if (!uploads.length) return [];
    const directory = resolve(workspacePath, "inputs");
    await mkdir(directory, { recursive: true });
    return await Promise.all(uploads.map(async (upload) => {
      const localPath = resolve(directory, `${upload.id}-${randomUUID()}${extname(upload.path).toLowerCase()}`);
      await copyFile(upload.path, localPath);
      return { upload, localPath };
    }));
  }

  private assertPublishArtifacts(state: DatabaseState, jobId: string): void {
    const artifacts = state.artifacts.filter((item) => item.jobId === jobId && item.validated);
    const names = new Set(artifacts.filter((item) => !item.partial).map((item) => item.name.toLowerCase()));
    const required = [
      "requirements.md", "model.py", "model.json", "model.step", "model.stl", "model.fcstd", "manifest.json",
      "render-isometric.png", "render-front.png", "render-top.png", "render-right.png", "summary.md", "experience.md",
    ];
    const missing = required.filter((name) => !names.has(name));
    if (missing.length) {
      throw new AppError(409, "FINAL_ARTIFACTS_MISSING", `completion is missing validated artifacts: ${missing.join(", ")}`);
    }
  }

  private async performConversationDeletion(conversationId: string): Promise<DeleteConversationResult> {
    const plan = await this.store.transaction((state) => {
      const conversation = state.conversations.find((item) => item.id === conversationId);
      if (!conversation) return undefined;
      const timestamp = now();
      conversation.deletionStatus = "deleting";
      conversation.deletionError = undefined;
      conversation.updatedAt = timestamp;
      conversation.revision += 1;
      const jobs = state.jobs.filter((item) => item.conversationId === conversationId);
      const emitted: JobEvent[] = [];
      for (const job of jobs) {
        if (isTerminalJob(job.status)) continue;
        job.status = "cancelled";
        job.completedAt = timestamp;
        job.updatedAt = timestamp;
        for (const run of state.stageRuns.filter((item) => item.jobId === job.id && item.status === "running")) {
          run.status = "cancelled";
          run.completedAt = timestamp;
        }
        for (const artifact of state.artifacts.filter((item) => item.jobId === job.id)) artifact.partial = true;
        emitted.push(this.appendEvent(state, job, "job.cancelled", { reason: "conversation_deleted" }));
      }
      return {
        events: emitted,
        jobs: jobs.map((job) => ({ ...job })),
        retainedRagEntries: state.ragEntries.filter((item) => item.sourceConversationId === conversationId).length,
      };
    });
    if (!plan) return { deleted: true, alreadyDeleted: true, conversationId, retainedRagEntries: 0 };
    this.store.publish(plan.events);

    try {
      const sessions = new Map<string, Job>();
      for (const job of plan.jobs) if (job.openCodeSessionId) sessions.set(job.openCodeSessionId, job);
      for (const [sessionId, job] of sessions) {
        await this.adapter.abort(sessionId, job.workspacePath).catch(() => undefined);
        await this.adapter.deleteSession(sessionId, job.workspacePath).catch(() => undefined);
      }
      for (const job of plan.jobs) await this.removeWithinRoot(this.config.jobsRoot, job.workspacePath);
      await this.removeWithinRoot(this.config.jobsRoot, resolve(this.config.jobsRoot, "uploads", conversationId));

      const jobIds = new Set(plan.jobs.map((job) => job.id));
      await this.store.transaction((state) => {
        state.conversations = state.conversations.filter((item) => item.id !== conversationId);
        state.jobs = state.jobs.filter((item) => !jobIds.has(item.id));
        state.stageRuns = state.stageRuns.filter((item) => !jobIds.has(item.jobId));
        state.messages = state.messages.filter((item) => item.conversationId !== conversationId);
        state.artifacts = state.artifacts.filter((item) => !jobIds.has(item.jobId));
        state.uploads = state.uploads.filter((item) => item.conversationId !== conversationId);
        state.events = state.events.filter((item) => !jobIds.has(item.jobId));
      });
      return { deleted: true, conversationId, retainedRagEntries: plan.retainedRagEntries };
    } catch (error) {
      const message = this.safeError(error);
      await this.store.transaction((state) => {
        const conversation = state.conversations.find((item) => item.id === conversationId);
        if (conversation) {
          conversation.deletionStatus = "failed";
          conversation.deletionError = message;
          conversation.updatedAt = now();
          conversation.revision += 1;
        }
      });
      throw new AppError(500, "CONVERSATION_DELETE_FAILED", message);
    }
  }

  private async archiveEvolution(state: DatabaseState, job: Job, transitionSummary?: string): Promise<RagArchiveEntry> {
    const existing = state.ragEntries.find((item) => item.sourceJobId === job.id);
    if (existing) return existing;
    const conversation = state.conversations.find((item) => item.id === job.conversationId);
    if (!conversation) throw notFound("conversation");
    const latestArtifact = (name: string): Artifact | undefined => [...state.artifacts].reverse().find((item) =>
      item.jobId === job.id && item.validated && !item.partial && item.name.toLowerCase() === name.toLowerCase());
    const required: Array<{ name: string; mimeType: string }> = [
      { name: "model.py", mimeType: "text/x-python" },
      { name: "model.json", mimeType: "application/json" },
      { name: "render-isometric.png", mimeType: "image/png" },
      { name: "render-front.png", mimeType: "image/png" },
      { name: "render-top.png", mimeType: "image/png" },
      { name: "render-right.png", mimeType: "image/png" },
      { name: "summary.md", mimeType: "text/markdown" },
      { name: "experience.md", mimeType: "text/markdown" },
    ];
    const sources = required.map((file) => ({ ...file, artifact: latestArtifact(file.name) }));
    const missing = sources.filter((item) => !item.artifact).map((item) => item.name);
    if (missing.length) throw new AppError(409, "RAG_ARCHIVE_ARTIFACTS_MISSING", `RAG archive is missing: ${missing.join(", ")}`);

    const entriesRoot = resolve(this.config.ragLibraryRoot, "entries");
    const finalPath = resolve(entriesRoot, job.id);
    this.assertChildPath(this.config.ragLibraryRoot, finalPath);
    try {
      const archived = JSON.parse(await readFile(resolve(finalPath, "manifest.json"), "utf8")) as RagManifest;
      if (archived.sourceJobId !== job.id) throw new Error("archive entry source mismatch");
      const manifestPath = resolve(finalPath, "manifest.json");
      const manifestStat = await stat(manifestPath);
      const files: RagArchiveFile[] = [...archived.files, {
        name: "manifest.json", relativePath: "manifest.json", mimeType: "application/json",
        size: manifestStat.size, sha256: await this.sha256File(manifestPath),
      }];
      const recovered: RagArchiveEntry = {
        id: job.id, sourceConversationId: job.conversationId, sourceJobId: job.id,
        sourceTitle: conversation.title, path: finalPath, summary: archived.summary, files, createdAt: archived.createdAt,
      };
      state.ragEntries.push(recovered);
      return recovered;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AppError(500, "RAG_ARCHIVE_INVALID", "existing RAG archive entry is invalid");
      }
    }

    const temporaryPath = resolve(entriesRoot, `.tmp-${job.id}-${randomUUID()}`);
    this.assertChildPath(this.config.ragLibraryRoot, temporaryPath);
    await mkdir(temporaryPath, { recursive: true });
    try {
      const files: RagArchiveFile[] = [];
      for (const source of sources) {
        const destination = resolve(temporaryPath, source.name);
        await copyFile(source.artifact!.path, destination);
        const file = await stat(destination);
        files.push({
          name: source.name, relativePath: source.name, mimeType: source.mimeType,
          size: file.size, sha256: await this.sha256File(destination),
        });
      }
      const summary = (await readFile(resolve(temporaryPath, "summary.md"), "utf8")).trim();
      const publishManifest = latestArtifact("manifest.json");
      let validation: unknown;
      if (publishManifest) {
        try { validation = (JSON.parse(await readFile(publishManifest.path, "utf8")) as Record<string, unknown>).validation; }
        catch { /* The publish guard already validates the manifest's presence. */ }
      }
      const createdAt = now();
      const manifest: RagManifest = {
        schemaVersion: 1, id: job.id, sourceConversationId: job.conversationId, sourceJobId: job.id,
        sourceTitle: conversation.title, createdAt, summary: summary || transitionSummary || job.summary || "CAD model archived",
        transitionSummary, validation, files,
      };
      await writeFile(resolve(temporaryPath, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      await mkdir(entriesRoot, { recursive: true });
      await rename(temporaryPath, finalPath);
      const manifestPath = resolve(finalPath, "manifest.json");
      const manifestFile = await stat(manifestPath);
      const archiveFiles = [...files, {
        name: "manifest.json", relativePath: "manifest.json", mimeType: "application/json",
        size: manifestFile.size, sha256: await this.sha256File(manifestPath),
      }];
      const entry: RagArchiveEntry = {
        id: job.id, sourceConversationId: job.conversationId, sourceJobId: job.id,
        sourceTitle: conversation.title, path: finalPath, summary: manifest.summary, files: archiveFiles, createdAt,
      };
      state.ragEntries.push(entry);
      return entry;
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError(500, "RAG_ARCHIVE_FAILED", this.safeError(error));
    }
  }

  private assertChildPath(root: string, target: string): void {
    const absoluteRoot = resolve(root);
    const absoluteTarget = resolve(target);
    if (absoluteTarget === absoluteRoot || !absoluteTarget.startsWith(`${absoluteRoot}${sep}`)) {
      throw new AppError(500, "PATH_BOUNDARY_VIOLATION", "refusing filesystem operation outside the configured root");
    }
  }

  private async removeWithinRoot(root: string, target: string): Promise<void> {
    this.assertChildPath(root, target);
    await rm(resolve(target), { recursive: true, force: true });
  }

  private async sha256File(path: string): Promise<string> {
    const hash = createHash("sha256");
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(path);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolvePromise);
    });
    return hash.digest("hex");
  }

  private appendEvent(state: DatabaseState, job: Job, type: JobEvent["type"], data: Record<string, unknown>): JobEvent {
    const last = state.events.filter((event) => event.jobId === job.id).at(-1)?.seq ?? 0;
    const event: JobEvent = { seq: last + 1, eventId: randomUUID(), jobId: job.id, conversationId: job.conversationId, sessionId: job.openCodeSessionId, timestamp: now(), type, data };
    state.events.push(event);
    return event;
  }

  private touchConversation(state: DatabaseState, job: Job): void {
    const conversation = state.conversations.find((item) => item.id === job.conversationId)!;
    conversation.latestJobId = job.id; conversation.latestJobStatus = job.status; conversation.updatedAt = now(); conversation.revision += 1;
  }

  private promptModel(job: Job): { modelId: string; providerId: string; effort: ModelEffort } {
    return {
      modelId: job.modelId ?? this.config.modelId,
      providerId: job.modelProvider ?? this.config.modelProvider,
      effort: job.effort ?? "medium",
    };
  }

  private safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : "OpenCode request failed";
    return message.replace(/(sk-[A-Za-z0-9_-]+)/g, "[REDACTED]").slice(0, 300);
  }
}

interface DeleteConversationResult {
  deleted: true;
  conversationId: string;
  retainedRagEntries: number;
  alreadyDeleted?: boolean;
}

interface RagManifest {
  schemaVersion: 1;
  id: string;
  sourceConversationId: string;
  sourceJobId: string;
  sourceTitle: string;
  createdAt: string;
  summary: string;
  transitionSummary?: string;
  validation?: unknown;
  files: RagArchiveFile[];
}
