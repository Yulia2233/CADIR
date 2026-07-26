import { tool } from "@opencode-ai/plugin"

import { postInternal, type ToolContext } from "../lib/cadir"

export default tool({
  description:
    "Retrieve CAD Cases using the user's configured full-model, subgraph, or summary-text plus subgraph hybrid mode. The backend enforces pool, count, and node-limit settings.",
  args: {
    query: tool.schema.string().min(1).max(4000).describe("Current CAD requirement or modification request"),
    topK: tool.schema.number().int().min(1).max(10).optional(),
    includeImages: tool.schema.boolean().optional().describe("Also retrieve using user-uploaded images from the current revision"),
  },
  async execute(args, context) {
    const result = await postInternal("retrieve", context as ToolContext, {
      query: args.query,
      ...(args.topK ? { topK: args.topK } : {}),
      includeImages: args.includeImages !== false,
    })
    const payload = result as Record<string, unknown>
    const results = Array.isArray(payload.results) ? payload.results as Array<Record<string, unknown>> : []
    return JSON.stringify({
      ok: payload.ok,
      enabled: payload.enabled,
      mode: payload.mode,
      pool: payload.pool,
      returnedCount: payload.returnedCount ?? results.length,
      partial: payload.partial,
      error: payload.error,
      cases: results.map((item) => ({
        caseId: item.caseId,
        matchKind: item.matchKind,
        sources: item.provenance,
        summary: item.summary,
        textScore: item.textScore,
        subgraphScore: item.subgraphScore,
        subgraphMatches: Array.isArray(item.subgraphMatches) ? item.subgraphMatches.slice(0, 3) : undefined,
      })),
    })
  },
})
