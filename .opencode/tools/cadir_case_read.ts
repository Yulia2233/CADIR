import { tool } from "@opencode-ai/plugin"

import { postInternal, type ToolContext } from "../lib/cadir"

export default tool({
  description:
    "Read one CAD Case or matched 3D subgraph that cadir_retrieve returned for the current revision. Arbitrary Case IDs and filesystem paths are rejected.",
  args: {
    caseId: tool.schema.string().min(1).max(200),
    subgraphId: tool.schema.string().min(1).max(300).optional(),
    include: tool.schema.array(tool.schema.enum(["summary", "experience", "model.py", "model.json", "subgraph", "renders", "artifacts"])).max(7).optional(),
  },
  async execute(args, context) {
    const result = await postInternal("retrieved-case", context as ToolContext, {
      caseId: args.caseId,
      ...(args.subgraphId ? { subgraphId: args.subgraphId } : {}),
      ...(args.include?.length ? { include: args.include } : {}),
    })
    return JSON.stringify(result)
  },
})
