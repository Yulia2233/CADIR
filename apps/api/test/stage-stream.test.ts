import assert from "node:assert/strict";
import test from "node:test";
import { parseStageStream } from "../../../src/stageStream.js";

test("assistant planning markers become clean one-line stage entries", () => {
  const raw = "**Correcting skill reading method****Inspecting documentation lists****Finalizing gear arrangement and assembly approach****Planning static display with backing plate**<thinking>**Checking geometry**</thinking>";
  const lines = parseStageStream(raw);
  assert.deepEqual(lines, [
    "Correcting skill reading method",
    "Inspecting documentation lists",
    "Finalizing gear arrangement and assembly approach",
    "Planning static display with backing plate",
    "Checking geometry",
  ]);
  assert.equal(lines.every((line) => !line.includes("*") && !line.includes("thinking")), true);
});
