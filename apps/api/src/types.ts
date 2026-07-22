import type { Artifact, ChatMessage, Conversation, Job, JobEvent, ModelSettings, RagArchiveEntry, StageRun, Upload } from "../../../packages/contracts/src/index.js";

export interface RetrievalGrant {
  id: string;
  jobId: string;
  revision: number;
  query: string;
  caseIds: string[];
  results: Array<Record<string, unknown>>;
  createdAt: string;
}

export interface DatabaseState {
  conversations: Conversation[];
  jobs: Job[];
  stageRuns: StageRun[];
  messages: ChatMessage[];
  artifacts: Artifact[];
  uploads: Upload[];
  events: JobEvent[];
  ragEntries: RagArchiveEntry[];
  retrievalGrants: RetrievalGrant[];
  modelSettings: ModelSettings;
}

export const emptyDatabase = (): DatabaseState => ({
  conversations: [], jobs: [], stageRuns: [], messages: [], artifacts: [], uploads: [], events: [], ragEntries: [], retrievalGrants: [],
  modelSettings: { modelId: "gpt-5.6-sol", effort: "medium", retrievalMode: "full_and_subgraph", retrievalPool: "both", subgraphMaxNodes: 16 },
});
