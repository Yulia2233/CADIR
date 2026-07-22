export type ToolContext = {
  sessionID: string
  messageID: string
  directory: string
  worktree: string
  agent: string
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required on the OpenCode server`)
  return value
}

export async function callRuntime(
  command: "run" | "publish" | "image" | "probe",
  context: ToolContext,
  extra: string[] = [],
  input?: string,
): Promise<Record<string, unknown>> {
  const python = process.env.CADIR_PYTHON ?? "python3"
  const runner = process.env.CADIR_RUNNER_PATH ?? "/app/cad-runtime/cadir_runner.py"
  const proc = Bun.spawn(
    [python, runner, command, "--job-dir", context.directory, ...extra],
    {
      cwd: context.directory,
      env: process.env,
      stdin: input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (input !== undefined) {
    proc.stdin.write(input)
    proc.stdin.end()
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    let message = stderr.trim() || stdout.trim() || `CAD runtime exited ${exitCode}`
    try {
      const parsed = JSON.parse(message) as { error?: string }
      message = parsed.error ?? message
    } catch {
      // Preserve plain runtime diagnostics.
    }
    throw new Error(message.slice(-6000))
  }
  return JSON.parse(stdout) as Record<string, unknown>
}

export async function postInternal(
  path: string,
  context: ToolContext,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const base = requireEnv("CADIR_API_INTERNAL_URL").replace(/\/$/, "")
  const token = requireEnv("INTERNAL_API_TOKEN")
  const response = await fetch(`${base}/${path.replace(/^\//, "")}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": token,
    },
    body: JSON.stringify({
      sessionID: context.sessionID,
      messageId: context.messageID,
      ...payload,
    }),
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`CADIR API rejected ${path} (${response.status}): ${body.slice(0, 2000)}`)
  }
  return body ? (JSON.parse(body) as Record<string, unknown>) : { ok: true }
}
