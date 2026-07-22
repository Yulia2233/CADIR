import assert from "node:assert/strict";
import test from "node:test";
import { stageTimelineItems } from "../../../src/stageTimeline.js";

test("stage timeline interleaves tools at their original stream offsets", () => {
  const before = "Before retrieval\n";
  const between = "Inspecting retrieved summaries\n";
  const after = "Completing code generation stage";
  const items = stageTimelineItems({
    output: `${before}${between}${after}`,
    toolActivities: [
      {
        id: "retrieve", tool: "cadir_retrieve", status: "completed",
        outputOffset: before.length, orderSeq: 10, resultCount: 5, startedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "read", tool: "cadir_case_read", status: "completed",
        outputOffset: before.length + between.length, orderSeq: 20, caseId: "case-a", startedAt: "2026-01-01T00:00:01Z",
      },
    ],
  });
  assert.deepEqual(items.map((item) => item.kind === "tool" ? item.activity.tool : item.lines.join(" | ")), [
    "Before retrieval",
    "cadir_retrieve",
    "Inspecting retrieved summaries",
    "cadir_case_read",
    "Completing code generation stage",
  ]);
});

test("parallel tools keep event order at the same text offset", () => {
  const items = stageTimelineItems({
    output: "Before\nAfter",
    toolActivities: [
      { id: "second", tool: "cadir_case_read", status: "completed", outputOffset: 7, orderSeq: 12, startedAt: "2026-01-01T00:00:01Z" },
      { id: "first", tool: "cadir_retrieve", status: "completed", outputOffset: 7, orderSeq: 11, startedAt: "2026-01-01T00:00:00Z" },
    ],
  });
  assert.deepEqual(items.map((item) => item.kind === "tool" ? item.activity.id : item.lines.join(" | ")), [
    "Before", "first", "second", "After",
  ]);
});
