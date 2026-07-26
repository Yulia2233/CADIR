import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RETRIEVAL_TOP_K,
  MIN_RETRIEVAL_TOP_K,
  normalizeModelSettings,
} from "../../../src/retrievalSettings.js";

test("legacy settings receive stable hybrid retrieval defaults", () => {
  const settings = normalizeModelSettings({
    modelId: "gpt-5.6-sol",
    effort: "high",
    retrievalMode: "hybrid",
    retrievalPool: "both",
    subgraphMaxNodes: 20,
  });

  assert.equal(settings.retrievalMode, "hybrid");
  assert.equal(settings.selfEvolutionEnabled, true);
  assert.equal(settings.retrievalTextTopK, 5);
  assert.equal(settings.retrievalSubgraphTopK, 5);
  assert.equal(settings.subgraphMaxNodes, 20);
});

test("an explicit disabled self-evolution setting is preserved", () => {
  const settings = normalizeModelSettings({ selfEvolutionEnabled: false });

  assert.equal(settings.selfEvolutionEnabled, false);
});

test("hybrid retrieval counts are normalized to the server limits", () => {
  const settings = normalizeModelSettings({
    retrievalTextTopK: 0,
    retrievalSubgraphTopK: 101.8,
  });

  assert.equal(settings.retrievalTextTopK, MIN_RETRIEVAL_TOP_K);
  assert.equal(settings.retrievalSubgraphTopK, MAX_RETRIEVAL_TOP_K);
});
