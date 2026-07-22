export type JobStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled";

export type StageKey = "requirements" | "codegen" | "visual" | "evolution";
export type ModelEffort = "low" | "medium" | "high";

export type StageStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "failed"
  | "waiting_input"
  | "cancelled";

export type ConnectionStatus =
  | "idle"
  | "syncing"
  | "connected"
  | "stale"
  | "offline"
  | "error";

export interface ApiErrorShape {
  code?: string;
  message: string;
  detail?: string;
  retryable?: boolean;
  source?: "model_provider" | "opencode" | "tool" | "runtime" | "application";
}

export interface Job {
  id: string;
  conversationId?: string;
  status: JobStatus;
  currentStage?: StageKey | null;
  updatedAt?: string;
  backendHeartbeatAt?: string;
  error?: ApiErrorShape | null;
  summary?: string;
  modelId?: string;
  modelProvider?: string;
  effort?: ModelEffort;
  revision?: number;
}

export interface ModelOption {
  id: string;
  label: string;
  providerId: string;
  imageInput: boolean;
  efforts: ModelEffort[];
}

export interface ModelSettings {
  modelId: string;
  effort: ModelEffort;
}

export interface ModelSettingsResponse {
  settings: ModelSettings;
  models: ModelOption[];
  efforts: ModelEffort[];
}

export interface StageRun {
  id: string;
  jobId: string;
  stage: StageKey;
  status: StageStatus;
  attempt: number;
  revision?: number;
  summary?: string;
  startedAt?: string;
  completedAt?: string;
  usage: Usage;
  // Client-only incremental presentation fields. Snapshots may omit them.
  output?: string;
  lines?: string[];
  error?: ApiErrorShape | null;
  toolError?: ApiErrorShape | null;
}

export interface ChatImage {
  id?: string;
  url: string;
  alt?: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  jobId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  status?: "streaming" | "completed" | "failed";
  createdAt?: string;
  completedAt?: string;
  imageArtifactIds: string[];
  images?: ChatImage[];
}

export interface Usage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  [key: string]: number | undefined;
}

export interface Artifact {
  id: string;
  jobId: string;
  stageRunId?: string;
  revision?: number;
  kind?: string;
  type?: string;
  format?: string;
  name: string;
  path?: string;
  url?: string;
  downloadUrl?: string;
  mimeType?: string;
  validated?: boolean;
  partial?: boolean;
  createdAt?: string;
  size?: number;
}

export interface JobSnapshot {
  serverTime: string;
  lastSeq: number;
  job: Job;
  stageRuns: StageRun[];
  messages: ChatMessage[];
  usage: Usage;
  artifacts: Artifact[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  preview?: string;
  latestJobStatus?: JobStatus;
  revision?: number;
  createdAt?: string;
  updatedAt?: string;
  latestJobId?: string | null;
  deletionStatus?: "deleting" | "failed";
  deletionError?: string;
}

export interface DeleteConversationResponse {
  deleted: true;
  conversationId: string;
  retainedRagEntries: number;
  alreadyDeleted?: boolean;
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  snapshot?: JobSnapshot | null;
}

export interface UploadedImage {
  id: string;
  conversationId: string;
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  size: number;
  createdAt: string;
  downloadUrl: string;
}

export interface StreamEvent<T = Record<string, unknown>> {
  seq?: number;
  eventId?: string;
  jobId: string;
  conversationId?: string;
  sessionId?: string;
  timestamp?: string;
  type: string;
  data: T;
}

export interface HeartbeatData {
  serverTime?: string;
  jobStatus?: JobStatus;
  lastSeq?: number;
  backendHealthy?: boolean;
}

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const configuredBase = import.meta.env.VITE_API_PROXY_TARGET
  ? ""
  : ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "");
export const API_BASE = configuredBase.replace(/\/$/, "");

function apiUrl(path: string) {
  return `${API_BASE}${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");

  const response = await fetch(apiUrl(path), { ...init, headers });
  if (!response.ok) {
    let details: { message?: string; error?: { message?: string; code?: string }; code?: string } = {};
    try {
      details = await response.json();
    } catch {
      // The status text is enough when a proxy returns a non-JSON error page.
    }
    const message = details.error?.message ?? details.message ?? response.statusText ?? "请求失败";
    throw new ApiError(message, response.status, details.error?.code ?? details.code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function asConversationList(payload: unknown): ConversationSummary[] {
  if (Array.isArray(payload)) return payload as ConversationSummary[];
  if (payload && typeof payload === "object") {
    const object = payload as Record<string, unknown>;
    const list = object.conversations ?? object.items ?? object.data;
    if (Array.isArray(list)) return list as ConversationSummary[];
  }
  return [];
}

export const api = {
  async listConversations() {
    return asConversationList(await request<unknown>("/api/conversations"));
  },

  createConversation(title?: string) {
    return request<ConversationSummary | ConversationDetail>("/api/conversations", {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
    });
  },

  getConversation(id: string) {
    return request<ConversationDetail | ConversationSummary>(`/api/conversations/${encodeURIComponent(id)}`);
  },

  getSettings() {
    return request<ModelSettingsResponse>("/api/settings");
  },

  updateSettings(settings: ModelSettings) {
    return request<ModelSettingsResponse>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(settings),
    });
  },

  deleteConversation(id: string) {
    return request<DeleteConversationResponse>(`/api/conversations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  uploadImage(conversationId: string, file: File) {
    const body = new FormData();
    body.append("file", file, file.name);
    return request<{ upload: UploadedImage; artifactId: string }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/uploads`,
      { method: "POST", body },
    );
  },

  sendMessage(
    conversationId: string,
    content: string,
    options: { resumeJobId?: string; imageArtifactIds?: string[] } = {},
  ) {
    return request<{ jobId: string; snapshot?: JobSnapshot }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          content,
          ...(options.resumeJobId ? { resumeJobId: options.resumeJobId } : {}),
          ...(options.imageArtifactIds?.length ? { imageArtifactIds: options.imageArtifactIds } : {}),
        }),
      },
    );
  },

  getJob(jobId: string, signal?: AbortSignal) {
    return request<JobSnapshot>(`/api/jobs/${encodeURIComponent(jobId)}`, { signal });
  },

  cancelJob(jobId: string) {
    return request<JobSnapshot | { accepted: boolean }>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
    });
  },

  retryJob(jobId: string) {
    return request<JobSnapshot>(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
      method: "POST",
    });
  },

  eventsUrl(jobId: string, after: number) {
    return apiUrl(`/api/jobs/${encodeURIComponent(jobId)}/events?after=${encodeURIComponent(after)}`);
  },

  artifactDownloadUrl(jobId: string, artifact: Artifact) {
    const supplied = artifact.downloadUrl ?? artifact.url;
    if (supplied) {
      if (/^https?:\/\//i.test(supplied)) return supplied;
      return apiUrl(supplied.startsWith("/") ? supplied : `/${supplied}`);
    }
    return apiUrl(
      `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifact.id)}/download`,
    );
  },
};

export function isTerminal(status?: JobStatus) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

const eventNames = [
  "job.started",
  "stage.updated",
  "message.started",
  "message.delta",
  "message.completed",
  "tool.updated",
  "usage.updated",
  "image.read",
  "artifact.created",
  "job.needs_input",
  "job.completed",
  "job.failed",
  "job.cancelled",
  "heartbeat",
];

export interface JobStreamOptions {
  jobId: string;
  onSnapshot: (snapshot: JobSnapshot) => void;
  onEvent: (event: StreamEvent) => void;
  onStatus: (status: ConnectionStatus, error?: string) => void;
  onTerminal?: (snapshot: JobSnapshot) => void;
}

/**
 * Owns one browser-to-BFF stream. Every recovery begins with an authoritative
 * snapshot, so refreshing, sleeping, and missed SSE events all converge safely.
 */
export class JobStreamController {
  private options: JobStreamOptions;
  private source: EventSource | null = null;
  private snapshotAbort: AbortController | null = null;
  private reconnectTimer: number | null = null;
  private watchdogTimer: number | null = null;
  private retryAttempt = 0;
  private lastActivityAt = 0;
  private lastSeq = 0;
  private stopped = false;
  private syncing = false;

  constructor(options: JobStreamOptions) {
    this.options = options;
  }

  start() {
    this.stopped = false;
    this.attachRecoveryListeners();
    void this.synchronize();
  }

  stop() {
    this.stopped = true;
    this.detachRecoveryListeners();
    this.closeTransport();
    this.options.onStatus("idle");
  }

  recoverNow = () => {
    if (this.stopped || document.visibilityState === "hidden") return;
    if (!navigator.onLine) {
      this.options.onStatus("offline", "网络连接已断开");
      return;
    }
    this.retryAttempt = 0;
    this.closeTransport();
    void this.synchronize();
  };

  private attachRecoveryListeners() {
    window.addEventListener("online", this.recoverNow);
    window.addEventListener("focus", this.recoverNow);
    document.addEventListener("visibilitychange", this.handleVisibility);
    window.addEventListener("offline", this.handleOffline);
  }

  private detachRecoveryListeners() {
    window.removeEventListener("online", this.recoverNow);
    window.removeEventListener("focus", this.recoverNow);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    window.removeEventListener("offline", this.handleOffline);
  }

  private handleVisibility = () => {
    if (document.visibilityState === "visible") this.recoverNow();
  };

  private handleOffline = () => {
    this.closeTransport();
    this.options.onStatus("offline", "网络连接已断开");
  };

  private closeTransport() {
    this.source?.close();
    this.source = null;
    this.snapshotAbort?.abort();
    this.snapshotAbort = null;
    this.syncing = false;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    if (this.watchdogTimer !== null) window.clearInterval(this.watchdogTimer);
    this.reconnectTimer = null;
    this.watchdogTimer = null;
  }

  private async synchronize() {
    if (this.stopped || this.syncing) return;
    if (!navigator.onLine) {
      this.options.onStatus("offline", "网络连接已断开");
      return;
    }

    this.syncing = true;
    this.options.onStatus("syncing");
    const abort = new AbortController();
    this.snapshotAbort = abort;
    try {
      const snapshot = await api.getJob(this.options.jobId, abort.signal);
      if (this.stopped) return;
      this.lastSeq = snapshot.lastSeq ?? 0;
      this.options.onSnapshot(snapshot);
      this.retryAttempt = 0;
      if (isTerminal(snapshot.job.status)) {
        this.syncing = false;
        this.options.onStatus("idle");
        this.options.onTerminal?.(snapshot);
        return;
      }
      this.openStream();
    } catch (error) {
      if (this.stopped || (error instanceof DOMException && error.name === "AbortError")) return;
      this.syncing = false;
      this.retryAttempt += 1;
      const message = error instanceof Error ? error.message : "无法连接服务器";
      this.options.onStatus("error", message);
      this.scheduleReconnect();
    } finally {
      if (this.snapshotAbort === abort) this.snapshotAbort = null;
    }
  }

  private openStream() {
    if (this.stopped) return;
    this.source?.close();
    const source = new EventSource(api.eventsUrl(this.options.jobId, this.lastSeq));
    this.source = source;
    this.lastActivityAt = Date.now();
    this.syncing = false;

    source.onopen = () => {
      if (source !== this.source) return;
      this.retryAttempt = 0;
      this.lastActivityAt = Date.now();
      this.options.onStatus("connected");
    };

    const receive = (message: MessageEvent<string>) => {
      if (source !== this.source) return;
      this.lastActivityAt = Date.now();
      let event: StreamEvent;
      try {
        const parsed = JSON.parse(message.data) as StreamEvent | HeartbeatData;
        event = ("type" in parsed
          ? parsed
          : { jobId: this.options.jobId, type: message.type, data: parsed }) as StreamEvent;
      } catch {
        this.failAndReconnect("服务器返回了无法解析的事件");
        return;
      }
      if (!event.type && message.type !== "message") event.type = message.type;
      if (event.type === "heartbeat") {
        const heartbeat = (event.data ?? {}) as HeartbeatData;
        if (heartbeat.backendHealthy === false) {
          this.failAndReconnect("后端健康检查失败");
        }
        return;
      }
      const seq = Number(event.seq ?? 0);
      if (seq > 0) {
        if (seq <= this.lastSeq) return;
        if (seq !== this.lastSeq + 1) {
          this.failAndReconnect("事件序号不连续，正在重新同步");
          return;
        }
        this.lastSeq = seq;
      }
      this.options.onEvent(event);
      if (event.type === "job.completed" || event.type === "job.failed" || event.type === "job.cancelled") {
        this.source?.close();
        this.source = null;
        if (this.watchdogTimer !== null) window.clearInterval(this.watchdogTimer);
        this.watchdogTimer = null;
        void this.synchronize();
      }
    };

    source.onmessage = receive;
    for (const name of eventNames) source.addEventListener(name, receive as EventListener);
    source.onerror = () => {
      if (source !== this.source || this.stopped) return;
      this.failAndReconnect("实时连接已断开");
    };

    this.watchdogTimer = window.setInterval(() => {
      if (Date.now() - this.lastActivityAt > 45_000) {
        this.failAndReconnect("45 秒未收到服务器心跳");
      }
    }, 5_000);
  }

  private failAndReconnect(message: string) {
    if (this.stopped) return;
    this.source?.close();
    this.source = null;
    if (this.watchdogTimer !== null) window.clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    this.options.onStatus("stale", message);
    this.retryAttempt += 1;
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer !== null || this.syncing) return;
    const base = Math.min(30_000, 1_000 * 2 ** Math.min(this.retryAttempt, 5));
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.synchronize();
    }, delay);
  }
}
