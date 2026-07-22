import { resolve } from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  dataFile: string;
  jobsRoot: string;
  ragLibraryRoot: string;
  corsOrigin: string;
  heartbeatMs: number;
  watchdogMs: number;
  openCodeUrl?: string;
  openCodeUsername: string;
  openCodePassword?: string;
  openCodeAgent: string;
  modelProvider: string;
  modelId: string;
  retrievalUrl?: string;
  retrievalInternalToken?: string;
  retrievalTimeoutMs?: number;
  retrievalTopK?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: env.API_HOST ?? "0.0.0.0",
    port: Number(env.API_PORT ?? 3000),
    dataFile: resolve(env.CADIR_DATA_FILE ?? "./data/cadir.json"),
    jobsRoot: resolve(env.CADIR_JOBS_ROOT ?? "./data/jobs"),
    ragLibraryRoot: resolve(env.CADIR_RAG_LIBRARY_ROOT ?? "./data/rag-library"),
    corsOrigin: env.CORS_ORIGIN ?? "http://localhost:5173",
    heartbeatMs: Number(env.SSE_HEARTBEAT_MS ?? 15_000),
    watchdogMs: Number(env.OPENCODE_WATCHDOG_MS ?? 120_000),
    openCodeUrl: env.OPENCODE_URL,
    openCodeUsername: env.OPENCODE_SERVER_USERNAME ?? "opencode",
    openCodePassword: env.OPENCODE_SERVER_PASSWORD,
    openCodeAgent: env.OPENCODE_AGENT ?? "cadir-agent",
    modelProvider: env.OPENCODE_MODEL_PROVIDER ?? "cadir",
    modelId: env.CADIR_MODEL_ID ?? "gpt-5.6-sol",
    retrievalUrl: env.RETRIEVAL_URL?.trim() || undefined,
    retrievalInternalToken: env.RETRIEVAL_INTERNAL_TOKEN?.trim() || env.INTERNAL_API_TOKEN?.trim() || undefined,
    retrievalTimeoutMs: Number(env.RETRIEVAL_TIMEOUT_MS ?? 30_000),
    retrievalTopK: Number(env.RETRIEVAL_TOP_K ?? 5),
  };
}
