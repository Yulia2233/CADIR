import { tool } from "@opencode-ai/plugin"
import path from "node:path"

import { callRuntime, postInternal, type ToolContext } from "../lib/cadir"

export default tool({
  description:
    "Publish the latest complete CAD revision after visual feedback. Registers the current artifact manifest so the backend can replace the previous successful archive.",
  args: {},
  async execute(_args, context) {
    const typedContext = context as ToolContext
    const knowledgeRegistrations = []
    for (const [name, kind] of [
      ["summary.md", "summary"],
      ["experience.md", "experience"],
    ] as const) {
      knowledgeRegistrations.push(await postInternal("artifacts", typedContext, {
        path: path.join(typedContext.directory, name), kind, mimeType: "text/markdown", validated: true,
      }))
    }
    const manifest = await callRuntime("publish", typedContext)
    const artifacts = manifest.artifacts as Record<string, unknown>
    const registrations = []
    for (const [key, kind, mimeType] of [
      ["step", "step", "model/step"],
      ["stl", "stl", "model/stl"],
      ["freecad", "freecad", "application/octet-stream"],
    ] as const) {
      registrations.push(await postInternal("artifacts", typedContext, {
        path: artifacts[key], kind, mimeType, validated: true,
      }))
    }
    registrations.push(await postInternal("artifacts", typedContext, {
      path: manifest.manifest, kind: "other", mimeType: "application/json", validated: true,
    }))
    return JSON.stringify({ manifest, registrations: [...knowledgeRegistrations, ...registrations] })
  },
})
