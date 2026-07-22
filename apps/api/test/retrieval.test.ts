import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AppConfig } from "../src/config.js";
import { HttpRetrievalAdapter, type RetrievalQueryOptions } from "../src/retrieval.js";

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, payload: Record<string, unknown>): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

test("HTTP retrieval adapter matches the text, image, index, and Case contracts", async () => {
  const requests: Array<{ method?: string; url?: string; token?: string; contentType?: string; body: Buffer }> = [];
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      token: request.headers["x-internal-token"] as string | undefined,
      contentType: request.headers["content-type"],
      body,
    });
    if (request.url === "/health") return sendJson(response, { status: "ok" });
    if (request.url === "/v1/retrieve/text") return sendJson(response, {
      returnedCount: 1,
      results: [{ caseId: "case-1", score: 0.9 }],
    });
    if (request.url === "/v1/retrieve/image") return sendJson(response, {
      returnedCount: 1,
      results: [{ caseId: "case-2", score: 0.8 }],
    });
    if (request.url === "/v1/index/cases/upload") return sendJson(response, { indexTaskId: "task-1", status: "queued" });
    if (request.url === "/v1/index/tasks/task-1") return sendJson(response, { indexTaskId: "task-1", status: "ready" });
    if (request.url?.startsWith("/v1/cases/case%2F1?")) return sendJson(response, { caseId: "case/1" });
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");

  const config = {
    retrievalUrl: `http://127.0.0.1:${address.port}`,
    retrievalInternalToken: "test-token",
    retrievalTimeoutMs: 2_000,
  } as AppConfig;
  const adapter = new HttpRetrievalAdapter(config);
  const caseDirectory = await mkdtemp(join(tmpdir(), "cadir-retrieval-upload-"));
  const modelPath = join(caseDirectory, "model.json");
  const manifestPath = join(caseDirectory, "manifest.json");
  await writeFile(modelPath, "{}");
  await writeFile(manifestPath, "{}");
  try {
    assert.equal(await adapter.health(), true);
    const options: RetrievalQueryOptions = { scope: "full_and_subgraph", sources: ["base", "dynamic"], topK: 5, subgraphMaxNodes: 16, excludeCaseIds: ["current"] };
    assert.equal((await adapter.retrieveText("flange", options)).results[0].caseId, "case-1");
    assert.equal((await adapter.retrieveImage({
      bytes: Uint8Array.from([137, 80, 78, 71]), filename: "query.png", mimeType: "image/png",
    }, options)).results[0].caseId, "case-2");
    const task = await adapter.indexCase({
      caseId: "case-1", revision: 1, modelHash: "abc", modelJsonPath: "case-1/model.json", manifestPath: "case-1/manifest.json", replace: true,
      files: [
        { name: "model.json", path: modelPath, mimeType: "application/json" },
        { name: "manifest.json", path: manifestPath, mimeType: "application/json" },
      ],
    });
    assert.equal(task.taskId, "task-1");
    assert.equal((await adapter.indexTask(task.taskId)).status, "ready");
    assert.equal((await adapter.readCase("case/1", { subgraphId: "sub-1", include: ["summary", "model.py"] })).caseId, "case/1");
  } finally {
    server.close();
    await once(server, "close");
    await rm(caseDirectory, { recursive: true, force: true });
  }

  assert.equal(requests.every((request) => request.token === "test-token"), true);
  const textRequest = requests.find((request) => request.url === "/v1/retrieve/text");
  assert.deepEqual(JSON.parse(textRequest!.body.toString("utf8")), {
    query: "flange", scope: "full_and_subgraph", sources: ["base", "dynamic"], topK: 5, subgraphMaxNodes: 16, excludeCaseIds: ["current"],
  });
  const imageRequest = requests.find((request) => request.url === "/v1/retrieve/image");
  assert.match(imageRequest!.contentType ?? "", /^multipart\/form-data; boundary=/);
  assert.match(imageRequest!.body.toString("latin1"), /name="image"; filename="query.png"/);
  assert.match(imageRequest!.body.toString("latin1"), /name="options"/);
  const indexRequest = requests.find((request) => request.url === "/v1/index/cases/upload");
  assert.match(indexRequest!.contentType ?? "", /^multipart\/form-data; boundary=/);
  assert.match(indexRequest!.body.toString("latin1"), /name="metadata"/);
  assert.match(indexRequest!.body.toString("latin1"), /name="files"; filename="model.json"/);
  assert.equal(requests.some((request) => request.url === "/v1/cases/case%2F1?subgraphId=sub-1&include=summary%2Cmodel.py"), true);
});
