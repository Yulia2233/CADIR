import { tool } from "@opencode-ai/plugin"

import { callRuntime, type ToolContext } from "../lib/cadir"

export default tool({
  description:
    "Run a short, non-publishing Python probe for SimpleCADAPI or math API debugging. Only simplecadapi/math imports are allowed; file, process, network, and dunder access are blocked. Output is capped and execution times out after 10 seconds.",
  args: {
    code: tool.schema.string().min(1).max(12000).describe(
      "Focused Python diagnostic code. Print only the API facts needed to repair model.py; do not build or export the complete model.",
    ),
  },
  async execute(args, context) {
    const result = await callRuntime("probe", context as ToolContext, ["--timeout", "10"], args.code)
    return JSON.stringify(result)
  },
})
