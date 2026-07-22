import assert from "node:assert/strict";
import test from "node:test";
import { groupStageRuns } from "../../../src/stageGroups.js";

test("consecutive codegen retries share one group but post-visual codegen starts a new group", () => {
  const groups = groupStageRuns([
    { id: "requirements", stage: "requirements" },
    { id: "codegen-1", stage: "codegen" },
    { id: "codegen-2", stage: "codegen" },
    { id: "codegen-3", stage: "codegen" },
    { id: "visual-1", stage: "visual" },
    { id: "codegen-4", stage: "codegen" },
    { id: "codegen-5", stage: "codegen" },
    { id: "visual-2", stage: "visual" },
    { id: "evolution", stage: "evolution" },
  ]);

  assert.deepEqual(groups.map((group) => ({ stage: group.stage, ids: group.runs.map((run) => run.id) })), [
    { stage: "requirements", ids: ["requirements"] },
    { stage: "codegen", ids: ["codegen-1", "codegen-2", "codegen-3"] },
    { stage: "visual", ids: ["visual-1"] },
    { stage: "codegen", ids: ["codegen-4", "codegen-5"] },
    { stage: "visual", ids: ["visual-2"] },
    { stage: "evolution", ids: ["evolution"] },
  ]);
});
