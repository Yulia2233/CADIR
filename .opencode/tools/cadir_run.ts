import { tool } from "@opencode-ai/plugin"

import { callRuntime, postInternal, type ToolContext } from "../lib/cadir"

export default tool({
  description:
    "Validate and execute model.py with the controlled SimpleCADAPI runner. Produces a canonical model JSON, CAD files, and four approved render_screenshot_rpath views.",
  args: {},
  async execute(_args, context) {
    const typedContext = context as ToolContext
    try {
      const result = await callRuntime("run", typedContext)
      const runDir = String(result.runDir)
      await postInternal("artifacts", typedContext, {
        path: `${runDir}/model.py`, kind: "python", mimeType: "text/x-python", validated: true,
      })
      await postInternal("artifacts", typedContext, {
        path: `${runDir}/model.json`, kind: "other", mimeType: "application/json", validated: true,
      })
      return JSON.stringify(result)
    } catch (error) {
      throw error
    }
  },
})
