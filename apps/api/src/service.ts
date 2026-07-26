import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_RETRIEVAL_SUBGRAPH_TOP_K, DEFAULT_RETRIEVAL_TEXT_TOP_K, DEFAULT_SUBGRAPH_MAX_NODES,
  MAX_RETRIEVAL_TOP_K, MAX_SUBGRAPH_MAX_NODES, MIN_RETRIEVAL_TOP_K, MIN_SUBGRAPH_MAX_NODES, RETRIEVAL_MODES, RETRIEVAL_POOLS,
  emptyUsage, isTerminalJob,
  type Artifact, type ArtifactKind, type Conversation, type CreateMessageRequest,
  type Job, type JobError, type JobEvent, type JobSnapshot, type RagArchiveEntry, type RagArchiveFile,
  type ModelEffort, type ModelOption, type ModelSettings, type ModelSettingsResponse, type RetrievalMode, type RetrievalPool, type RetrievalSource,
  type Stage, type StageRun, type StageTransitionRequest, type TokenUsage, type ToolActivity, type Upload,
} from "../../../packages/contracts/src/index.js";
import type { AppConfig } from "./config.js";
import { AppError, notFound } from "./errors.js";
import type { OpenCodeAdapter, OpenCodeEvent } from "./opencode.js";
import {
  createRetrievalAdapter,
  type RetrievalAdapter,
  type RetrievalCaseResult,
  type HybridRetrievalQueryOptions,
  type RetrievalQueryOptions,
  type RetrievalResponse,
} from "./retrieval.js";
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
const retrievalModeIds = new Set<RetrievalMode>(RETRIEVAL_MODES);
const retrievalPoolIds = new Set<RetrievalPool>(RETRIEVAL_POOLS);

function retrievalSources(pool: RetrievalPool): RetrievalSource[] {
  if (pool === "base") return ["base"];
  if (pool === "dynamic") return ["dynamic"];
  return ["base", "dynamic"];
}

function sumUsage(values: TokenUsage[]): TokenUsage {
  const summed = values.reduce((sum, item) => ({
    input: sum.input + item.input, output: sum.output + item.output,
    reasoning: sum.reasoning + item.reasoning, cacheRead: sum.cacheRead + item.cacheRead,
    cacheWrite: sum.cacheWrite + item.cacheWrite, total: 0,
  }), emptyUsage());
  summed.total = summed.input + summed.output + summed.reasoning;
  return summed;
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
    total: 0,
  };
  usage.total = usage.input + usage.output + usage.reasoning;
  return usage;
}

function usageFromMessages(messages: unknown[]): TokenUsage {
  return sumUsage(messages
    .filter((entry: any) => entry?.info?.role === "assistant" && entry.info.tokens)
    .map((entry: any) => tokenUsage(entry.info.tokens)));
}

function subtractUsage(current: TokenUsage, baseline: TokenUsage): TokenUsage {
  const difference = {
    input: Math.max(0, current.input - baseline.input),
    output: Math.max(0, current.output - baseline.output),
    reasoning: Math.max(0, current.reasoning - baseline.reasoning),
    cacheRead: Math.max(0, current.cacheRead - baseline.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - baseline.cacheWrite),
    total: 0,
  };
  difference.total = difference.input + difference.output + difference.reasoning;
  return difference;
}

function withoutCacheTotal(usage: TokenUsage): TokenUsage {
  return { ...usage, total: usage.input + usage.output + usage.reasoning };
}

export class CadirService {
  private readonly pendingFailures = new Map<string, { error: JobError; timer: NodeJS.Timeout }>();

  private readonly deletionTasks = new Map<string, Promise<DeleteConversationResult>>();
  private readonly indexingTasks = new Map<string, Promise<void>>();

  constructor(
    readonly store: JsonStore,
    private readonly adapter: OpenCodeAdapter,
    private readonly config: AppConfig,
    private readonly retrieval: RetrievalAdapter = createRetrievalAdapter(config),
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

  private findConversationJob(conversationId: string): Job | undefined {
    return this.store.read((state) => {
      const conversation = state.conversations.find((item) => item.id === conversationId);
      if (!conversation) return undefined;
      const active = [...state.jobs].reverse().find((item) => item.conversationId === conversationId && !isTerminalJob(item.status));
      if (active) return active;
      if (conversation.jobId) {
        const mapped = state.jobs.find((item) => item.id === conversation.jobId && item.conversationId === conversationId);
        if (mapped) return mapped;
      }
      if (conversation.latestJobId) {
        const latest = state.jobs.find((item) => item.id === conversation.latestJobId && item.conversationId === conversationId);
        if (latest) return latest;
      }
      return [...state.jobs].reverse().find((item) => item.conversationId === conversationId);
    });
  }

  private jobRevision(job: Job): number {
    return Math.max(1, job.revision ?? 1);
  }

  private isCurrentRevision(job: Job, revision: number | undefined): boolean {
    return (revision ?? 1) === this.jobRevision(job);
  }

  private currentStageRuns(state: Readonly<DatabaseState>, job: Job): StageRun[] {
    return state.stageRuns.filter((run) => run.jobId === job.id && this.isCurrentRevision(job, run.revision));
  }

  private stageEventData(run: StageRun, data: Record<string, unknown> = {}): Record<string, unknown> {
    return { stage: run.stage, status: run.status, attempt: run.attempt, stageRunId: run.id, revision: run.revision ?? 1, ...data };
  }

  private upsertToolActivity(state: DatabaseState, job: Job, activity: ToolActivity): StageRun | undefined {
    const revision = this.jobRevision(job);
    const existingRun = [...state.stageRuns].reverse().find((run) =>
      run.jobId === job.id
      && (run.revision ?? 1) === revision
      && run.toolActivities?.some((item) => item.id === activity.id),
    );
    const currentRun = existingRun ?? [...state.stageRuns].reverse().find((run) =>
      run.jobId === job.id
      && (run.revision ?? 1) === revision
      && run.stage === job.currentStage,
    );
    if (!currentRun) return undefined;
    if (activity.outputOffset === undefined) activity.outputOffset = currentRun.output?.length ?? 0;
    const activities = currentRun.toolActivities ?? [];
    const index = activities.findIndex((item) => item.id === activity.id);
    if (index >= 0) activities[index] = { ...activities[index], ...activity };
    else activities.push(activity);
    currentRun.toolActivities = activities;
    return currentRun;
  }

  private toolEventData(run: StageRun | undefined, activity: ToolActivity): Record<string, unknown> {
    return {
      activity,
      tool: activity.tool,
      stage: run?.stage,
      stageRunId: run?.id,
      revision: run?.revision ?? 1,
    };
  }

  private compactText(value: unknown, limit = 360): string | undefined {
    if (typeof value !== "string") return undefined;
    const text = value.replace(/\s+/g, " ").trim();
    if (!text) return undefined;
    return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
  }

  private retrievedCaseSummary(value: Record<string, unknown>): string | undefined {
    const metadata = value.metadata && typeof value.metadata === "object" ? value.metadata as Record<string, unknown> : undefined;
    const content = value.content && typeof value.content === "object" ? value.content as Record<string, unknown> : undefined;
    return this.compactText(value.summary ?? metadata?.summary ?? content?.summary);
  }

  private appendLegacyToolActivities(stageRuns: StageRun[], events: JobEvent[]): void {
    const findRun = (timestamp: string): StageRun | undefined => {
      const time = new Date(timestamp).getTime();
      return [...stageRuns].reverse().find((run) => {
        const started = new Date(run.startedAt).getTime();
        const completed = run.completedAt ? new Date(run.completedAt).getTime() : Number.POSITIVE_INFINITY;
        return started <= time && time <= completed + 1_000;
      }) ?? [...stageRuns].reverse().find((run) => new Date(run.startedAt).getTime() <= time);
    };
    const push = (run: StageRun | undefined, activity: ToolActivity): void => {
      if (!run) return;
      run.toolActivities = [...(run.toolActivities ?? []), activity];
    };

    const hasRetrieval = stageRuns.some((run) => run.toolActivities?.some((item) => item.tool === "cadir_retrieve"));
    if (!hasRetrieval) {
      const starts = events.filter((event) => event.type === "retrieval.started" && !event.data.activity);
      starts.forEach((started, index) => {
        const nextSeq = starts[index + 1]?.seq ?? Number.POSITIVE_INFINITY;
        const terminal = events.find((event) =>
          event.seq > started.seq && event.seq < nextSeq
          && (event.type === "retrieval.completed" || event.type === "retrieval.failed"),
        );
        const cases = Array.isArray(terminal?.data.cases) ? terminal.data.cases as Array<Record<string, unknown>> : [];
        const summaries = cases
          .map((item) => this.compactText(item.summary, 120))
          .filter((item): item is string => Boolean(item))
          .slice(0, 3);
        const status = terminal?.type === "retrieval.failed" ? "failed" : terminal ? "completed" : "running";
        push(findRun(started.timestamp), {
          id: `legacy-retrieval-${started.eventId}`,
          tool: "cadir_retrieve",
          status,
          orderSeq: started.seq,
          query: this.compactText(started.data.query, 240),
          resultCount: terminal?.type === "retrieval.completed" ? Number(terminal.data.returnedCount ?? cases.length) : undefined,
          summary: this.compactText(summaries.join("；") || terminal?.data.detail),
          startedAt: started.timestamp,
          completedAt: terminal?.timestamp,
        });
      });
    }

    const hasCaseReads = stageRuns.some((run) => run.toolActivities?.some((item) => item.tool === "cadir_case_read"));
    if (!hasCaseReads && !events.some((event) => event.type.startsWith("case.read."))) {
      events
        .filter((event) => event.type === "tool.updated"
          && event.data.tool === "cadir_case_read"
          && (event.data.status === "completed" || event.data.status === "error"))
        .forEach((event) => push(findRun(event.timestamp), {
          id: `legacy-case-read-${event.eventId}`,
          tool: "cadir_case_read",
          status: event.data.status === "error" ? "failed" : "completed",
          orderSeq: event.seq,
          summary: event.data.status === "error"
            ? this.compactText((event.data.error as Record<string, unknown> | undefined)?.message)
            : "已读取检索结果中的 CAD Case；旧任务未保存详细摘要。",
          startedAt: event.timestamp,
          completedAt: event.timestamp,
        }));
    }

    for (const run of stageRuns) {
      for (const activity of run.toolActivities ?? []) {
        const anchor = events.find((event) =>
          event.data.activity
          && typeof event.data.activity === "object"
          && (event.data.activity as Record<string, unknown>).id === activity.id
          && (event.type === "retrieval.started" || event.type === "case.read.started"),
        );
        if (activity.orderSeq === undefined && anchor) activity.orderSeq = anchor.seq;
        if (activity.outputOffset !== undefined) continue;
        const anchorSeq = activity.orderSeq ?? anchor?.seq;
        if (anchorSeq === undefined) {
          activity.outputOffset = run.output?.length ?? 0;
          continue;
        }
        const started = new Date(run.startedAt).getTime();
        const completed = run.completedAt ? new Date(run.completedAt).getTime() : Number.POSITIVE_INFINITY;
        activity.outputOffset = events
          .filter((event) => {
            if (event.type !== "message.delta" || event.seq >= anchorSeq) return false;
            const timestamp = new Date(event.timestamp).getTime();
            return started <= timestamp && timestamp <= completed + 1_000;
          })
          .reduce((length, event) => length + String(event.data.delta ?? "").length, 0);
      }
    }
  }

  private modificationPrompt(content: string, workspacePath: string, uploads: Array<{ localPath: string }>): string {
    const images = uploads.length
      ? `\n\nAdditional reference images (read these exact paths):\n${uploads.map((item) => `- ${item.localPath}`).join("\n")}`
      : "";
    return [
      "This is a modification request for the existing CAD model in the current CADIR session, not a new modeling task.",
      "Do not restart the requirements stage or create a new model from scratch.",
      `Read the existing requirements.md, model.py, model.json, and the current artifacts in ${workspacePath}.`,
      "Preserve the existing model and requirements unless the user's change requires a direct update.",
      "Apply the requested change directly to model.py and model.json, run cadir_run, then continue through visual feedback and the workflow policy specified above.",
      "Before publishing, update summary.md and experience.md so they include the original requirement and all completed modifications in this CAD session.",
      `User modification request:\n${content.trim()}`,
    ].join("\n\n") + images;
  }

  private workflowInstruction(selfEvolutionEnabled: boolean): string {
    if (selfEvolutionEnabled) {
      return [
        "Self-evolution is enabled for this revision.",
        "After all four visual views pass, call cadir_stage(visual, complete), then update summary.md and experience.md as cumulative documents, call cadir_publish exactly once, and call cadir_stage(evolution, complete).",
      ].join(" ");
    }
    return [
      "Self-evolution is disabled for this revision.",
      "Do not start or complete an evolution stage and do not call cadir_stage(evolution, ...).",
      "After all four visual views pass, update summary.md and experience.md as cumulative documents, call cadir_publish exactly once while visual is still the active stage, and then call cadir_stage(visual, complete).",
      "The backend will validate the final artifacts and complete the Job directly; this revision must not be archived or embedded into the dynamic Case library.",
    ].join(" ");
  }

  private normalizeSettings(value?: Partial<ModelSettings>): ModelSettings {
    const mode = value?.retrievalMode && retrievalModeIds.has(value.retrievalMode) ? value.retrievalMode : "full_and_subgraph";
    const pool = value?.retrievalPool && retrievalPoolIds.has(value.retrievalPool) ? value.retrievalPool : "both";
    const requestedNodes = Number(value?.subgraphMaxNodes ?? DEFAULT_SUBGRAPH_MAX_NODES);
    const subgraphMaxNodes = Number.isSafeInteger(requestedNodes)
      ? Math.min(MAX_SUBGRAPH_MAX_NODES, Math.max(MIN_SUBGRAPH_MAX_NODES, requestedNodes))
      : DEFAULT_SUBGRAPH_MAX_NODES;
    const normalizeTopK = (candidate: unknown, fallback: number): number => {
      const requested = Number(candidate ?? fallback);
      return Number.isSafeInteger(requested)
        ? Math.min(MAX_RETRIEVAL_TOP_K, Math.max(MIN_RETRIEVAL_TOP_K, requested))
        : fallback;
    };
    return {
      modelId: value?.modelId ?? this.config.modelId,
      effort: value?.effort && effortIds.includes(value.effort) ? value.effort : "medium",
      selfEvolutionEnabled: value?.selfEvolutionEnabled !== false,
      retrievalMode: mode,
      retrievalPool: pool,
      subgraphMaxNodes,
      retrievalTextTopK: normalizeTopK(value?.retrievalTextTopK, DEFAULT_RETRIEVAL_TEXT_TOP_K),
      retrievalSubgraphTopK: normalizeTopK(value?.retrievalSubgraphTopK, DEFAULT_RETRIEVAL_SUBGRAPH_TOP_K),
    };
  }

  private retrievalInstruction(settings: ModelSettings): string {
    if (settings.retrievalMode === "none") {
      return "CADIR retrieval is disabled for this revision. Do not call cadir_retrieve or cadir_case_read.";
    }
    const scope = settings.retrievalMode === "full"
      ? "complete CAD cases only"
      : settings.retrievalMode === "hybrid"
        ? `hybrid retrieval: ${settings.retrievalTextTopK} summary-text Cases plus ${settings.retrievalSubgraphTopK} 3D-subgraph Cases, with subgraphs limited to ${settings.subgraphMaxNodes} nodes`
        : `complete CAD cases plus 3D subgraphs with at most ${settings.subgraphMaxNodes} nodes`;
    const pool = settings.retrievalPool === "base" ? "the base Case library only" : settings.retrievalPool === "dynamic" ? "the dynamic Case library only" : "both the base and dynamic Case libraries";
    return `CADIR retrieval is enabled for ${scope}, using ${pool}. Before writing or repairing model.py, call cadir_retrieve with the current user request, inspect the unique Case summaries, and call cadir_case_read only for the most relevant one or two Cases.`;
  }

  async getModelSettings(): Promise<ModelSettingsResponse> {
    const settings = this.normalizeSettings(this.store.read((state) => state.modelSettings));
    const models = (await this.adapter.availableModels()).filter((item) => modelIds.has(item.id) && item.imageInput);
    return { settings, models, efforts: effortIds };
  }

  async updateModelSettings(input: Partial<ModelSettings>): Promise<ModelSettingsResponse> {
    const current = this.normalizeSettings(this.store.read((state) => state.modelSettings));
    const requested = { ...current, ...input };
    if (!modelIds.has(requested.modelId)) throw new AppError(400, "MODEL_NOT_ALLOWED", "model is not an allowed CADIR model");
    if (!effortIds.includes(requested.effort)) throw new AppError(400, "EFFORT_INVALID", "effort must be low, medium, or high");
    if (typeof requested.selfEvolutionEnabled !== "boolean") throw new AppError(400, "SELF_EVOLUTION_INVALID", "selfEvolutionEnabled must be a boolean");
    if (!retrievalModeIds.has(requested.retrievalMode)) throw new AppError(400, "RETRIEVAL_MODE_INVALID", "retrieval mode must be none, full, full_and_subgraph, or hybrid");
    if (!retrievalPoolIds.has(requested.retrievalPool)) throw new AppError(400, "RETRIEVAL_POOL_INVALID", "retrieval pool must be base, dynamic, or both");
    const nodeLimit = Number(requested.subgraphMaxNodes);
    if (!Number.isSafeInteger(nodeLimit) || nodeLimit < MIN_SUBGRAPH_MAX_NODES || nodeLimit > MAX_SUBGRAPH_MAX_NODES) {
      throw new AppError(400, "SUBGRAPH_NODE_LIMIT_INVALID", `subgraphMaxNodes must be an integer from ${MIN_SUBGRAPH_MAX_NODES} to ${MAX_SUBGRAPH_MAX_NODES}`);
    }
    const textTopK = Number(requested.retrievalTextTopK);
    if (!Number.isSafeInteger(textTopK) || textTopK < MIN_RETRIEVAL_TOP_K || textTopK > MAX_RETRIEVAL_TOP_K) {
      throw new AppError(400, "RETRIEVAL_TEXT_TOP_K_INVALID", `retrievalTextTopK must be an integer from ${MIN_RETRIEVAL_TOP_K} to ${MAX_RETRIEVAL_TOP_K}`);
    }
    const subgraphTopK = Number(requested.retrievalSubgraphTopK);
    if (!Number.isSafeInteger(subgraphTopK) || subgraphTopK < MIN_RETRIEVAL_TOP_K || subgraphTopK > MAX_RETRIEVAL_TOP_K) {
      throw new AppError(400, "RETRIEVAL_SUBGRAPH_TOP_K_INVALID", `retrievalSubgraphTopK must be an integer from ${MIN_RETRIEVAL_TOP_K} to ${MAX_RETRIEVAL_TOP_K}`);
    }
    const models = (await this.adapter.availableModels()).filter((item) => modelIds.has(item.id) && item.imageInput);
    const selected = models.find((item) => item.id === requested.modelId);
    const modelChanged = requested.modelId !== current.modelId || requested.effort !== current.effort;
    if (!selected && modelChanged) throw new AppError(409, "MODEL_UNAVAILABLE", "selected model is not currently available for image-enabled CAD tasks");
    if (selected && !selected.efforts.includes(requested.effort)) throw new AppError(409, "EFFORT_UNAVAILABLE", "selected effort is not supported by this model");
    await this.store.transaction((state) => {
      state.modelSettings = {
        modelId: requested.modelId, effort: requested.effort, selfEvolutionEnabled: requested.selfEvolutionEnabled, retrievalMode: requested.retrievalMode, retrievalPool: requested.retrievalPool,
        subgraphMaxNodes: nodeLimit, retrievalTextTopK: textTopK, retrievalSubgraphTopK: subgraphTopK,
      };
    });
    return await this.getModelSettings();
  }

  async retrievalHealthy(): Promise<boolean> {
    return await this.retrieval.health();
  }

  resumePendingIndexing(): void {
    if (!this.config.retrievalUrl) return;
    const jobIds = this.store.read((state) => state.ragEntries
      .filter((entry) => entry.indexStatus !== "ready" || entry.indexedRevision !== entry.revision)
      .map((entry) => entry.sourceJobId));
    for (const jobId of jobIds) this.queueCaseIndex(jobId);
  }

  async retrieveCases(input: {
    sessionID: string;
    query: string;
    topK?: number;
    includeImages?: boolean;
  }): Promise<Record<string, unknown>> {
    const query = input.query?.trim();
    if (!query) throw new AppError(400, "RETRIEVAL_QUERY_EMPTY", "retrieval query is required");
    const job = this.store.read((state) => [...state.jobs].reverse().find((item) => item.openCodeSessionId === input.sessionID && !isTerminalJob(item.status)));
    if (!job) throw new AppError(404, "ACTIVE_JOB_NOT_FOUND", "active job not found");
    if (job.currentStage !== "requirements" && job.currentStage !== "codegen") {
      throw new AppError(409, "RETRIEVAL_STAGE_INVALID", "retrieval is only available during requirements analysis or code generation");
    }
    const retrievalMode = job.retrievalMode ?? "full_and_subgraph";
    if (retrievalMode === "none") return { ok: true, enabled: false, mode: "none", results: [] };
    const requestedTopK = Number(input.topK ?? this.config.retrievalTopK ?? 5);
    const topK = Number.isFinite(requestedTopK) ? Math.min(10, Math.max(1, Math.trunc(requestedTopK))) : 5;
    const textTopK = job.retrievalTextTopK ?? DEFAULT_RETRIEVAL_TEXT_TOP_K;
    const subgraphTopK = job.retrievalSubgraphTopK ?? DEFAULT_RETRIEVAL_SUBGRAPH_TOP_K;
    const targetCount = retrievalMode === "hybrid" ? textTopK + subgraphTopK : topK;
    const requestId = randomUUID();
    const options: RetrievalQueryOptions = {
      scope: retrievalMode === "hybrid" ? "full_and_subgraph" : retrievalMode,
      sources: retrievalSources(job.retrievalPool ?? "both"),
      topK,
      subgraphMaxNodes: job.subgraphMaxNodes ?? DEFAULT_SUBGRAPH_MAX_NODES,
      excludeCaseIds: [job.id],
      requestId,
      jobId: job.id,
      revision: this.jobRevision(job),
    };
    const hybridOptions: HybridRetrievalQueryOptions = {
      sources: options.sources, textTopK, subgraphTopK, subgraphMaxNodes: options.subgraphMaxNodes,
      excludeCaseIds: options.excludeCaseIds, requestId, jobId: options.jobId, revision: options.revision,
    };
    const activity: ToolActivity = {
      id: requestId, tool: "cadir_retrieve", status: "running",
      query: this.compactText(query, 240), startedAt: now(),
    };
    const started = await this.store.transaction((state) => {
      const current = state.jobs.find((item) => item.id === job.id);
      if (!current || isTerminalJob(current.status)) return [];
      const run = this.upsertToolActivity(state, current, activity);
      const event = this.appendEvent(state, current, "retrieval.started", {
        query, scope: retrievalMode, sources: options.sources, topK: targetCount, textTopK, subgraphTopK,
        subgraphMaxNodes: options.subgraphMaxNodes,
        ...this.toolEventData(run, activity),
      });
      activity.orderSeq = event.seq;
      this.upsertToolActivity(state, current, activity);
      return [event];
    });
    this.store.publish(started);

    const imageArtifacts = input.includeImages === false || retrievalMode === "hybrid" ? [] : this.store.read((state) => state.artifacts.filter((artifact) =>
      artifact.jobId === job.id
      && this.isCurrentRevision(job, artifact.revision)
      && artifact.kind === "image"
      && artifact.validated
      && artifact.downloadUrl.startsWith("/api/uploads/"),
    ));
    const calls: Array<Promise<RetrievalResponse>> = [retrievalMode === "hybrid"
      ? this.retrieval.retrieveHybrid(query, hybridOptions)
      : this.retrieval.retrieveText(query, options)];
    for (const artifact of imageArtifacts) {
      calls.push(readFile(artifact.path).then((bytes) => this.retrieval.retrieveImage({
        bytes, filename: artifact.name, mimeType: artifact.mimeType,
      }, options)));
    }
    const settled = await Promise.allSettled(calls);
    const responses = settled.filter((item): item is PromiseFulfilledResult<RetrievalResponse> => item.status === "fulfilled").map((item) => item.value);
    if (!responses.length) {
      const detail = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected").map((item) => this.safeError(item.reason)).join("; ");
      const failed = await this.store.transaction((state) => {
        const current = state.jobs.find((item) => item.id === job.id);
        if (!current) return [];
        const failedActivity: ToolActivity = {
          ...activity, status: "failed", summary: this.compactText(detail), completedAt: now(),
        };
        const run = this.upsertToolActivity(state, current, failedActivity);
        return [this.appendEvent(state, current, "retrieval.failed", {
          code: "RETRIEVAL_UNAVAILABLE", message: "Case retrieval is unavailable; continue without retrieved Cases", detail,
          ...this.toolEventData(run, failedActivity),
        })];
      });
      this.store.publish(failed);
      return { ok: false, enabled: true, mode: retrievalMode, error: { code: "RETRIEVAL_UNAVAILABLE", message: "Case retrieval is unavailable; continue without retrieved Cases", detail }, results: [] };
    }

    const results = retrievalMode === "hybrid"
      ? responses[0].results.slice(0, targetCount).map((item, index) => ({ ...item, rank: index + 1 }))
      : this.mergeRetrievalResults(responses, topK);
    const grantId = randomUUID();
    const completed = await this.store.transaction((state) => {
      const current = state.jobs.find((item) => item.id === job.id);
      if (!current) return [];
      state.retrievalGrants.push({
        id: grantId, jobId: job.id, revision: this.jobRevision(job), query,
        caseIds: results.map((item) => item.caseId), results: results.map((item) => ({ ...item })), createdAt: now(),
      });
      const summaries = results.map((item) => {
        const source = item.provenance?.join("+") ?? item.matchKind ?? "case";
        const summary = this.compactText(item.summary, 100) ?? "No summary";
        return `[${source}] ${item.caseId}: ${summary}`;
      });
      const completedActivity: ToolActivity = {
        ...activity, status: "completed", resultCount: results.length,
        summary: this.compactText(summaries.slice(0, 3).join("；")), completedAt: now(),
      };
      const run = this.upsertToolActivity(state, current, completedActivity);
      return [this.appendEvent(state, current, "retrieval.completed", {
        grantId, scope: retrievalMode, sources: options.sources, textTopK, subgraphTopK, subgraphMaxNodes: options.subgraphMaxNodes,
        returnedCount: results.length,
        cases: results.map((item) => ({
          caseId: item.caseId, rank: item.rank, matchKind: item.matchKind, provenance: item.provenance,
          textScore: item.textScore, subgraphScore: item.subgraphScore, summary: item.summary,
        })),
        partialFailures: settled.length - responses.length,
        ...this.toolEventData(run, completedActivity),
      })];
    });
    this.store.publish(completed);
    return {
      ok: true, enabled: true, mode: retrievalMode, pool: job.retrievalPool ?? "both", grantId,
      requestedTopK: targetCount, requestedTextTopK: retrievalMode === "hybrid" ? textTopK : undefined,
      requestedSubgraphTopK: retrievalMode === "hybrid" ? subgraphTopK : undefined,
      returnedCount: results.length, partial: results.length < targetCount, results,
    };
  }

  async readRetrievedCase(input: {
    sessionID: string;
    caseId: string;
    subgraphId?: string;
    include?: string[];
  }): Promise<Record<string, unknown>> {
    const job = this.store.read((state) => [...state.jobs].reverse().find((item) => item.openCodeSessionId === input.sessionID && !isTerminalJob(item.status)));
    if (!job) throw new AppError(404, "ACTIVE_JOB_NOT_FOUND", "active job not found");
    if ((job.retrievalMode ?? "full_and_subgraph") === "none") {
      throw new AppError(409, "RETRIEVAL_DISABLED", "retrieval is disabled for this revision");
    }
    const grant = this.store.read((state) => [...state.retrievalGrants].reverse().find((item) =>
      item.jobId === job.id && item.revision === this.jobRevision(job) && item.caseIds.includes(input.caseId),
    ));
    if (!grant) throw new AppError(403, "CASE_NOT_RETRIEVED", "the Case was not returned by retrieval for this revision");
    if (input.subgraphId) {
      const result = grant.results.find((item) => item.caseId === input.caseId);
      const matches = Array.isArray(result?.subgraphMatches) ? result.subgraphMatches as Array<Record<string, unknown>> : [];
      if (!matches.some((item) => item.subgraphId === input.subgraphId)) {
        throw new AppError(403, "SUBGRAPH_NOT_RETRIEVED", "the subgraph was not returned by retrieval for this revision");
      }
    }
    const allowed = new Set(["summary", "experience", "model.py", "model.json", "subgraph", "renders", "artifacts"]);
    const include = (input.include?.length ? input.include : ["summary", "experience", "model.py", "model.json", "subgraph"])
      .filter((item) => allowed.has(item));
    const activity: ToolActivity = {
      id: randomUUID(), tool: "cadir_case_read", status: "running", caseId: input.caseId,
      startedAt: now(),
    };
    const started = await this.store.transaction((state) => {
      const current = state.jobs.find((item) => item.id === job.id);
      if (!current || isTerminalJob(current.status)) return [];
      const run = this.upsertToolActivity(state, current, activity);
      const event = this.appendEvent(state, current, "case.read.started", {
        caseId: input.caseId, subgraphId: input.subgraphId, include,
        ...this.toolEventData(run, activity),
      });
      activity.orderSeq = event.seq;
      this.upsertToolActivity(state, current, activity);
      return [event];
    });
    this.store.publish(started);
    try {
      const detail = await this.retrieval.readCase(input.caseId, { subgraphId: input.subgraphId, include });
      const completed = await this.store.transaction((state) => {
        const current = state.jobs.find((item) => item.id === job.id);
        if (!current) return [];
        const completedActivity: ToolActivity = {
          ...activity, status: "completed", summary: this.retrievedCaseSummary(detail), completedAt: now(),
        };
        const run = this.upsertToolActivity(state, current, completedActivity);
        return [this.appendEvent(state, current, "case.read.completed", {
          caseId: input.caseId, subgraphId: input.subgraphId,
          ...this.toolEventData(run, completedActivity),
        })];
      });
      this.store.publish(completed);
      return { ok: true, case: detail };
    } catch (error) {
      const message = this.safeError(error);
      const failed = await this.store.transaction((state) => {
        const current = state.jobs.find((item) => item.id === job.id);
        if (!current) return [];
        const failedActivity: ToolActivity = {
          ...activity, status: "failed", summary: this.compactText(message), completedAt: now(),
        };
        const run = this.upsertToolActivity(state, current, failedActivity);
        return [this.appendEvent(state, current, "case.read.failed", {
          caseId: input.caseId, subgraphId: input.subgraphId,
          error: { code: "CASE_READ_FAILED", message },
          ...this.toolEventData(run, failedActivity),
        })];
      });
      this.store.publish(failed);
      return { ok: false, error: { code: "CASE_READ_FAILED", message } };
    }
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

    const existingJob = this.findConversationJob(conversationId);
    if (existingJob && !isTerminalJob(existingJob.status)) throw new AppError(409, "JOB_ALREADY_ACTIVE", "conversation already has an active job");
    if (existingJob) return await this.startModification(conversation, existingJob, request);
    return await this.startInitialJob(conversation, request);
  }

  private async startInitialJob(conversation: Conversation, request: CreateMessageRequest): Promise<JobSnapshot> {
    const conversationId = conversation.id;

    const jobId = randomUUID();
    const selectedSettings = this.normalizeSettings(this.store.read((state) => state.modelSettings));
    const workspacePath = resolve(this.config.jobsRoot, jobId);
    await mkdir(workspacePath, { recursive: true });
    const uploads = await this.localizeUploads(workspacePath, this.resolveUploads(conversationId, request.imageArtifactIds ?? []));
    const userPrompt = uploads.length
      ? `${request.content.trim()}\n\nInput reference images (read these exact paths before modeling):\n${uploads.map((item) => `- ${item.localPath}`).join("\n")}`
      : request.content.trim();
    const prompt = `${this.retrievalInstruction(selectedSettings)}\n${this.workflowInstruction(selectedSettings.selfEvolutionEnabled)}\n\n${userPrompt}`;
    const timestamp = now();
    const initialEvents = await this.store.transaction((state) => {
      const liveConversation = state.conversations.find((item) => item.id === conversationId)!;
      const job: Job = {
        id: jobId, conversationId, status: "running", currentStage: "requirements", workspacePath,
        createdAt: timestamp, startedAt: timestamp, updatedAt: timestamp, backendHeartbeatAt: timestamp,
         modelId: selectedSettings.modelId, modelProvider: this.config.modelProvider, effort: selectedSettings.effort,
         selfEvolutionEnabled: selectedSettings.selfEvolutionEnabled,
        retrievalMode: selectedSettings.retrievalMode, retrievalPool: selectedSettings.retrievalPool, subgraphMaxNodes: selectedSettings.subgraphMaxNodes, revision: 1,
        retrievalTextTopK: selectedSettings.retrievalTextTopK, retrievalSubgraphTopK: selectedSettings.retrievalSubgraphTopK,
      };
      state.jobs.push(job);
      const stageRunId = randomUUID();
      state.stageRuns.push({ id: stageRunId, jobId, stage: "requirements", revision: 1, attempt: 1, status: "running", usage: emptyUsage(), usageBaseline: emptyUsage(), startedAt: timestamp });
      const inputArtifacts = uploads.map(({ upload, localPath }): Artifact => {
        const id = randomUUID();
        return { id, jobId, revision: 1, name: upload.name, kind: "image", path: localPath, mimeType: upload.mimeType, size: upload.size, validated: true, partial: false, createdAt: timestamp, downloadUrl: upload.downloadUrl };
      });
      state.artifacts.push(...inputArtifacts);
      state.messages.push({
        id: randomUUID(), conversationId, jobId, role: "user", content: request.content.trim(),
        imageArtifactIds: inputArtifacts.map((item) => item.id), createdAt: timestamp, completedAt: timestamp,
      });
      liveConversation.jobId = jobId;
      liveConversation.latestJobId = jobId;
      liveConversation.latestJobStatus = "running";
      liveConversation.title = liveConversation.revision === 1 && liveConversation.title === "New CAD session" ? request.content.trim().slice(0, 40) : liveConversation.title;
      liveConversation.revision += 1;
      liveConversation.updatedAt = timestamp;
      return [
        this.appendEvent(state, job, "job.started", { status: "running", revision: 1 }),
        this.appendEvent(state, job, "stage.updated", { stage: "requirements", status: "running", attempt: 1, stageRunId, revision: 1, label: eventName("requirements") }),
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

  private async startModification(conversation: Conversation, existingJob: Job, request: CreateMessageRequest): Promise<JobSnapshot> {
    const jobId = existingJob.id;
    const revision = this.jobRevision(existingJob) + 1;
    const selectedSettings = this.normalizeSettings(this.store.read((state) => state.modelSettings));
    const usageBaseline = await this.readUsageBaseline(existingJob);
    const uploads = await this.localizeUploads(existingJob.workspacePath, this.resolveUploads(conversation.id, request.imageArtifactIds ?? []));
    const prompt = `${this.retrievalInstruction(selectedSettings)}\n${this.workflowInstruction(selectedSettings.selfEvolutionEnabled)}\n\n${this.modificationPrompt(request.content, existingJob.workspacePath, uploads)}`;
    const timestamp = now();
    const events = await this.store.transaction((state) => {
      const job = state.jobs.find((item) => item.id === jobId && item.conversationId === conversation.id);
      if (!job) throw notFound("job");
      if (!isTerminalJob(job.status)) throw new AppError(409, "JOB_ALREADY_ACTIVE", "conversation already has an active job");
      const liveRevision = this.jobRevision(job);
      const nextRevision = liveRevision + 1;
      const stageRunId = randomUUID();
      job.revision = nextRevision;
      job.status = "running";
      job.currentStage = "codegen";
      job.error = undefined;
      job.summary = undefined;
      job.completedAt = undefined;
      job.updatedAt = timestamp;
      job.backendHeartbeatAt = timestamp;
      job.modelId = selectedSettings.modelId;
      job.modelProvider = this.config.modelProvider;
      job.effort = selectedSettings.effort;
      job.selfEvolutionEnabled = selectedSettings.selfEvolutionEnabled;
      job.retrievalMode = selectedSettings.retrievalMode;
      job.retrievalPool = selectedSettings.retrievalPool;
      job.subgraphMaxNodes = selectedSettings.subgraphMaxNodes;
      job.retrievalTextTopK = selectedSettings.retrievalTextTopK;
      job.retrievalSubgraphTopK = selectedSettings.retrievalSubgraphTopK;
      state.stageRuns.push({ id: stageRunId, jobId, stage: "codegen", revision: nextRevision, attempt: 1, status: "running", usage: emptyUsage(), usageBaseline, startedAt: timestamp });
      const previousRequirements = [...state.artifacts].reverse().find((item) =>
        item.jobId === job.id && item.name.toLowerCase() === "requirements.md" && item.validated && !item.partial);
      if (previousRequirements) {
        const requirementId = randomUUID();
        state.artifacts.push({
          ...previousRequirements,
          id: requirementId,
          revision: nextRevision,
          stageRunId: undefined,
          createdAt: timestamp,
          downloadUrl: `/api/jobs/${job.id}/artifacts/${requirementId}/download`,
        });
      }
      const inputArtifacts = uploads.map(({ upload, localPath }): Artifact => {
        const id = randomUUID();
        return { id, jobId, revision: nextRevision, name: upload.name, kind: "image", path: localPath, mimeType: upload.mimeType, size: upload.size, validated: true, partial: false, createdAt: timestamp, downloadUrl: upload.downloadUrl };
      });
      state.artifacts.push(...inputArtifacts);
      state.messages.push({ id: randomUUID(), conversationId: conversation.id, jobId, role: "user", content: request.content.trim(), imageArtifactIds: inputArtifacts.map((item) => item.id), createdAt: timestamp, completedAt: timestamp });
      this.touchConversation(state, job);
      return [
        this.appendEvent(state, job, "job.started", { status: "running", revision: nextRevision, modification: true }),
        this.appendEvent(state, job, "stage.updated", { stage: "codegen", status: "running", attempt: 1, stageRunId, revision: nextRevision, modification: true, label: eventName("codegen") }),
      ];
    });
    this.store.publish(events);
    try {
      let sessionId = this.getSnapshot(jobId).job.openCodeSessionId;
      if (!sessionId) {
        const session = await this.adapter.createSession(conversation.title, existingJob.workspacePath);
        sessionId = session.id;
        await this.bindSession(jobId, sessionId);
      }
      const job = this.getSnapshot(jobId).job;
      await this.adapter.prompt(sessionId, prompt, job.workspacePath, this.promptModel(job));
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
      const revision = this.jobRevision(job);
      const old = state.stageRuns.find((run) => run.jobId === job.id && this.isCurrentRevision(job, run.revision) && run.status === "waiting_input");
      const attempt = old ? old.attempt + 1 : 1;
      const inputArtifacts = uploads.map(({ upload, localPath }): Artifact => {
        const id = randomUUID();
        return { id, jobId, revision, name: upload.name, kind: "image", path: localPath, mimeType: upload.mimeType, size: upload.size, validated: true, partial: false, createdAt: timestamp, downloadUrl: upload.downloadUrl };
      });
      state.artifacts.push(...inputArtifacts);
      state.messages.push({ id: randomUUID(), conversationId: conversation.id, jobId, role: "user", content: request.content.trim(), imageArtifactIds: inputArtifacts.map((item) => item.id), createdAt: timestamp, completedAt: timestamp });
      const stageRunId = randomUUID();
      state.stageRuns.push({ id: stageRunId, jobId, stage: job.currentStage ?? "requirements", revision, attempt, status: "running", usage: emptyUsage(), usageBaseline, startedAt: timestamp });
      job.status = "running"; job.updatedAt = timestamp; job.error = undefined;
      this.touchConversation(state, job);
      return [this.appendEvent(state, job, "stage.updated", { stage: job.currentStage, status: "running", attempt, stageRunId, revision })];
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
      const events = state.events.filter((event) => event.jobId === jobId);
      const stageRuns = state.stageRuns.filter((run) => run.jobId === jobId).map((run) => ({
        ...run,
        toolActivities: run.toolActivities ? run.toolActivities.map((item) => ({ ...item })) : undefined,
        usage: withoutCacheTotal(run.usage),
        usageBaseline: run.usageBaseline ? withoutCacheTotal(run.usageBaseline) : undefined,
      }));
      this.appendLegacyToolActivities(stageRuns, events);
      const messages = state.messages.filter((message) => message.jobId === jobId);
      const artifacts = state.artifacts.filter((artifact) => artifact.jobId === jobId);
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
      if (request.stage === "evolution" && job.selfEvolutionEnabled === false) {
        throw new AppError(409, "SELF_EVOLUTION_DISABLED", "self-evolution is disabled for this revision");
      }
      if (request.action === "running") {
        const existing = [...this.currentStageRuns(state, job)].reverse().find((item) => item.stage === request.stage && item.status === "running");
        if (existing) return [];
        if (request.stage !== "evolution" && job.currentStage !== request.stage) throw new AppError(409, "INVALID_STAGE", `expected ${job.currentStage}, received ${request.stage}`);
        const attempt = Math.max(0, ...this.currentStageRuns(state, job).filter((item) => item.stage === request.stage).map((item) => item.attempt)) + 1;
        job.currentStage = request.stage;
        const stageRun: StageRun = { id: randomUUID(), jobId: job.id, stage: request.stage, revision: this.jobRevision(job), attempt, status: "running", usage: emptyUsage(), usageBaseline, startedAt: now() };
        state.stageRuns.push(stageRun);
        job.updatedAt = now(); this.touchConversation(state, job);
        return [this.appendEvent(state, job, "stage.updated", this.stageEventData(stageRun))];
      }
      if (request.action === "skipped") {
        if (request.stage !== "evolution") throw new AppError(409, "INVALID_SKIP", "only evolution may be skipped");
        let existing = [...this.currentStageRuns(state, job)].reverse().find((item) => item.stage === "evolution");
        const timestamp = now();
        if (existing?.status === "skipped") return [];
        if (existing?.status === "running") { existing.status = "skipped"; existing.completedAt = timestamp; existing.summary = request.summary; }
        else {
          const stageRun: StageRun = { id: randomUUID(), jobId: job.id, stage: "evolution", revision: this.jobRevision(job), attempt: 1, status: "skipped", usage: emptyUsage(), usageBaseline, startedAt: timestamp, completedAt: timestamp, summary: request.summary };
          state.stageRuns.push(stageRun);
          existing = stageRun;
        }
        const emitted = [this.appendEvent(state, job, "stage.updated", this.stageEventData(existing!, { summary: request.summary }))];
        const latestVisual = [...this.currentStageRuns(state, job)].reverse().find((item) => item.stage === "visual");
        if (latestVisual?.status === "completed") {
          this.assertPublishArtifacts(state, job.id);
          await this.archiveEvolution(state, job, request.summary);
          job.status = "completed"; job.summary = request.summary ?? job.summary; job.completedAt = timestamp;
          emitted.push(this.appendEvent(state, job, "job.completed", { summary: job.summary, revision: this.jobRevision(job), artifacts: state.artifacts.filter((item) => item.jobId === job.id && this.isCurrentRevision(job, item.revision) && item.validated).map((item) => ({ name: item.name, path: item.path, downloadUrl: item.downloadUrl })) }));
        } else if (latestVisual?.status === "failed") throw new AppError(409, "EVOLUTION_SKIP_INVALID", "evolution cannot be skipped after failed visual feedback");
        else job.currentStage = "visual";
        job.updatedAt = timestamp; this.touchConversation(state, job);
        return emitted;
      }
      if (job.currentStage !== request.stage) throw new AppError(409, "INVALID_STAGE", `expected ${job.currentStage}, received ${request.stage}`);
      const run = [...this.currentStageRuns(state, job)].reverse().find((item) => item.stage === request.stage && item.status === "running");
      if (!run) {
        const completed = [...this.currentStageRuns(state, job)].reverse().find((item) => item.stage === request.stage && item.status === "completed");
        if (request.action === "complete" && completed) return [];
        throw new AppError(409, "STAGE_NOT_RUNNING", "stage is not running");
      }
      const timestamp = now();
      const emitted: JobEvent[] = [];

      if (request.action === "complete") {
        await this.assertStageArtifacts(state, job.id, request.stage, run.id);
        run.status = "completed"; run.completedAt = timestamp; run.summary = request.summary; run.toolError = undefined;
        emitted.push(this.appendEvent(state, job, "stage.updated", this.stageEventData(run, { summary: request.summary })));
        const next = request.stage === "requirements" ? "codegen" : request.stage === "codegen" ? "visual" : request.stage === "visual" && job.selfEvolutionEnabled !== false ? "evolution" : undefined;
        if (next) {
          job.currentStage = next;
          const attempt = Math.max(0, ...this.currentStageRuns(state, job).filter((item) => item.stage === next).map((item) => item.attempt)) + 1;
          const nextRun: StageRun = { id: randomUUID(), jobId: job.id, stage: next, revision: this.jobRevision(job), attempt, status: "running", usage: emptyUsage(), usageBaseline, startedAt: timestamp };
          state.stageRuns.push(nextRun);
          emitted.push(this.appendEvent(state, job, "stage.updated", this.stageEventData(nextRun, { label: eventName(next) })));
        } else if (request.stage === "visual" && job.selfEvolutionEnabled === false) {
          this.assertPublishArtifacts(state, job.id);
          job.status = "completed"; job.summary = request.summary ?? job.summary; job.completedAt = timestamp; job.currentStage = undefined;
          emitted.push(this.appendEvent(state, job, "job.completed", {
            summary: job.summary,
            revision: this.jobRevision(job),
            artifacts: state.artifacts.filter((item) => item.jobId === job.id && this.isCurrentRevision(job, item.revision) && item.validated).map((item) => ({ name: item.name, path: item.path, downloadUrl: item.downloadUrl })),
          }));
        } else if (request.stage === "evolution") {
          const latestVisual = [...this.currentStageRuns(state, job)].reverse().find((item) => item.stage === "visual");
          if (latestVisual?.status !== "completed") throw new AppError(409, "EVOLUTION_REQUIRES_VISUAL_PASS", "evolution starts only after visual feedback passes");
          this.assertPublishArtifacts(state, job.id);
          await this.archiveEvolution(state, job, request.summary);
          job.status = "completed"; job.summary = request.summary ?? job.summary; job.completedAt = timestamp;
          emitted.push(this.appendEvent(state, job, "job.completed", {
            summary: job.summary,
            revision: this.jobRevision(job),
            artifacts: state.artifacts.filter((item) => item.jobId === job.id && this.isCurrentRevision(job, item.revision) && item.validated).map((item) => ({ name: item.name, path: item.path, downloadUrl: item.downloadUrl })),
          }));
        }
      } else if (request.action === "retry") {
        run.status = "failed"; run.completedAt = timestamp; run.error = request.error ?? run.toolError ?? { code: "STAGE_RETRY", message: request.summary ?? "stage retry requested" };
        emitted.push(this.appendEvent(state, job, "stage.updated", this.stageEventData(run, { retry: true })));
        const retryStage: Stage = request.stage === "visual" ? "codegen" : request.stage;
        const attempt = Math.max(0, ...this.currentStageRuns(state, job).filter((item) => item.stage === retryStage).map((item) => item.attempt)) + 1;
        job.currentStage = retryStage;
        const retryRun: StageRun = { id: randomUUID(), jobId: job.id, stage: retryStage, revision: this.jobRevision(job), attempt, status: "running", usage: emptyUsage(), usageBaseline, startedAt: timestamp };
        state.stageRuns.push(retryRun);
        emitted.push(this.appendEvent(state, job, "stage.updated", this.stageEventData(retryRun, { retry: true })));
      } else if (request.action === "needs_input") {
        run.status = "waiting_input"; run.completedAt = timestamp; run.summary = request.summary;
        job.status = "waiting_input";
        emitted.push(this.appendEvent(state, job, "job.needs_input", { stage: request.stage, revision: this.jobRevision(job), stageRunId: run.id, summary: request.summary }));
      } else {
        run.status = "failed"; run.completedAt = timestamp; run.error = request.error ?? run.toolError ?? { code: "STAGE_FAILED", message: request.summary ?? "stage failed" };
        job.status = "failed"; job.error = run.error; job.completedAt = timestamp;
        emitted.push(this.appendEvent(state, job, "stage.updated", this.stageEventData(run, { error: run.error })));
        emitted.push(this.appendEvent(state, job, "job.failed", { error: job.error, revision: this.jobRevision(job) }));
      }
      job.updatedAt = timestamp; job.backendHeartbeatAt = timestamp;
      this.touchConversation(state, job);
      return emitted;
    });
    this.store.publish(events);
    const jobId = events[0]?.jobId ?? this.store.read((state) => [...state.jobs].reverse().find((item) => item.openCodeSessionId === request.sessionID)?.id);
    if (!jobId) throw new AppError(404, "ACTIVE_JOB_NOT_FOUND", "job not found");
    if (events.some((event) => event.type === "job.completed") && this.store.read((state) => state.jobs.find((item) => item.id === jobId)?.selfEvolutionEnabled !== false)) {
      this.queueCaseIndex(jobId);
    }
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
      for (const run of state.stageRuns.filter((item) => item.jobId === jobId && this.isCurrentRevision(job, item.revision) && item.status === "running")) { run.status = "cancelled"; run.completedAt = timestamp; }
      for (const artifact of state.artifacts.filter((item) => item.jobId === jobId && this.isCurrentRevision(job, item.revision))) artifact.partial = true;
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
      if (job.status !== "failed" && job.status !== "cancelled") {
        throw new AppError(409, "JOB_NOT_RETRYABLE", "only a failed or cancelled job can be retried");
      }
      sessionId = job.openCodeSessionId;
      if (!sessionId) throw new AppError(409, "OPENCODE_SESSION_MISSING", "job has no OpenCode session");
      const stage = job.currentStage ?? "requirements";
      const attempt = Math.max(0, ...state.stageRuns.filter((item) => item.jobId === jobId && this.isCurrentRevision(job, item.revision) && item.stage === stage).map((item) => item.attempt)) + 1;
      const timestamp = now();
      job.status = "running"; job.error = undefined; job.completedAt = undefined; job.updatedAt = timestamp;
      const stageRun: StageRun = { id: randomUUID(), jobId, stage, revision: this.jobRevision(job), attempt, status: "running", usage: emptyUsage(), usageBaseline, startedAt: timestamp };
      state.stageRuns.push(stageRun);
      this.touchConversation(state, job);
      return [this.appendEvent(state, job, "stage.updated", this.stageEventData(stageRun, { retry: true }))];
    });
    this.store.publish(events);
    try {
      const job = this.getSnapshot(jobId).job;
      await this.adapter.prompt(sessionId!, `${this.workflowInstruction(job.selfEvolutionEnabled !== false)}\nContinue the current CAD task from the failed stage. Inspect the previous error, repair it, and proceed.`, job.workspacePath, this.promptModel(job));
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
      const run = [...this.currentStageRuns(state, job)].reverse().find((item) => item.status === "running");
      const id = randomUUID();
      const item: Artifact = {
        id, jobId: job.id, revision: this.jobRevision(job), stageRunId: run?.id, name: basename(absolute), kind: input.kind, path: absolute,
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
      const run = [...this.currentStageRuns(state, job)].reverse().find((item) => item.status === "running");
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
      const usage = sumUsage(state.stageRuns.filter((run) => run.jobId === job.id && this.isCurrentRevision(job, run.revision)).map((run) => run.usage));
      return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite === 0;
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
      const currentRuns = this.currentStageRuns(state, job);
      const run = [...currentRuns].reverse().find((item) => item.status === "running") ?? currentRuns.at(-1);
      if (!run) return [];
      const runIndex = runs.findIndex((item) => item.id === run.id);
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
        total: run.usage.input + delta.input + run.usage.output + delta.output + run.usage.reasoning + delta.reasoning,
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
      const run = [...state.stageRuns].reverse().find((item) => item.jobId === jobId && this.isCurrentRevision(job, item.revision) && item.status === "running");
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
    await this.failOrDefer(jobId, error, false);
  }

  async failJobFromMessages(jobId: string, messages: unknown[]): Promise<boolean> {
    const includeToolErrors = this.store.read((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      return Boolean(job && isTerminalJob(job.status));
    });
    const raw = this.findMessageError(messages, includeToolErrors);
    if (!raw) return false;
    const error = this.classifyOpenCodeError(raw.detail, raw.source);
    if (includeToolErrors) await this.persistJobFailure(jobId, error, true);
    else await this.failOrDefer(jobId, error, false);
    return true;
  }

  private async failOrDefer(jobId: string, error: JobError, refineTerminal: boolean): Promise<void> {
    const terminal = this.store.read((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      return !job || isTerminalJob(job.status);
    });
    if (terminal || !this.shouldDrainToolCallbacks(error)) {
      await this.persistJobFailure(jobId, error, refineTerminal);
      return;
    }

    const graceMs = Math.max(0, Math.trunc(this.config.failureGraceMs ?? 15_000));
    if (graceMs === 0) {
      await this.persistJobFailure(jobId, error, refineTerminal);
      return;
    }
    // The event stream and watchdog can report the same provider failure more
    // than once. Keep the first root cause and let its full drain window elapse.
    if (this.pendingFailures.has(jobId)) return;

    const timer = setTimeout(() => {
      void this.flushPendingFailure(jobId);
    }, graceMs);
    timer.unref();
    this.pendingFailures.set(jobId, { error, timer });
  }

  private shouldDrainToolCallbacks(error: JobError): boolean {
    if (error.source === "tool") return false;
    return error.code === "OPENCODE_ERROR"
      || error.code === "OPENCODE_SESSION_LOST"
      || error.source === "model_provider"
      || error.source === "opencode";
  }

  private async flushPendingFailure(jobId: string): Promise<void> {
    const pending = this.pendingFailures.get(jobId);
    if (!pending) return;
    this.pendingFailures.delete(jobId);
    await this.persistJobFailure(jobId, pending.error, false);
  }

  private async persistJobFailure(jobId: string, error: JobError, refineTerminal: boolean): Promise<void> {
    const events = await this.store.transaction((state) => {
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job) return [];
      if (isTerminalJob(job.status)) {
        if (!refineTerminal || job.status !== "failed" || job.error?.detail === error.detail) return [];
        // A late tool callback must never replace the provider/session error that
        // caused the Job to terminate. It is only a secondary symptom.
        if (job.error?.source && job.error.source !== "tool" && error.source === "tool") return [];
        if (error.detail?.includes("ACTIVE_JOB_NOT_FOUND")) return [];
        job.error = error;
        const failedRun = [...state.stageRuns].reverse().find((item) => item.jobId === job.id && this.isCurrentRevision(job, item.revision) && item.status === "failed");
        if (failedRun) failedRun.error = error;
        job.updatedAt = now();
        this.touchConversation(state, job);
        return [this.appendEvent(state, job, "job.failed", { error, refined: true })];
      }
      const timestamp = now(); job.status = "failed"; job.error = error; job.updatedAt = timestamp; job.completedAt = timestamp;
      for (const run of state.stageRuns.filter((item) => item.jobId === job.id && this.isCurrentRevision(job, item.revision) && item.status === "running")) { run.status = "failed"; run.completedAt = timestamp; run.error = error; }
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
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job) throw notFound("job");
    const artifacts = state.artifacts.filter((item) => item.jobId === jobId && this.isCurrentRevision(job, item.revision) && item.validated);
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
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job) throw notFound("job");
    const artifacts = state.artifacts.filter((item) => item.jobId === jobId && this.isCurrentRevision(job, item.revision) && item.validated);
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

  private mergeRetrievalResults(responses: RetrievalResponse[], topK: number): RetrievalCaseResult[] {
    const grouped = new Map<string, RetrievalCaseResult & { _rrf: number; _full: boolean; _subgraph: boolean }>();
    for (const response of responses) {
      response.results.forEach((result, index) => {
        const rank = Math.max(1, Number(result.rank ?? index + 1));
        const current = grouped.get(result.caseId) ?? {
          ...result, caseId: result.caseId, _rrf: 0, _full: false, _subgraph: false, subgraphMatches: [],
        };
        current._rrf += 1 / (60 + rank);
        current._full ||= result.matchKind === "full" || result.matchKind === "both" || Boolean(result.fullMatch);
        current._subgraph ||= result.matchKind === "subgraph" || result.matchKind === "both" || Boolean(result.subgraphMatches?.length);
        current.summary ||= result.summary;
        current.experiencePreview ||= result.experiencePreview;
        current.fullMatch ||= result.fullMatch;
        current.availableFiles ||= result.availableFiles;
        current.artifacts ||= result.artifacts;
        const seen = new Set((current.subgraphMatches ?? []).map((item) => String(item.subgraphId ?? "")));
        for (const match of result.subgraphMatches ?? []) {
          const id = String(match.subgraphId ?? "");
          if (!id || seen.has(id)) continue;
          current.subgraphMatches!.push(match);
          seen.add(id);
        }
        current.subgraphMatches = current.subgraphMatches!.sort((left, right) => Number(right.score ?? 0) - Number(left.score ?? 0)).slice(0, 3);
        grouped.set(result.caseId, current);
      });
    }
    return [...grouped.values()]
      .sort((left, right) => right._rrf - left._rrf)
      .slice(0, topK)
      .map((item, index) => {
        const { _rrf, _full, _subgraph, ...result } = item;
        return {
          ...result,
          rank: index + 1,
          fusedScore: _rrf,
          matchKind: _full && _subgraph ? "both" : _subgraph ? "subgraph" : "full",
        };
      });
  }

  private queueCaseIndex(jobId: string): void {
    if (!this.config.retrievalUrl) return;
    const previous = this.indexingTasks.get(jobId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => await this.runCaseIndex(jobId));
    this.indexingTasks.set(jobId, task);
    void task.finally(() => {
      if (this.indexingTasks.get(jobId) === task) this.indexingTasks.delete(jobId);
    });
  }

  private async runCaseIndex(jobId: string): Promise<void> {
    const entry = this.store.read((state) => state.ragEntries.find((item) => item.sourceJobId === jobId));
    if (!entry) return;
    const revision = entry.revision ?? 1;
    const modelFile = entry.files.find((item) => item.name.toLowerCase() === "model.json");
    if (!modelFile) return await this.failCaseIndex(jobId, revision, "RAG Case has no model.json");
    const requested = await this.store.transaction((state) => {
      const currentEntry = state.ragEntries.find((item) => item.sourceJobId === jobId);
      if (!currentEntry || (currentEntry.revision ?? 1) !== revision) return [];
      currentEntry.indexStatus = "pending";
      currentEntry.indexError = undefined;
      const job = state.jobs.find((item) => item.id === jobId);
      return job ? [this.appendEvent(state, job, "case.index.requested", { caseId: entry.id, revision, modelHash: modelFile.sha256 })] : [];
    });
    this.store.publish(requested);

    try {
      const modelJsonPath = resolve(entry.path, modelFile.relativePath);
      const manifestPath = resolve(entry.path, "manifest.json");
      this.assertChildPath(this.config.ragLibraryRoot, modelJsonPath);
      this.assertChildPath(this.config.ragLibraryRoot, manifestPath);
      let task = await this.retrieval.indexCase({
        caseId: entry.id,
        revision,
        modelHash: modelFile.sha256,
        modelJsonPath: relative(this.config.ragLibraryRoot, modelJsonPath).split(sep).join("/"),
        manifestPath: relative(this.config.ragLibraryRoot, manifestPath).split(sep).join("/"),
        files: entry.files.map((file) => {
          const path = resolve(entry.path, file.relativePath);
          this.assertChildPath(this.config.ragLibraryRoot, path);
          return { name: file.name, path, mimeType: file.mimeType };
        }),
        replace: true,
      });
      await this.store.transaction((state) => {
        const current = state.ragEntries.find((item) => item.sourceJobId === jobId && (item.revision ?? 1) === revision);
        if (current) { current.indexStatus = "indexing"; current.indexTaskId = task.taskId; }
      });
      const deadline = Date.now() + 15 * 60_000;
      while (!this.indexTaskCompleted(task.status)) {
        if (this.indexTaskFailed(task.status)) throw new Error(String(task.error ?? `Retrieval indexing failed with status ${task.status}`));
        if (Date.now() >= deadline) throw new Error("Retrieval indexing did not complete within 15 minutes");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
        task = await this.retrieval.indexTask(task.taskId);
      }
      const completed = await this.store.transaction((state) => {
        const current = state.ragEntries.find((item) => item.sourceJobId === jobId);
        if (!current || (current.revision ?? 1) !== revision) return [];
        current.indexStatus = "ready";
        current.indexError = undefined;
        current.indexTaskId = task.taskId;
        current.indexedRevision = revision;
        current.indexedAt = now();
        const job = state.jobs.find((item) => item.id === jobId);
        return job ? [this.appendEvent(state, job, "case.index.completed", { caseId: entry.id, revision, taskId: task.taskId })] : [];
      });
      this.store.publish(completed);
    } catch (error) {
      await this.failCaseIndex(jobId, revision, this.safeError(error));
    }
  }

  private indexTaskCompleted(status: string): boolean {
    return ["ready", "completed", "complete", "succeeded", "success"].includes(status.toLowerCase());
  }

  private indexTaskFailed(status: string): boolean {
    return ["failed", "error", "cancelled", "canceled"].includes(status.toLowerCase());
  }

  private async failCaseIndex(jobId: string, revision: number, message: string): Promise<void> {
    const failed = await this.store.transaction((state) => {
      const entry = state.ragEntries.find((item) => item.sourceJobId === jobId);
      if (!entry || (entry.revision ?? 1) !== revision) return [];
      entry.indexStatus = "failed";
      entry.indexError = message;
      const job = state.jobs.find((item) => item.id === jobId);
      return job ? [this.appendEvent(state, job, "case.index.failed", { caseId: entry.id, revision, error: { code: "CASE_INDEX_FAILED", message } })] : [];
    });
    this.store.publish(failed);
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
        state.retrievalGrants = state.retrievalGrants.filter((item) => !jobIds.has(item.jobId));
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
    const conversation = state.conversations.find((item) => item.id === job.conversationId);
    if (!conversation) throw notFound("conversation");
    const revision = this.jobRevision(job);
    const existing = state.ragEntries.find((item) => item.sourceJobId === job.id);
    const latestArtifact = (name: string): Artifact | undefined => [...state.artifacts].reverse().find((item) =>
      item.jobId === job.id && this.isCurrentRevision(job, item.revision) && item.validated && !item.partial && item.name.toLowerCase() === name.toLowerCase());
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
    const temporaryPath = resolve(entriesRoot, `.tmp-${job.id}-${randomUUID()}`);
    const stagedPath = resolve(entriesRoot, `.next-${job.id}-${randomUUID()}`);
    this.assertChildPath(this.config.ragLibraryRoot, temporaryPath);
    this.assertChildPath(this.config.ragLibraryRoot, stagedPath);
    let backupPath: string | undefined;
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
      const createdAt = existing?.createdAt ?? now();
      const updatedAt = now();
      const manifest: RagManifest = {
        schemaVersion: 1, id: job.id, sourceConversationId: job.conversationId, sourceJobId: job.id,
        sourceTitle: conversation.title, revision, createdAt, updatedAt,
        summary: summary || transitionSummary || job.summary || "CAD model archived",
        transitionSummary, validation, files,
      };
      await writeFile(resolve(temporaryPath, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      await mkdir(entriesRoot, { recursive: true });
      await rename(temporaryPath, stagedPath);
      try {
        await stat(finalPath);
        backupPath = resolve(entriesRoot, `.previous-${job.id}-${randomUUID()}`);
        this.assertChildPath(this.config.ragLibraryRoot, backupPath);
        await rename(finalPath, backupPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(stagedPath, finalPath);
      const manifestPath = resolve(finalPath, "manifest.json");
      const manifestFile = await stat(manifestPath);
      const archiveFiles = [...files, {
        name: "manifest.json", relativePath: "manifest.json", mimeType: "application/json",
        size: manifestFile.size, sha256: await this.sha256File(manifestPath),
      }];
      const entry: RagArchiveEntry = {
        id: job.id, sourceConversationId: job.conversationId, sourceJobId: job.id,
        sourceTitle: conversation.title, path: finalPath, summary: manifest.summary, files: archiveFiles, createdAt, revision, updatedAt,
        indexStatus: "pending", indexTaskId: undefined, indexError: undefined,
        indexedRevision: existing?.indexedRevision, indexedAt: existing?.indexedAt,
      };
      const existingIndex = state.ragEntries.findIndex((item) => item.sourceJobId === job.id);
      if (existingIndex >= 0) state.ragEntries[existingIndex] = entry;
      else state.ragEntries.push(entry);
      if (backupPath) await rm(backupPath, { recursive: true, force: true }).catch(() => undefined);
      return entry;
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
      await rm(stagedPath, { recursive: true, force: true }).catch(() => undefined);
      if (backupPath) {
        await rm(finalPath, { recursive: true, force: true }).catch(() => undefined);
        await rename(backupPath, finalPath).catch(() => undefined);
      }
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
    conversation.jobId = job.id;
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
  revision?: number;
  createdAt: string;
  updatedAt?: string;
  summary: string;
  transitionSummary?: string;
  validation?: unknown;
  files: RagArchiveFile[];
}
