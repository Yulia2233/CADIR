export const STAGES = ["requirements", "codegen", "visual", "evolution"] as const;
export type Stage = (typeof STAGES)[number];

export const MODEL_EFFORTS = ["low", "medium", "high"] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

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
}

export interface StageRun {
  id: string;
  jobId: string;
  stage: Stage;
  attempt: number;
  status: StageStatus;
  summary?: string;
  output?: string;
  error?: JobError;
  toolError?: JobError;
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
