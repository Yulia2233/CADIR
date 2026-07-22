import { parseStageStream } from "./stageStream.js";

type TimelineToolActivity = {
  id: string;
  tool: "cadir_retrieve" | "cadir_case_read";
  status: "running" | "completed" | "failed";
  outputOffset?: number;
  orderSeq?: number;
  query?: string;
  caseId?: string;
  resultCount?: number;
  summary?: string;
  startedAt: string;
  completedAt?: string;
};

type TimelineStage = {
  output?: string;
  lines?: string[];
  toolActivities?: TimelineToolActivity[];
};

export type StageTimelineItem =
  | { id: string; kind: "text"; lines: string[] }
  | { id: string; kind: "tool"; activity: TimelineToolActivity };

export function stageTimelineItems(stage: TimelineStage): StageTimelineItem[] {
  const output = stage.output ?? "";
  const tools = (stage.toolActivities ?? [])
    .map((activity, index) => ({
      activity,
      index,
      offset: Math.min(output.length, Math.max(0, Number(activity.outputOffset ?? output.length))),
    }))
    .sort((left, right) =>
      left.offset - right.offset
      || Number(left.activity.orderSeq ?? Number.MAX_SAFE_INTEGER) - Number(right.activity.orderSeq ?? Number.MAX_SAFE_INTEGER)
      || left.index - right.index,
    );
  const items: StageTimelineItem[] = [];
  let cursor = 0;

  const appendText = (content: string, id: string): void => {
    const lines = parseStageStream(content);
    if (lines.length) items.push({ id, kind: "text", lines });
  };

  tools.forEach(({ activity, offset }, index) => {
    if (offset > cursor) appendText(output.slice(cursor, offset), `text-${cursor}-${offset}`);
    items.push({ id: `tool-${activity.id}`, kind: "tool", activity });
    cursor = Math.max(cursor, offset);
    if (index === tools.length - 1 && cursor < output.length) {
      appendText(output.slice(cursor), `text-${cursor}-${output.length}`);
      cursor = output.length;
    }
  });

  if (!tools.length) appendText(output, `text-0-${output.length}`);
  const supplemental = parseStageStream((stage.lines ?? []).join("\n"));
  if (supplemental.length) items.push({ id: "supplemental-lines", kind: "text", lines: supplemental });
  return items;
}
