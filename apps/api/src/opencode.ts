import type { AppConfig } from "./config.js";
import type { ModelEffort, ModelOption } from "../../../packages/contracts/src/index.js";

export interface OpenCodeEvent { type: string; properties?: Record<string, unknown> }
export interface OpenCodeSession { id: string; title?: string }
export interface PromptModel { modelId: string; effort: ModelEffort; providerId?: string }

export interface OpenCodeAdapter {
  health(): Promise<boolean>;
  supportsImageInput(modelId?: string): Promise<boolean>;
  availableModels(): Promise<ModelOption[]>;
  createSession(title: string, directory: string): Promise<OpenCodeSession>;
  prompt(sessionId: string, content: string, directory: string, model?: PromptModel): Promise<void>;
  abort(sessionId: string, directory: string): Promise<void>;
  deleteSession(sessionId: string, directory: string): Promise<void>;
  sessionStatus(directory?: string): Promise<Record<string, unknown>>;
  messages(sessionId: string, directory: string): Promise<unknown[]>;
  events(signal: AbortSignal): AsyncIterable<OpenCodeEvent>;
}

export class UnavailableOpenCodeAdapter implements OpenCodeAdapter {
  private failure(): never { throw new Error("OPENCODE_URL is not configured"); }
  async health(): Promise<boolean> { return false; }
  async supportsImageInput(): Promise<boolean> { return false; }
  async availableModels(): Promise<ModelOption[]> { return []; }
  async createSession(): Promise<OpenCodeSession> { return this.failure(); }
  async prompt(): Promise<void> { return this.failure(); }
  async abort(): Promise<void> { return this.failure(); }
  async deleteSession(): Promise<void> { return this.failure(); }
  async sessionStatus(): Promise<Record<string, unknown>> { return {}; }
  async messages(): Promise<unknown[]> { return []; }
  async *events(): AsyncIterable<OpenCodeEvent> { return this.failure(); }
}

export class HttpOpenCodeAdapter implements OpenCodeAdapter {
  private readonly baseUrl: string;
  private readonly authorization?: string;

  constructor(private readonly config: AppConfig) {
    if (!config.openCodeUrl) throw new Error("OPENCODE_URL is required");
    this.baseUrl = config.openCodeUrl.replace(/\/$/, "");
    if (config.openCodePassword) {
      this.authorization = `Basic ${Buffer.from(`${config.openCodeUsername}:${config.openCodePassword}`).toString("base64")}`;
    }
  }

  async health(): Promise<boolean> {
    try { return (await this.request("/global/health")).healthy === true; } catch { return false; }
  }

  async supportsImageInput(modelId = this.config.modelId): Promise<boolean> {
    return (await this.availableModels()).some((item) => item.id === modelId && item.imageInput);
  }

  async availableModels(): Promise<ModelOption[]> {
    try {
      const response = await this.request("/provider") as any;
      const providers = Array.isArray(response) ? response : (response?.all ?? response?.providers ?? []);
      const provider = providers.find((item: any) => item?.id === this.config.modelProvider);
      return Object.values(provider?.models ?? {}).map((item: any) => ({
        id: String(item.id),
        label: String(item.name ?? item.id),
        providerId: this.config.modelProvider,
        imageInput: item.capabilities?.input?.image === true,
        efforts: Object.keys(item.variants ?? {}).filter((value): value is ModelEffort => value === "low" || value === "medium" || value === "high"),
      }));
    } catch {
      return [];
    }
  }

  async createSession(title: string, directory: string): Promise<OpenCodeSession> {
    return await this.request("/session", { method: "POST", body: JSON.stringify({ title }) }, directory) as OpenCodeSession;
  }

  async prompt(sessionId: string, content: string, directory: string, selected?: PromptModel): Promise<void> {
    const model = { providerID: selected?.providerId ?? this.config.modelProvider, modelID: selected?.modelId ?? this.config.modelId };
    await this.request(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({ agent: this.config.openCodeAgent, model, variant: selected?.effort, parts: [{ type: "text", text: content }] }),
    }, directory);
  }

  async abort(sessionId: string, directory: string): Promise<void> {
    await this.request(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST", body: "{}" }, directory);
  }

  async deleteSession(sessionId: string, directory: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: this.headers({ "x-opencode-directory": directory }),
    });
    if (!response.ok && response.status !== 404) throw new Error(`OpenCode session delete failed (${response.status})`);
  }

  async sessionStatus(directory?: string): Promise<Record<string, unknown>> { return await this.request("/session/status", {}, directory) as Record<string, unknown>; }
  async messages(sessionId: string, directory: string): Promise<unknown[]> { return await this.request(`/session/${encodeURIComponent(sessionId)}/message`, {}, directory) as unknown[]; }

  async *events(signal: AbortSignal): AsyncIterable<OpenCodeEvent> {
    const response = await fetch(`${this.baseUrl}/global/event`, { headers: this.headers({ Accept: "text/event-stream" }), signal });
    if (!response.ok || !response.body) throw new Error(`OpenCode event stream failed (${response.status})`);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const json = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (json) {
          const parsed = JSON.parse(json) as any;
          yield (parsed.payload ?? parsed) as OpenCodeEvent;
        }
      }
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { "content-type": "application/json", ...(this.authorization ? { authorization: this.authorization } : {}), ...extra };
  }

  private async request(path: string, init: RequestInit = {}, directory?: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers({ ...(init.headers as Record<string, string>), ...(directory ? { "x-opencode-directory": directory } : {}) }),
    });
    if (!response.ok) throw new Error(`OpenCode request ${path} failed (${response.status})`);
    if (response.status === 204) return undefined;
    return await response.json();
  }
}

export function createOpenCodeAdapter(config: AppConfig): OpenCodeAdapter {
  return config.openCodeUrl ? new HttpOpenCodeAdapter(config) : new UnavailableOpenCodeAdapter();
}
