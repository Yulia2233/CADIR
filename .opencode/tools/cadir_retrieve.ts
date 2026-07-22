import { tool } from "@opencode-ai/plugin"

import { postInternal, type ToolContext } from "../lib/cadir"

export default tool({
  description:
    "Retrieve unique CAD Cases from the configured full-model and optional 3D-subgraph indexes. The backend enforces the user's retrieval mode and node limit.",
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
    return JSON.stringify(result)
  },
})
