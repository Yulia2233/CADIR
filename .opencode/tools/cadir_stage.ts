import { tool } from "@opencode-ai/plugin"
import path from "node:path"

import { postInternal, type ToolContext } from "../lib/cadir"

export default tool({
  description:
    "Complete, retry, fail, or pause the current CADIR stage. The backend validates artifacts, persists the transition, and automatically starts the next stage.",
  args: {
    stage: tool.schema.enum(["requirements", "codegen", "visual", "evolution"]),
    action: tool.schema.enum(["complete", "retry", "fail", "needs_input"]),
    summary: tool.schema.string().max(6000).describe("User-facing progress, error detail, or final artifact path summary"),
    errorCode: tool.schema.string().max(100).optional(),
  },
  async execute(args, context) {
    const typedContext = context as ToolContext
    if (args.stage === "requirements" && args.action === "complete") {
      await postInternal("artifacts", typedContext, {
        path: path.join(typedContext.directory, "requirements.md"),
        kind: "requirements",
        mimeType: "text/markdown",
        validated: true,
      })
    }
    const result = await postInternal("stage-transition", typedContext, {
      stage: args.stage,
      action: args.action,
      summary: args.summary,
      ...(args.errorCode ? { error: { code: args.errorCode, message: args.summary } } : {}),
    })
    return JSON.stringify(result)
  },
})
