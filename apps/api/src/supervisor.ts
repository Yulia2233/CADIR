import type { AppConfig } from "./config.js";
import type { OpenCodeAdapter } from "./opencode.js";
import type { CadirService } from "./service.js";

const wait = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
};

export class OpenCodeEventSupervisor {
  private readonly controller = new AbortController();
  private eventLoop?: Promise<void>;
  private watchdog?: NodeJS.Timeout;
  private ticking = false;

  constructor(private readonly service: CadirService, private readonly adapter: OpenCodeAdapter, private readonly config: AppConfig) {}

  start(): void {
    this.eventLoop = this.runEventLoop();
    void this.tick();
    this.watchdog = setInterval(() => void this.tick(), this.config.heartbeatMs);
    this.watchdog.unref();
  }

  async stop(): Promise<void> {
    this.controller.abort();
    if (this.watchdog) clearInterval(this.watchdog);
    await this.eventLoop;
  }

  private async runEventLoop(): Promise<void> {
    let delay = 1_000;
    while (!this.controller.signal.aborted) {
      try {
        for await (const event of this.adapter.events(this.controller.signal)) {
          await this.service.ingestOpenCodeEvent(event);
          delay = 1_000;
        }
      } catch {
        if (this.controller.signal.aborted) break;
        await wait(delay, this.controller.signal);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.service.heartbeatActive();
      const active = this.service.activeJobs().filter((job) => job.status === "running");
      const usageJobs = this.service.usageReconciliationJobs();
      if (!active.length && !usageJobs.length) return;
      const healthy = await this.adapter.health();
      const cutoff = Date.now() - this.config.watchdogMs;
      if (!healthy) {
        for (const job of active) {
          const lastContact = Date.parse(job.lastOpenCodeEventAt ?? job.updatedAt ?? job.startedAt ?? job.createdAt);
          if (lastContact < cutoff) await this.service.failJob(job.id, "OPENCODE_SESSION_LOST", "OpenCode is unavailable and the session stopped updating");
        }
        return;
      }

      const messagesByJob = new Map<string, unknown[]>();
      for (const job of usageJobs) {
        if (!job.openCodeSessionId) continue;
        try {
          const messages = await this.adapter.messages(job.openCodeSessionId, job.workspacePath);
          messagesByJob.set(job.id, messages);
          await this.service.reconcileUsage(job.id, messages);
          await this.service.failJobFromMessages(job.id, messages);
        } catch { /* A later event or watchdog pass retries usage reconciliation. */ }
      }

      for (const job of active) {
        const sessionId = job.openCodeSessionId;
        let messages: unknown[] | undefined = messagesByJob.get(job.id);
        if (sessionId && !messages) {
          try {
            messages = await this.adapter.messages(sessionId, job.workspacePath);
            messagesByJob.set(job.id, messages);
          } catch { /* The watchdog below handles an unreadable or missing session. */ }
        }
        if (messages && await this.service.failJobFromMessages(job.id, messages)) continue;
        let statuses: Record<string, unknown> = {};
        try { statuses = await this.adapter.sessionStatus(job.workspacePath); } catch { /* Health can change between requests. */ }
        const rawStatus = sessionId ? statuses[sessionId] : undefined;
        const status = this.statusName(rawStatus);
        if (status === "busy" || status === "retry") continue;
        if (status === "error" || status === "failed") {
          await this.service.failJob(job.id, "OPENCODE_ERROR", "OpenCode reported a failed session state");
          continue;
        }

        const lastContact = Date.parse(job.lastOpenCodeEventAt ?? job.updatedAt ?? job.startedAt ?? job.createdAt);
        if (lastContact < cutoff) {
          await this.service.failJob(job.id, "OPENCODE_SESSION_LOST", status === "idle"
            ? "OpenCode became idle before the CAD workflow reached a terminal state"
            : "The OpenCode session is missing or no longer active");
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private statusName(value: unknown): string | undefined {
    if (typeof value === "string") return value.toLowerCase();
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    const status = record.type ?? record.status ?? record.state;
    return typeof status === "string" ? status.toLowerCase() : undefined;
  }

}
