import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JobEvent } from "../../../packages/contracts/src/index.js";
import { emptyDatabase, type DatabaseState } from "./types.js";

export type EventListener = (event: JobEvent) => void;

export class JsonStore {
  private state: DatabaseState = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();
  private readonly emitter = new EventEmitter();

  constructor(private readonly filename?: string) {
    this.emitter.setMaxListeners(0);
  }

  async init(): Promise<void> {
    if (!this.filename) return;
    try {
      this.state = { ...emptyDatabase(), ...JSON.parse(await readFile(this.filename, "utf8")) } as DatabaseState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist(this.state);
    }
  }

  read<T>(fn: (state: Readonly<DatabaseState>) => T): T {
    return fn(this.state);
  }

  async transaction<T>(fn: (state: DatabaseState) => T | Promise<T>): Promise<T> {
    let result!: T;
    let failure: unknown;
    this.queue = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      try {
        result = await fn(draft);
        await this.persist(draft);
        this.state = draft;
      } catch (error) {
        failure = error;
      }
    });
    await this.queue;
    if (failure) throw failure;
    return result;
  }

  publish(events: JobEvent[]): void {
    for (const event of events) this.emitter.emit(`job:${event.jobId}`, event);
  }

  subscribe(jobId: string, listener: EventListener): () => void {
    const key = `job:${jobId}`;
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }

  private async persist(state: DatabaseState): Promise<void> {
    if (!this.filename) return;
    await mkdir(dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
    await rename(temporary, this.filename);
  }
}
