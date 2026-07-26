import { readFile } from "node:fs/promises";
import type { RetrievalMode, RetrievalSource } from "../../../packages/contracts/src/index.js";
import type { AppConfig } from "./config.js";

export type RetrievalScope = Exclude<RetrievalMode, "none" | "hybrid"> | "subgraph";

export interface RetrievalQueryOptions {
  scope: RetrievalScope;
  sources: RetrievalSource[];
  topK: number;
  subgraphMaxNodes: number;
  excludeCaseIds?: string[];
  requestId?: string;
  jobId?: string;
  revision?: number;
}

export interface HybridRetrievalQueryOptions {
  sources: RetrievalSource[];
  textTopK: number;
  subgraphTopK: number;
  subgraphMaxNodes: number;
  excludeCaseIds?: string[];
  requestId?: string;
  jobId?: string;
  revision?: number;
}

export interface RetrievalCaseResult {
  caseId: string;
  rank?: number;
  score?: number;
  fusedScore?: number;
  matchKind?: "full" | "subgraph" | "both" | "summary_text" | "summary_text+subgraph";
  provenance?: Array<"summary_text" | "subgraph">;
  textScore?: number;
  subgraphScore?: number;
  textMatch?: Record<string, unknown>;
  summary?: string;
  experiencePreview?: string;
  fullMatch?: Record<string, unknown>;
  subgraphMatches?: Array<Record<string, unknown>>;
  availableFiles?: unknown;
  artifacts?: unknown;
  [key: string]: unknown;
}

export interface RetrievalResponse {
  requestId?: string;
  requestedTopK?: number;
  returnedCount?: number;
  partial?: boolean;
  results: RetrievalCaseResult[];
  [key: string]: unknown;
}

export interface CaseIndexRequest {
  caseId: string;
  revision: number;
  modelHash: string;
  modelJsonPath: string;
  manifestPath: string;
  files?: Array<{ name: string; path: string; mimeType: string }>;
  replace: true;
}

export interface IndexTaskResponse {
  taskId: string;
  status: string;
  [key: string]: unknown;
}

export interface RetrievalAdapter {
  health(): Promise<boolean>;
  retrieveText(query: string, options: RetrievalQueryOptions): Promise<RetrievalResponse>;
  retrieveHybrid(query: string, options: HybridRetrievalQueryOptions): Promise<RetrievalResponse>;
  retrieveImage(image: { bytes: Uint8Array; filename: string; mimeType: string }, options: RetrievalQueryOptions): Promise<RetrievalResponse>;
  indexCase(input: CaseIndexRequest): Promise<IndexTaskResponse>;
  indexTask(taskId: string): Promise<IndexTaskResponse>;
  readCase(caseId: string, options?: { subgraphId?: string; include?: string[] }): Promise<Record<string, unknown>>;
}

export class UnavailableRetrievalAdapter implements RetrievalAdapter {
  async health(): Promise<boolean> { return false; }
  private unavailable(): never { throw new Error("RETRIEVAL_URL is not configured"); }
  async retrieveText(): Promise<RetrievalResponse> { return this.unavailable(); }
  async retrieveHybrid(): Promise<RetrievalResponse> { return this.unavailable(); }
  async retrieveImage(): Promise<RetrievalResponse> { return this.unavailable(); }
  async indexCase(): Promise<IndexTaskResponse> { return this.unavailable(); }
  async indexTask(): Promise<IndexTaskResponse> { return this.unavailable(); }
  async readCase(): Promise<Record<string, unknown>> { return this.unavailable(); }
}

export class HttpRetrievalAdapter implements RetrievalAdapter {
  private readonly baseUrl: string;

  constructor(private readonly config: AppConfig) {
    if (!config.retrievalUrl) throw new Error("RETRIEVAL_URL is required");
    this.baseUrl = config.retrievalUrl.replace(/\/$/, "");
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.request("/health", {}, true, 1_000);
      return response.healthy === true || response.status === "ok" || response.ready === true;
    } catch {
      return false;
    }
  }

  async retrieveText(query: string, options: RetrievalQueryOptions): Promise<RetrievalResponse> {
    return this.normalizeRetrieval(await this.request("/v1/retrieve/text", {
      method: "POST",
      body: JSON.stringify({ query, ...options }),
    }));
  }

  async retrieveHybrid(query: string, options: HybridRetrievalQueryOptions): Promise<RetrievalResponse> {
    return this.normalizeRetrieval(await this.request("/v1/retrieve/hybrid", {
      method: "POST",
      body: JSON.stringify({ query, ...options }),
    }));
  }

  async retrieveImage(
    image: { bytes: Uint8Array; filename: string; mimeType: string },
    options: RetrievalQueryOptions,
  ): Promise<RetrievalResponse> {
    const body = new FormData();
    body.append("image", new Blob([Uint8Array.from(image.bytes).buffer], { type: image.mimeType }), image.filename);
    body.append("options", JSON.stringify(options));
    return this.normalizeRetrieval(await this.request("/v1/retrieve/image", { method: "POST", body }, false));
  }

  async indexCase(input: CaseIndexRequest): Promise<IndexTaskResponse> {
    if (input.files?.length) {
      const { files, ...metadata } = input;
      const body = new FormData();
      body.append("metadata", JSON.stringify(metadata));
      for (const file of files) {
        const bytes = await readFile(file.path);
        body.append("files", new Blob([Uint8Array.from(bytes).buffer], { type: file.mimeType }), file.name);
      }
      return this.normalizeTask(await this.request("/v1/index/cases/upload", { method: "POST", body }, false));
    }
    return this.normalizeTask(await this.request("/v1/index/cases", { method: "POST", body: JSON.stringify(input) }));
  }

  async indexTask(taskId: string): Promise<IndexTaskResponse> {
    return this.normalizeTask(await this.request(`/v1/index/tasks/${encodeURIComponent(taskId)}`));
  }

  async readCase(caseId: string, options: { subgraphId?: string; include?: string[] } = {}): Promise<Record<string, unknown>> {
    const query = new URLSearchParams();
    if (options.subgraphId) query.set("subgraphId", options.subgraphId);
    if (options.include?.length) query.set("include", options.include.join(","));
    const suffix = query.size ? `?${query.toString()}` : "";
    return await this.request(`/v1/cases/${encodeURIComponent(caseId)}${suffix}`);
  }

  private normalizeRetrieval(value: Record<string, unknown>): RetrievalResponse {
    const results = Array.isArray(value.results) ? value.results : [];
    return {
      ...value,
      returnedCount: Number(value.returnedCount ?? results.length),
      results: results.filter((item): item is RetrievalCaseResult => Boolean(
        item && typeof item === "object" && typeof (item as RetrievalCaseResult).caseId === "string",
      )),
    };
  }

  private normalizeTask(value: Record<string, unknown>): IndexTaskResponse {
    const nested = value.task && typeof value.task === "object" ? value.task as Record<string, unknown> : undefined;
    const taskId = String(value.taskId ?? value.indexTaskId ?? nested?.taskId ?? nested?.id ?? "");
    if (!taskId) throw new Error("Retrieval index response did not include taskId");
    return { ...value, taskId, status: String(value.status ?? nested?.status ?? "queued") };
  }

  private async request(path: string, init: RequestInit = {}, json = true, timeoutMs = this.config.retrievalTimeoutMs ?? 30_000): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set("accept", "application/json");
      if (json && init.body) headers.set("content-type", "application/json");
      if (this.config.retrievalInternalToken) headers.set("x-internal-token", this.config.retrievalInternalToken);
      const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
      const text = await response.text();
      let payload: Record<string, unknown> = {};
      if (text) {
        try { payload = JSON.parse(text) as Record<string, unknown>; }
        catch { payload = { detail: text.slice(0, 2000) }; }
      }
      if (!response.ok) {
        const nested = payload.error && typeof payload.error === "object" ? payload.error as Record<string, unknown> : undefined;
        throw new Error(String(nested?.message ?? payload.message ?? payload.detail ?? `Retrieval request failed (${response.status})`));
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createRetrievalAdapter(config: AppConfig): RetrievalAdapter {
  return config.retrievalUrl ? new HttpRetrievalAdapter(config) : new UnavailableRetrievalAdapter();
}
