export const STAGES = ["requirements", "codegen", "visual", "evolution"] as const;
export type Stage = (typeof STAGES)[number];

export const MODEL_EFFORTS = ["low", "medium", "high"] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

export const RETRIEVAL_MODES = ["none", "full", "full_and_subgraph"] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];
export const RETRIEVAL_POOLS = ["base", "dynamic", "both"] as const;
export type RetrievalPool = (typeof RETRIEVAL_POOLS)[number];
export const RETRIEVAL_SOURCES = ["base", "dynamic"] as const;
export type RetrievalSource = (typeof RETRIEVAL_SOURCES)[number];
export const DEFAULT_SUBGRAPH_MAX_NODES = 16;
export const MIN_SUBGRAPH_MAX_NODES = 3;
export const MAX_SUBGRAPH_MAX_NODES = 64;

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
  retrievalMode: RetrievalMode;
  retrievalPool: RetrievalPool;
  subgraphMaxNodes: number;
}

export interface ModelSettingsResponse {
  settings: ModelSettings;
  models: ModelOption[];
  efforts: typeof MODEL_EFFORTS[number][];
}

export const TERMINAL_JOB_STATUSES = ["completed", "failed", "cancelled"] as const;
export type JobStatus = "queued" | "running" | "waiting_input" | (typeof TERMINAL_JOB_STATUSES)[number];
export type StageStatus = "running" | "completed" | "skipped" | "failed" | "cancelled" | "waiting_input";

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface Conversation {
  id: string;
  title: string;
  openCodeSessionId?: string;
  latestJobId?: string;
  latestJobStatus?: JobStatus;
  /** Stable one-to-one job mapping for this conversation. */
  jobId?: string;
  deletionStatus?: "deleting" | "failed";
  deletionError?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface RagArchiveFile {
  name: string;
  relativePath: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export interface RagArchiveEntry {
  id: string;
  sourceConversationId: string;
  sourceJobId: string;
  sourceTitle: string;
  path: string;
  summary: string;
  files: RagArchiveFile[];
  createdAt: string;
  /** Revision of the last successful model archived for this job. */
  revision?: number;
  updatedAt?: string;
  indexStatus?: "pending" | "indexing" | "ready" | "failed";
  indexTaskId?: string;
  indexError?: string;
  indexedRevision?: number;
  indexedAt?: string;
}

export interface JobError {
  code: string;
  message: string;
  detail?: string;
  retryable?: boolean;
  source?: "model_provider" | "opencode" | "tool" | "runtime" | "application";
}

export interface Job {
  id: string;
  conversationId: string;
  openCodeSessionId?: string;
  workspacePath: string;
  status: JobStatus;
  currentStage?: Stage;
  summary?: string;
  error?: JobError;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  backendHeartbeatAt: string;
  lastOpenCodeEventAt?: string;
  modelId?: string;
  modelProvider?: string;
  effort?: ModelEffort;
  retrievalMode?: RetrievalMode;
  retrievalPool?: RetrievalPool;
  subgraphMaxNodes?: number;
  /** Incremented for each user-requested modification of the same job. */
  revision?: number;
}

export type CadirToolName = "cadir_retrieve" | "cadir_case_read";
export type ToolActivityStatus = "running" | "completed" | "failed";

export interface ToolActivity {
  id: string;
  tool: CadirToolName;
  status: ToolActivityStatus;
  /** Character offset in StageRun.output when the tool call started. */
  outputOffset?: number;
  /** Authoritative JobEvent sequence that anchors this call in the stage stream. */
  orderSeq?: number;
  query?: string;
  caseId?: string;
  resultCount?: number;
  summary?: string;
  startedAt: string;
  completedAt?: string;
}

export interface StageRun {
  id: string;
  jobId: string;
  stage: Stage;
  attempt: number;
  /** Modification revision that owns this stage attempt. */
  revision?: number;
  status: StageStatus;
  summary?: string;
  output?: string;
  error?: JobError;
  toolError?: JobError;
  toolActivities?: ToolActivity[];
  usage: TokenUsage;
  /** Cumulative OpenCode usage observed when this attempt started. */
  usageBaseline?: TokenUsage;
  startedAt: string;
  completedAt?: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  jobId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  imageArtifactIds: string[];
  createdAt: string;
  completedAt?: string;
}

export type ArtifactKind = "requirements" | "python" | "step" | "stl" | "freecad" | "image" | "summary" | "experience" | "other";
export interface Artifact {
  id: string;
  jobId: string;
  stageRunId?: string;
  /** Modification revision that produced this artifact. */
  revision?: number;
  name: string;
  kind: ArtifactKind;
  path: string;
  mimeType: string;
  size: number;
  validated: boolean;
  partial: boolean;
  createdAt: string;
  downloadUrl: string;
}

export interface Upload {
  id: string;
  conversationId: string;
  name: string;
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  size: number;
  createdAt: string;
  downloadUrl: string;
}

export type EventType =
  | "job.started" | "stage.updated" | "message.started" | "message.delta"
  | "message.completed" | "tool.updated" | "usage.updated" | "image.read"
  | "retrieval.started" | "retrieval.completed" | "retrieval.failed"
  | "case.read.started" | "case.read.completed" | "case.read.failed"
  | "case.index.requested" | "case.index.completed" | "case.index.failed"
  | "artifact.created" | "job.needs_input" | "job.completed" | "job.failed" | "job.cancelled";

export interface JobEvent {
  seq: number;
  eventId: string;
  jobId: string;
  conversationId: string;
  sessionId?: string;
  timestamp: string;
  type: EventType;
  data: Record<string, unknown>;
}

export interface JobSnapshot {
  serverTime: string;
  lastSeq: number;
  job: Job;
  stageRuns: StageRun[];
  messages: ChatMessage[];
  usage: TokenUsage;
  artifacts: Artifact[];
}

export interface CreateMessageRequest {
  content: string;
  imageArtifactIds?: string[];
  resumeJobId?: string;
}

export interface CreateMessageResponse { jobId: string; snapshot: JobSnapshot }

export interface StageTransitionRequest {
  sessionID: string;
  stage: Stage;
  action: "running" | "complete" | "retry" | "fail" | "needs_input" | "skipped";
  summary?: string;
  error?: JobError;
}

export const emptyUsage = (): TokenUsage => ({
  input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0,
});

export function isTerminalJob(status: JobStatus): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}
