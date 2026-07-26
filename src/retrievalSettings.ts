import type { ModelSettings } from "../packages/contracts/src/index.js";

export const DEFAULT_RETRIEVAL_TEXT_TOP_K = 5;
export const DEFAULT_RETRIEVAL_SUBGRAPH_TOP_K = 5;
export const MIN_RETRIEVAL_TOP_K = 1;
export const MAX_RETRIEVAL_TOP_K = 100;
export const DEFAULT_SUBGRAPH_MAX_NODES = 16;
export const MIN_SUBGRAPH_MAX_NODES = 3;
export const MAX_SUBGRAPH_MAX_NODES = 64;

export function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

export function normalizeModelSettings(settings: Partial<ModelSettings>): ModelSettings {
  return {
    modelId: settings.modelId ?? "gpt-5.6-sol",
    effort: settings.effort ?? "medium",
    selfEvolutionEnabled: settings.selfEvolutionEnabled !== false,
    retrievalMode: settings.retrievalMode ?? "full_and_subgraph",
    retrievalPool: settings.retrievalPool ?? "both",
    retrievalTextTopK: clampInteger(
      settings.retrievalTextTopK,
      DEFAULT_RETRIEVAL_TEXT_TOP_K,
      MIN_RETRIEVAL_TOP_K,
      MAX_RETRIEVAL_TOP_K,
    ),
    retrievalSubgraphTopK: clampInteger(
      settings.retrievalSubgraphTopK,
      DEFAULT_RETRIEVAL_SUBGRAPH_TOP_K,
      MIN_RETRIEVAL_TOP_K,
      MAX_RETRIEVAL_TOP_K,
    ),
    subgraphMaxNodes: clampInteger(
      settings.subgraphMaxNodes,
      DEFAULT_SUBGRAPH_MAX_NODES,
      MIN_SUBGRAPH_MAX_NODES,
      MAX_SUBGRAPH_MAX_NODES,
    ),
  };
}
