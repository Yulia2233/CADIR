import { tool } from "@opencode-ai/plugin"

import { callRuntime, postInternal, type ToolContext } from "../lib/cadir"

export default tool({
  description:
    "Return and register one approved SimpleCADAPI render for visual inspection. Then use the built-in read tool on the returned image path.",
  args: {
    view: tool.schema.enum(["isometric", "front", "top", "right"]),
  },
  async execute(args, context) {
    const typedContext = context as ToolContext
    const result = await callRuntime("image", typedContext, ["--view", args.view])
    await postInternal("artifacts", typedContext, {
      path: result.path,
      kind: "image",
      mimeType: "image/png",
      validated: true,
    })
    return `${JSON.stringify(result)}\nInspect this exact file with the read tool before deciding whether the model passes visual feedback.`
  },
})
