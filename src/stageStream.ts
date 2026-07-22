type StageOutput = { output?: string; lines?: string[] };

export function parseStageStream(raw: string): string[] {
  const lines = raw
    .replace(/<\/?thinking>/gi, "\n")
    .replace(/<[^>]+>/g, "\n")
    .replace(/\*{2,}/g, "\n")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*[-#>]\s*/, "").replace(/\*/g, "").trim())
    .filter(Boolean);
  return lines.filter((line, index) => index === 0 || line !== lines[index - 1]);
}

export function stageOutputLines(stage: StageOutput): string[] {
  return parseStageStream([stage.output, ...(stage.lines ?? [])].filter(Boolean).join("\n"));
}
