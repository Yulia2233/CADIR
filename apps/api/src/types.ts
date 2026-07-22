import type { Artifact, ChatMessage, Conversation, Job, JobEvent, ModelSettings, RagArchiveEntry, StageRun, Upload } from "../../../packages/contracts/src/index.js";

export interface DatabaseState {
  conversations: Conversation[];
  jobs: Job[];
  stageRuns: StageRun[];
  messages: ChatMessage[];
  artifacts: Artifact[];
  uploads: Upload[];
  events: JobEvent[];
  ragEntries: RagArchiveEntry[];
  modelSettings: ModelSettings;
}

export const emptyDatabase = (): DatabaseState => ({
  conversations: [], jobs: [], stageRuns: [], messages: [], artifacts: [], uploads: [], events: [], ragEntries: [],
  modelSettings: { modelId: "gpt-5.6-sol", effort: "medium" },
});
