type StageRunLike = { id: string; stage: string; revision?: number };

export type StageGroup<T extends StageRunLike> = {
  id: string;
  stage: T["stage"];
  revision?: number;
  runs: T[];
};

export function groupStageRuns<T extends StageRunLike>(runs: T[]): StageGroup<T>[] {
  const groups: StageGroup<T>[] = [];
  for (const run of runs) {
    const previous = groups.at(-1);
    if (run.stage === "codegen" && previous?.stage === "codegen" && (run.revision ?? 1) === (previous.revision ?? 1)) {
      previous.runs.push(run);
      continue;
    }
    groups.push({ id: run.id, stage: run.stage, revision: run.revision, runs: [run] });
  }
  return groups;
}
