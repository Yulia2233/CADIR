import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelOption } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { OpenCodeAdapter, OpenCodeEvent, OpenCodeSession } from "../src/opencode.js";
import { JsonStore } from "../src/store.js";

class ApiFakeAdapter implements OpenCodeAdapter {
  async health(): Promise<boolean> { return true; }
  async supportsImageInput(): Promise<boolean> { return true; }
  async availableModels(): Promise<ModelOption[]> { return [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", providerId: "cadir", imageInput: true, efforts: ["low", "medium", "high"] }]; }
  async createSession(): Promise<OpenCodeSession> { return { id: "api-session" }; }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
  async deleteSession(): Promise<void> {}
  async sessionStatus(): Promise<Record<string, unknown>> { return {}; }
  async messages(): Promise<unknown[]> { return []; }
  async *events(): AsyncIterable<OpenCodeEvent> { await new Promise(() => undefined); }
}

test("HTTP flow exposes session list and a complete job snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "cadir-http-"));
  const config: AppConfig = {
    host: "127.0.0.1", port: 0, dataFile: join(root, "db.json"), jobsRoot: join(root, "jobs"), ragLibraryRoot: join(root, "rag-library"), corsOrigin: "*",
    heartbeatMs: 50, watchdogMs: 1_000, openCodeUrl: "http://fake", openCodeUsername: "opencode",
    openCodeAgent: "cadir-agent", modelProvider: "cadir", modelId: "gpt-5.6-sol",
  };
  const app = await buildApp({ config, adapter: new ApiFakeAdapter(), store: new JsonStore() });
  const created = await app.inject({ method: "POST", url: "/api/conversations", payload: {} });
  assert.equal(created.statusCode, 201);
  const conversationId = created.json().id;
  const sent = await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`, payload: { content: "Create a tray" } });
  assert.equal(sent.statusCode, 202);
  const { jobId } = sent.json();
  const snapshot = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.json().job.status, "running");
  assert.equal(snapshot.json().lastSeq, 2);
  const sessions = await app.inject({ method: "GET", url: "/api/conversations" });
  assert.equal(sessions.json().conversations[0].latestJobId, jobId);
  const settings = await app.inject({ method: "GET", url: "/api/settings" });
  assert.equal(settings.statusCode, 200);
  assert.equal(settings.json().settings.modelId, "gpt-5.6-sol");
  const updatedSettings = await app.inject({ method: "PATCH", url: "/api/settings", payload: { modelId: "gpt-5.6-sol", effort: "high" } });
  assert.equal(updatedSettings.statusCode, 200);
  assert.equal(updatedSettings.json().settings.effort, "high");
  await app.close();
});

test("unknown jobs return a stable structured error", async () => {
  const root = await mkdtemp(join(tmpdir(), "cadir-http-"));
  const config: AppConfig = {
    host: "127.0.0.1", port: 0, dataFile: join(root, "db.json"), jobsRoot: join(root, "jobs"), ragLibraryRoot: join(root, "rag-library"), corsOrigin: "*",
    heartbeatMs: 50, watchdogMs: 1_000, openCodeUsername: "opencode", openCodeAgent: "cadir-agent",
    modelProvider: "cadir", modelId: "gpt-5.6-sol",
  };
  const app = await buildApp({ config, adapter: new ApiFakeAdapter(), store: new JsonStore() });
  const response = await app.inject({ method: "GET", url: "/api/jobs/missing" });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "NOT_FOUND");
  await app.close();
});

test("conversation deletion is exposed as an idempotent HTTP operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "cadir-delete-http-"));
  const config: AppConfig = {
    host: "127.0.0.1", port: 0, dataFile: join(root, "db.json"), jobsRoot: join(root, "jobs"), ragLibraryRoot: join(root, "rag-library"), corsOrigin: "*",
    heartbeatMs: 50, watchdogMs: 1_000, openCodeUsername: "opencode", openCodeAgent: "cadir-agent",
    modelProvider: "cadir", modelId: "gpt-5.6-sol",
  };
  const app = await buildApp({ config, adapter: new ApiFakeAdapter(), store: new JsonStore() });
  const created = await app.inject({ method: "POST", url: "/api/conversations", payload: { title: "Delete me" } });
  const id = created.json().id;
  const first = await app.inject({ method: "DELETE", url: `/api/conversations/${id}` });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().deleted, true);
  const second = await app.inject({ method: "DELETE", url: `/api/conversations/${id}` });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().alreadyDeleted, true);
  await app.close();
});

test("SSE honors Last-Event-ID and continues with live terminal events", async () => {
  const root = await mkdtemp(join(tmpdir(), "cadir-sse-"));
  const config: AppConfig = {
    host: "127.0.0.1", port: 0, dataFile: join(root, "db.json"), jobsRoot: join(root, "jobs"), ragLibraryRoot: join(root, "rag-library"), corsOrigin: "*",
    heartbeatMs: 5_000, watchdogMs: 10_000, openCodeUrl: "http://fake", openCodeUsername: "opencode",
    openCodeAgent: "cadir-agent", modelProvider: "cadir", modelId: "gpt-5.6-sol",
  };
  const app = await buildApp({ config, adapter: new ApiFakeAdapter(), store: new JsonStore() });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const conversation = await app.cadirService.createConversation();
  const snapshot = await app.cadirService.submitMessage(conversation.id, { content: "Create a pin" });
  const controller = new AbortController();
  const response = await fetch(`${address}/api/jobs/${snapshot.job.id}/events`, {
    headers: { "Last-Event-ID": "1" }, signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  const deadline = Date.now() + 2_000;
  while (!received.includes("id: 2") && Date.now() < deadline) received += decoder.decode((await reader.read()).value);
  assert.match(received, /id: 2/);
  assert.doesNotMatch(received, /id: 1\n/);
  await app.cadirService.cancel(snapshot.job.id);
  while (!received.includes("id: 3") && Date.now() < deadline) received += decoder.decode((await reader.read()).value);
  assert.match(received, /id: 3/);
  assert.match(received, /event: job.cancelled/);
  controller.abort();
  await app.close();
});
