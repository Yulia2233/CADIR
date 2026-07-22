import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileBox,
  Image,
  LoaderCircle,
  MessageSquarePlus,
  Paperclip,
  RefreshCw,
  Send,
  Settings2,
  Square,
  Trash2,
  User,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import StlViewer from "./StlViewer";
import { groupStageRuns } from "./stageGroups";
import { stageOutputLines } from "./stageStream";
import {
  api,
  type Artifact,
  type ChatMessage,
  type ConnectionStatus,
  type ConversationDetail,
  type ConversationSummary,
  isTerminal,
  type JobSnapshot,
  JobStreamController,
  type ModelEffort,
  type ModelSettings,
  type ModelSettingsResponse,
  type StageKey,
  type StageRun,
  type StreamEvent,
} from "./api";

type PendingImage = {
  localId: string;
  name: string;
  previewUrl: string;
  status: "uploading" | "uploaded" | "failed";
  artifactId?: string;
  error?: string;
};

const acceptedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const maxImageBytes = 10 * 1024 * 1024;

const stageNames: Record<StageKey, string> = {
  requirements: "需求分析",
  codegen: "代码生成",
  visual: "视觉反馈",
  evolution: "自进化",
};

function normalizeSnapshot(snapshot: JobSnapshot): JobSnapshot {
  const emptyUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    ...snapshot,
    job: { ...snapshot.job, revision: snapshot.job.revision ?? 1 },
    lastSeq: Number(snapshot.lastSeq ?? 0),
    stageRuns: Array.isArray(snapshot.stageRuns) ? snapshot.stageRuns.map((stage) => ({ ...stage, revision: stage.revision ?? 1, usage: stage.usage ?? { ...emptyUsage } })) : [],
    messages: Array.isArray(snapshot.messages) ? snapshot.messages.map((message) => ({ ...message, imageArtifactIds: message.imageArtifactIds ?? [] })) : [],
    artifacts: Array.isArray(snapshot.artifacts) ? snapshot.artifacts.map((artifact) => ({ ...artifact, revision: artifact.revision ?? 1 })) : [],
    usage: snapshot.usage ?? emptyUsage,
  };
}

function dataRecord(event: StreamEvent) {
  return (event.data && typeof event.data === "object" ? event.data : {}) as Record<string, unknown>;
}

function reduceStreamEvent(current: JobSnapshot | null, event: StreamEvent): JobSnapshot | null {
  if (!current) return current;
  const data = dataRecord(event);
  const next: JobSnapshot = {
    ...current,
    lastSeq: Math.max(current.lastSeq, Number(event.seq ?? current.lastSeq)),
    job: { ...current.job },
    stageRuns: [...current.stageRuns],
    messages: [...current.messages],
    usage: { ...current.usage },
    artifacts: [...current.artifacts],
  };

  if (event.type === "stage.updated") {
    const candidate = (data.stageRun && typeof data.stageRun === "object" ? data.stageRun : data) as Partial<StageRun>;
    const key = candidate.stage;
    if (key) {
      const proposedId = candidate.id ?? String(data.stageRunId ?? `${key}-${candidate.attempt ?? 1}`);
      const candidateRevision = Number(candidate.revision ?? data.revision ?? next.job.revision ?? 1);
      const index = next.stageRuns.findIndex((stage) => stage.id === proposedId || (
        stage.stage === key && stage.attempt === (candidate.attempt ?? stage.attempt) && (stage.revision ?? 1) === candidateRevision
      ));
      const id = index >= 0 ? next.stageRuns[index].id : proposedId;
      const merged = {
        ...(index >= 0 ? next.stageRuns[index] : { id, jobId: next.job.id, stage: key, status: "running", attempt: candidate.attempt ?? 1, usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
        ...candidate,
        id,
        stage: key,
        revision: candidateRevision,
      } as StageRun;
      if (index >= 0) next.stageRuns[index] = merged;
      else next.stageRuns.push(merged);
      next.job.currentStage = key;
    }
  }

  if (event.type === "message.started" || event.type === "message.delta" || event.type === "message.completed") {
    const nested = (data.message && typeof data.message === "object" ? data.message : {}) as Partial<ChatMessage>;
    const id = String(nested.id ?? data.messageId ?? data.id ?? `assistant-${event.eventId ?? event.seq}`);
    const index = next.messages.findIndex((message) => message.id === id);
    const delta = String(data.delta ?? data.text ?? (event.type === "message.delta" ? data.content ?? "" : ""));
    const base: ChatMessage = index >= 0
      ? next.messages[index]
      : { id, conversationId: current.job.conversationId ?? "", jobId: current.job.id, role: nested.role ?? "assistant", content: nested.content ?? "", imageArtifactIds: [], status: "streaming" };
    const message: ChatMessage = {
      ...base,
      ...nested,
      id,
      content: event.type === "message.delta" ? `${base.content}${delta}` : (nested.content ?? base.content),
      status: event.type === "message.completed" ? "completed" : "streaming",
    };
    if (index >= 0) next.messages[index] = message;
    else next.messages.push(message);

    const stageKey = (data.stage ?? next.job.currentStage) as StageKey | undefined;
    if (event.type === "message.delta" && stageKey && delta) {
      const stageIndex = [...next.stageRuns].reverse().findIndex((stage) => stage.stage === stageKey && (stage.revision ?? 1) === (next.job.revision ?? 1));
      if (stageIndex >= 0) {
        const actualIndex = next.stageRuns.length - 1 - stageIndex;
        const stage = next.stageRuns[actualIndex];
        next.stageRuns[actualIndex] = { ...stage, output: `${stage.output ?? ""}${delta}` };
      }
    }
  }

  if (event.type === "tool.updated") {
    const stageKey = (data.stage ?? next.job.currentStage) as StageKey | undefined;
    const text = String(data.summary ?? data.message ?? data.output ?? "");
    const toolError = data.error && typeof data.error === "object" ? data.error as StageRun["toolError"] : undefined;
    if (stageKey && (text || toolError || data.clearToolError === true)) {
      const index = [...next.stageRuns].reverse().findIndex((stage) => stage.stage === stageKey && (stage.revision ?? 1) === (next.job.revision ?? 1));
      if (index >= 0) {
        const actualIndex = next.stageRuns.length - 1 - index;
        const stage = next.stageRuns[actualIndex];
        next.stageRuns[actualIndex] = {
          ...stage,
          lines: text ? [...(stage.lines ?? []), text] : stage.lines,
          toolError: data.clearToolError === true ? undefined : (toolError ?? stage.toolError),
        };
      }
    }
  }

  if (event.type === "usage.updated") {
    const usage = (data.usage && typeof data.usage === "object" ? data.usage : data) as JobSnapshot["usage"];
    const stageRunId = String(data.stageRunId ?? "");
    const index = next.stageRuns.findIndex((stage) => stage.id === stageRunId);
    if (index >= 0) next.stageRuns[index] = { ...next.stageRuns[index], usage: { ...next.stageRuns[index].usage, ...usage } };
    next.usage = next.stageRuns.reduce((sum, stage) => ({
      input: sum.input + (stage.usage?.input ?? 0), output: sum.output + (stage.usage?.output ?? 0),
      reasoning: sum.reasoning + (stage.usage?.reasoning ?? 0), cacheRead: sum.cacheRead + (stage.usage?.cacheRead ?? 0),
      cacheWrite: sum.cacheWrite + (stage.usage?.cacheWrite ?? 0), total: sum.total + (stage.usage?.total ?? 0),
    }), { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  }

  if (event.type === "artifact.created" || event.type === "image.read") {
    const artifact = ((data.artifact && typeof data.artifact === "object" ? data.artifact : data) as unknown) as Artifact;
    if (artifact.id) {
      const index = next.artifacts.findIndex((item) => item.id === artifact.id);
      if (index >= 0) next.artifacts[index] = { ...next.artifacts[index], ...artifact };
      else next.artifacts.push(artifact);
    }
  }

  if (event.type === "job.started") {
    next.job.status = "running";
    if (typeof data.revision === "number") next.job.revision = data.revision;
  }
  if (event.type === "job.needs_input") next.job.status = "waiting_input";
  if (event.type === "job.needs_input" && typeof data.summary === "string") next.job.summary = data.summary;
  if (event.type === "job.completed") {
    next.job.status = "completed";
    if (typeof data.summary === "string") next.job.summary = data.summary;
  }
  if (event.type === "job.cancelled") next.job.status = "cancelled";
  if (event.type === "job.failed") {
    next.job.status = "failed";
    const error = (data.error && typeof data.error === "object" ? data.error : data) as NonNullable<JobSnapshot["job"]["error"]>;
    next.job.error = { ...error, code: error.code ?? "OPENCODE_ERROR", message: error.message ?? "任务执行失败" };
  }
  if (typeof data.revision === "number") next.job.revision = data.revision;
  next.job.updatedAt = event.timestamp ?? next.job.updatedAt;
  return next;
}

function conversationFromResponse(response: ConversationSummary | ConversationDetail) {
  return "conversation" in response ? response.conversation : response;
}

function jobIdFromConversation(conversation?: ConversationSummary | ConversationDetail | null) {
  if (!conversation) return null;
  if ("conversation" in conversation) {
    return conversation.snapshot?.job.id ?? conversation.conversation.latestJobId ?? null;
  }
  return conversation.latestJobId ?? null;
}

function formatRelativeTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const delta = Date.now() - date.getTime();
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function formatElapsed(stage: StageRun) {
  const ms = (
    stage.startedAt && stage.completedAt
      ? new Date(stage.completedAt).getTime() - new Date(stage.startedAt).getTime()
      : undefined
  );
  if (ms === undefined || Number.isNaN(ms)) return "--";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.floor(ms % 60_000 / 1000)}s`;
}

function stageStatusLabel(status: StageRun["status"]) {
  if (status === "completed") return "已完成";
  if (status === "skipped") return "无需修正";
  if (status === "failed") return "执行失败";
  if (status === "cancelled") return "已取消";
  if (status === "waiting_input") return "等待补充信息";
  return "正在进行";
}

function stageStatusIcon(status: StageRun["status"]) {
  if (status === "completed" || status === "skipped") return <Check size={15} />;
  if (status === "running") return <LoaderCircle className="spin" size={15} />;
  if (status === "failed" || status === "cancelled") return <CircleAlert size={15} />;
  if (status === "waiting_input") return <Clock3 size={15} />;
  return <span className="pending-dot" />;
}

function SessionStatus({ status }: { status?: ConversationSummary["latestJobStatus"] }) {
  if (status === "running" || status === "queued") return <LoaderCircle className="spin session-state running" size={14} />;
  if (status === "completed") return <Check className="session-state completed" size={14} />;
  if (status === "failed" || status === "cancelled") return <CircleAlert className="session-state failed" size={14} />;
  return <span className="session-state waiting" />;
}

function ConnectionBadge({ status, message, jobStatus }: { status: ConnectionStatus; message?: string; jobStatus?: JobSnapshot["job"]["status"] }) {
  if (jobStatus === "completed") return <span className="connection-badge completed"><Check size={12} /> 已完成</span>;
  if (jobStatus === "failed") return <span className="connection-badge error"><CircleAlert size={12} /> 任务失败</span>;
  if (jobStatus === "cancelled") return <span className="connection-badge error"><CircleAlert size={12} /> 已取消</span>;
  if (status === "connected") return <span className="connection-badge connected"><Wifi size={12} /> 已同步</span>;
  if (status === "syncing") return <span className="connection-badge syncing"><RefreshCw className="spin" size={12} /> 正在同步</span>;
  if (status === "offline") return <span className="connection-badge error" title={message}><WifiOff size={12} /> 网络已断开</span>;
  if (status === "stale" || status === "error") return <span className="connection-badge error" title={message}><WifiOff size={12} /> 连接异常</span>;
  return <span className="connection-badge idle">未连接任务</span>;
}

function artifactIsImage(artifact: Artifact) {
  const format = (artifact.format ?? artifact.kind ?? artifact.type ?? "").toLowerCase();
  return artifact.mimeType?.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "image", "preview"].includes(format);
}

function ErrorDetails({ error }: { error?: StageRun["error"] | JobSnapshot["job"]["error"] }) {
  if (!error) return null;
  return (
    <div className="error-details">
      <span>错误代码：{error.code ?? "UNKNOWN_ERROR"}</span>
      {error.detail && <details><summary>技术详情</summary><code>{error.detail}</code></details>}
    </div>
  );
}

function artifactIsStl(artifact: Artifact) {
  const format = `${artifact.format ?? ""} ${artifact.kind ?? ""} ${artifact.type ?? ""} ${artifact.name ?? ""}`.toLowerCase();
  return format.includes("stl");
}

function latestOutputArtifacts(artifacts: Artifact[], revision?: number) {
  const outputs = /^(requirements\.md|model\.(py|json|step|stl|fcstd)|manifest\.json|render-(isometric|front|top|right)\.png)$/i;
  const latest = new Map<string, Artifact>();
  [...artifacts]
    .filter((artifact) => artifact.validated === true && artifact.partial !== true && (artifact.revision ?? 1) === (revision ?? 1) && outputs.test(artifact.name))
    .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")))
    .forEach((artifact) => latest.set(artifact.name.toLowerCase(), artifact));
  return [...latest.values()];
}

const artifactDescriptions: Record<string, string> = {
  "requirements.md": "本次模型的需求说明",
  "model.py": "CADIR 可执行建模程序",
  "model.json": "标准化 CAD 模型描述",
  "render-isometric.png": "模型等轴测渲染图",
  "render-front.png": "模型正视图",
  "render-top.png": "模型俯视图",
  "render-right.png": "模型右视图",
  "model.step": "STEP 通用 CAD 交换文件",
  "model.stl": "用于预览和三维打印的网格模型",
  "model.fcstd": "FreeCAD 工程文件",
  "manifest.json": "本次生成产物清单",
};

function artifactDescription(artifact: Artifact) {
  return artifactDescriptions[artifact.name.toLowerCase()] ?? "本次任务生成的模型文件";
}

function completionSummary(summary?: string) {
  const fallback = "建模、几何检查和四视图验证均已完成。";
  const normalized = summary?.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;

  const markers = [
    /发布清单(?:精确)?路径/i,
    /(?:产物|文件)(?:清单)?路径/i,
    /\brequirements\s*=/i,
    /\/workspace\/jobs\//i,
  ];
  const cutoff = markers
    .map((marker) => normalized.search(marker))
    .filter((index) => index >= 0)
    .reduce((earliest, index) => Math.min(earliest, index), normalized.length);
  const concise = normalized.slice(0, cutoff).replace(/[：:;,，；\s]+$/g, "").trim();
  return concise || fallback;
}

export default function App() {
  const [sessions, setSessions] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("idle");
  const [connectionError, setConnectionError] = useState<string>();
  const [listError, setListError] = useState<string>();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [uploadError, setUploadError] = useState<string>();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(null);
  const [deletingId, setDeletingId] = useState<string>();
  const [deleteError, setDeleteError] = useState<string>();
  const [modelSettings, setModelSettings] = useState<ModelSettings | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelSettingsResponse["models"]>([]);
  const [settingsDraft, setSettingsDraft] = useState<ModelSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState<"idle" | "loading" | "saving" | "saved" | "error">("idle");
  const [settingsError, setSettingsError] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingImagesRef = useRef<PendingImage[]>([]);
  const streamControllerRef = useRef<JobStreamController | null>(null);
  const activeSession = sessions.find((session) => session.id === activeId);

  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  }, [pendingImages]);

  useEffect(() => () => {
    for (const image of pendingImagesRef.current) URL.revokeObjectURL(image.previewUrl);
  }, []);

  useEffect(() => {
    if (!deleteTarget) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deletingId) setDeleteTarget(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [deleteTarget, deletingId]);

  const refreshSettings = useCallback(async (showStatus = false) => {
    if (showStatus) setSettingsStatus((current) => current === "saving" ? current : "loading");
    try {
      const response = await api.getSettings();
      setModelSettings(response.settings);
      setModelOptions(response.models);
      setSettingsDraft((current) => current ?? response.settings);
      setSettingsError(undefined);
      if (showStatus) setSettingsStatus("idle");
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "无法读取模型设置");
      if (showStatus) setSettingsStatus("error");
    }
  }, []);

  useEffect(() => {
    void refreshSettings(true);
    const timer = window.setInterval(() => void refreshSettings(), 30_000);
    return () => window.clearInterval(timer);
  }, [refreshSettings]);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && settingsStatus !== "saving") setSettingsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [settingsOpen, settingsStatus]);

  const refreshSessions = useCallback(async (preserveSelection = true) => {
    try {
      const list = await api.listConversations();
      setSessions(list);
      setListError(undefined);
      setActiveId((current) => {
        if (preserveSelection && current && list.some((item) => item.id === current)) return current;
        return list[0]?.id ?? null;
      });
    } catch (error) {
      setListError(error instanceof Error ? error.message : "无法读取 Session 列表");
    }
  }, []);

  useEffect(() => {
    void refreshSessions(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = window.setInterval(() => void refreshSessions(), 15_000);
    return () => window.clearInterval(timer);
  }, [refreshSessions]);

  useEffect(() => {
    setSnapshot(null);
    setActiveJobId(null);
    setConnection("idle");
    setConnectionError(undefined);
    if (!activeId) return;
    let active = true;
    api.getConversation(activeId).then((detail) => {
      if (!active) return;
      setActiveJobId(jobIdFromConversation(detail));
    }).catch((error) => {
      if (!active) return;
      setConnection("error");
      setConnectionError(error instanceof Error ? error.message : "无法读取 Session");
    });
    return () => { active = false; };
  }, [activeId]);

  useEffect(() => {
    if (!activeJobId) return;
    const controller = new JobStreamController({
      jobId: activeJobId,
      onSnapshot: (incoming) => {
        const normalized = normalizeSnapshot(incoming);
        setSnapshot(normalized);
        setExpanded((current) => {
          const next = { ...current };
          for (const group of groupStageRuns(normalized.stageRuns)) {
            const latest = group.runs.at(-1)!;
            if (isTerminal(normalized.job.status)) next[group.id] = false;
            else if (!(group.id in next)) next[group.id] = latest.status === "running" || latest.status === "waiting_input";
          }
          return next;
        });
      },
      onEvent: (event) => setSnapshot((current) => reduceStreamEvent(current, event)),
      onStatus: (status, message) => {
        setConnection(status);
        setConnectionError(message);
      },
      onTerminal: () => void refreshSessions(),
    });
    streamControllerRef.current = controller;
    controller.start();
    return () => {
      if (streamControllerRef.current === controller) streamControllerRef.current = null;
      controller.stop();
    };
  }, [activeJobId, refreshSessions]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 180;
    if (nearBottom) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [snapshot?.lastSeq, snapshot?.job.status]);

  const stageGroups = useMemo(() => groupStageRuns(snapshot?.stageRuns ?? []), [snapshot]);

  const stageStateSignature = snapshot?.stageRuns.map((stage) => `${stage.id}:${stage.status}`).join("|") ?? "";
  useEffect(() => {
    if (!snapshot) return;
    setExpanded((current) => {
      const next = { ...current };
      for (const group of stageGroups) {
        const latest = group.runs.at(-1)!;
        if (isTerminal(snapshot.job.status)) next[group.id] = false;
        else if (latest.status === "running" || latest.status === "waiting_input") next[group.id] = true;
        else next[group.id] = false;
      }
      return next;
    });
  }, [stageStateSignature, snapshot?.job.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const messages = snapshot?.messages ?? [];
  const userMessages = messages.filter((message) => message.role === "user");
  const terminal = isTerminal(snapshot?.job.status);
  const serverRunning = snapshot?.job.status === "running" || snapshot?.job.status === "queued";
  const visiblyRunning = serverRunning && connection === "connected";
  const totalTokens = snapshot?.usage.total ?? 0;
  const inputImageIds = new Set(messages.filter((message) => message.role === "user").flatMap((message) => message.imageArtifactIds ?? []));
  const currentRevision = snapshot?.job.revision ?? 1;
  const finalArtifacts = latestOutputArtifacts(snapshot?.artifacts ?? [], currentRevision);
  const currentArtifacts = (snapshot?.artifacts ?? []).filter((artifact) => (artifact.revision ?? 1) === currentRevision);
  const generatedImages = currentArtifacts.filter((artifact) => artifactIsImage(artifact) && !inputImageIds.has(artifact.id));
  const validatedStl = [...(snapshot?.artifacts ?? [])]
    .filter((artifact) => artifactIsStl(artifact) && artifact.validated === true && artifact.partial !== true)
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
    .at(-1);
  const stlUrl = snapshot && validatedStl ? api.artifactDownloadUrl(snapshot.job.id, validatedStl) : null;

  const createSession = async () => {
    setSending(true);
    try {
      const response = await api.createConversation();
      const conversation = conversationFromResponse(response);
      setSessions((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
      setActiveId(conversation.id);
      setInput("");
      for (const image of pendingImages) URL.revokeObjectURL(image.previewUrl);
      setPendingImages([]);
      setUploadError(undefined);
      setListError(undefined);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "创建 Session 失败");
    } finally {
      setSending(false);
    }
  };

  const ensureConversation = async () => {
    if (activeId) return activeId;
    const response = await api.createConversation();
    const conversation = conversationFromResponse(response);
    setSessions((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
    setActiveId(conversation.id);
    return conversation.id;
  };

  const chooseImages = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploadError(undefined);
    const selected = Array.from(files);
    const accepted: Array<{ file: File; pending: PendingImage }> = [];
    const rejected: string[] = [];

    for (const file of selected) {
      if (!acceptedImageTypes.has(file.type)) {
        rejected.push(`${file.name}：仅支持 PNG、JPEG 或 WebP`);
        continue;
      }
      if (file.size > maxImageBytes) {
        rejected.push(`${file.name}：文件不能超过 10 MiB`);
        continue;
      }
      const localId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      accepted.push({
        file,
        pending: { localId, name: file.name, previewUrl: URL.createObjectURL(file), status: "uploading" },
      });
    }

    if (rejected.length) setUploadError(rejected.join("；"));
    if (!accepted.length) return;
    setPendingImages((current) => [...current, ...accepted.map((item) => item.pending)]);

    let conversationId: string;
    try {
      conversationId = await ensureConversation();
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法创建 Session";
      setPendingImages((current) => current.map((item) => accepted.some(({ pending }) => pending.localId === item.localId) ? { ...item, status: "failed", error: message } : item));
      setUploadError(message);
      return;
    }

    await Promise.all(accepted.map(async ({ file, pending }) => {
      try {
        const result = await api.uploadImage(conversationId, file);
        setPendingImages((current) => current.map((item) => item.localId === pending.localId ? { ...item, status: "uploaded", artifactId: result.artifactId } : item));
      } catch (error) {
        const message = error instanceof Error ? error.message : "图片上传失败";
        setPendingImages((current) => current.map((item) => item.localId === pending.localId ? { ...item, status: "failed", error: message } : item));
        setUploadError(`${file.name}：${message}`);
      }
    }));
  };

  const removePendingImage = (localId: string) => {
    setPendingImages((current) => {
      const removed = current.find((item) => item.localId === localId);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((item) => item.localId !== localId);
    });
    setUploadError(undefined);
  };

  const clearPendingImages = () => {
    for (const image of pendingImagesRef.current) URL.revokeObjectURL(image.previewUrl);
    setPendingImages([]);
    setUploadError(undefined);
  };

  const submit = async () => {
    const content = input.trim();
    if (!content || sending || pendingImages.some((image) => image.status !== "uploaded")) return;
    setSending(true);
    try {
      let conversationId = activeId;
      if (!conversationId) {
        const created = await api.createConversation();
        const conversation = conversationFromResponse(created);
        conversationId = conversation.id;
        setSessions((current) => [conversation, ...current]);
        setActiveId(conversation.id);
      }
      const resumeJobId = snapshot?.job.status === "waiting_input" ? snapshot.job.id : undefined;
      const imageArtifactIds = pendingImages.flatMap((image) => image.status === "uploaded" && image.artifactId ? [image.artifactId] : []);
      const response = await api.sendMessage(conversationId, content, { resumeJobId, imageArtifactIds });
      setInput("");
      clearPendingImages();
      if (response.snapshot) setSnapshot(normalizeSnapshot(response.snapshot));
      if (response.jobId === activeJobId) streamControllerRef.current?.recoverNow();
      else setActiveJobId(response.jobId);
      await refreshSessions();
    } catch (error) {
      setConnection("error");
      setConnectionError(error instanceof Error ? error.message : "消息发送失败");
    } finally {
      setSending(false);
    }
  };

  const cancel = async () => {
    if (!snapshot || !serverRunning) return;
    setSending(true);
    try {
      const result = await api.cancelJob(snapshot.job.id);
      if (result && "job" in result) setSnapshot(normalizeSnapshot(result));
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "取消任务失败");
    } finally {
      setSending(false);
    }
  };

  const retry = async () => {
    if (!snapshot || snapshot.job.status !== "failed") return;
    setSending(true);
    try {
      const retriedSnapshot = await api.retryJob(snapshot.job.id);
      setSnapshot(normalizeSnapshot(retriedSnapshot));
      setActiveJobId(retriedSnapshot.job.id);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "重试任务失败");
    } finally {
      setSending(false);
    }
  };

  const getArtifactUrl = (artifact: Artifact) => snapshot ? api.artifactDownloadUrl(snapshot.job.id, artifact) : "#";
  const uploadsBlocked = pendingImages.some((image) => image.status !== "uploaded");

  const selectSession = (id: string) => {
    if (id !== activeId) clearPendingImages();
    setActiveId(id);
  };

  const openDeleteDialog = (session: ConversationSummary) => {
    setDeleteTarget(session);
    setDeleteError(undefined);
  };

  const openSettings = () => {
    setSettingsDraft(modelSettings);
    setSettingsError(undefined);
    setSettingsStatus("idle");
    setSettingsOpen(true);
  };

  const saveSettings = async () => {
    if (!settingsDraft || settingsStatus === "saving") return;
    setSettingsStatus("saving");
    setSettingsError(undefined);
    try {
      const response = await api.updateSettings(settingsDraft);
      setModelSettings(response.settings);
      setModelOptions(response.models);
      setSettingsDraft(response.settings);
      setSettingsStatus("saved");
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "模型设置保存失败");
      setSettingsStatus("error");
    }
  };

  const deleteSession = async () => {
    if (!deleteTarget || deletingId) return;
    const targetId = deleteTarget.id;
    setDeletingId(targetId);
    setDeleteError(undefined);
    try {
      await api.deleteConversation(targetId);
      const remaining = sessions.filter((session) => session.id !== targetId);
      setSessions(remaining);
      if (activeId === targetId) {
        clearPendingImages();
        setSnapshot(null);
        setActiveJobId(null);
        setConnection("idle");
        setConnectionError(undefined);
        setActiveId(remaining[0]?.id ?? null);
      }
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "删除 Session 失败");
      await refreshSessions();
    } finally {
      setDeletingId(undefined);
    }
  };

  return (
    <main className="app-shell">
      <aside className="sessions-pane">
        <div className="brand-row"><div className="brand-mark"><FileBox size={18} /></div><span>CADIR</span></div>
        <button className="new-session" type="button" onClick={createSession} disabled={sending}>
          <MessageSquarePlus size={17} /> 新建 Session
        </button>
        <nav className="session-list" aria-label="Session 列表">
          <p className="section-label">最近</p>
          {sessions.map((session) => (
            <div className={`session-row ${activeId === session.id ? "selected" : ""}`} key={session.id}>
              <button className="session-item" type="button" onClick={() => selectSession(session.id)} disabled={deletingId === session.id}>
                <span className="session-title-row"><SessionStatus status={session.latestJobStatus} /><strong>{session.title || "未命名 Session"}</strong><time>{formatRelativeTime(session.updatedAt)}</time></span>
                <span className="session-preview">{session.deletionStatus === "deleting" ? "正在删除" : session.deletionStatus === "failed" ? "上次删除失败" : session.preview || "暂无消息"}</span>
              </button>
              <button
                className="session-delete"
                type="button"
                aria-label={`删除 ${session.title || "未命名 Session"}`}
                title="删除 Session"
                disabled={deletingId === session.id}
                onClick={() => openDeleteDialog(session)}
              >
                {deletingId === session.id ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
              </button>
            </div>
          ))}
          {!sessions.length && !listError && <div className="sidebar-empty">暂无 Session</div>}
          {listError && <div className="sidebar-error"><CircleAlert size={14} /> {listError}</div>}
        </nav>
        <button className="account-row" type="button" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={openSettings}>
          <span className="avatar small">U</span>
          <span className="account-copy"><strong>User</strong><small>本地工作区</small></span>
          <Settings2 className="account-settings-icon" size={16} />
        </button>
      </aside>

      <section className="chat-pane">
        <header className="chat-header">
          <div><h1>{activeSession?.title || "新建 CAD 任务"}</h1><ConnectionBadge status={connection} message={connectionError} jobStatus={snapshot?.job.status} /></div>
          {snapshot?.job.status === "failed" && snapshot.job.error?.retryable !== false && <button className="secondary-button" type="button" onClick={retry} disabled={sending}><RefreshCw size={15} /> 重新运行</button>}
        </header>

        <div className="messages" ref={scrollRef}>
          {!activeId && <section className="empty-state"><FileBox size={28} /><h2>开始一个 CAD 任务</h2><p>新建 Session，或直接在下方输入建模需求。</p></section>}
          {activeId && !activeJobId && !connectionError && <section className="empty-state"><MessageSquarePlus size={26} /><h2>这个 Session 还没有任务</h2><p>输入需求后，建模过程会在这里实时显示。</p></section>}
          {connectionError && !snapshot && (
            <section className="sync-error"><CircleAlert size={18} /><div><strong>无法同步服务器</strong><p>{connectionError}</p></div></section>
          )}

          {userMessages.map((message) => (
            <article className="message user-message" key={message.id}>
              <div className="message-meta"><span>你</span><span className="avatar user"><User size={14} /></span></div>
              <div className="user-bubble">{message.content}</div>
              {message.imageArtifactIds?.length ? <div className="image-grid">{message.imageArtifactIds.map((artifactId) => { const artifact = snapshot?.artifacts.find((item) => item.id === artifactId); return artifact ? <a href={getArtifactUrl(artifact)} target="_blank" rel="noreferrer" key={artifactId}><img src={getArtifactUrl(artifact)} alt={artifact.name} /></a> : null; })}</div> : null}
            </article>
          ))}

          {snapshot && (
            <article className="message assistant-message process-message">
              <div className="message-meta"><span className="avatar ai"><Bot size={15} /></span><span>执行过程</span></div>
              <div className="stage-stack">
                {stageGroups.map((group) => {
                  const stage = group.runs.at(-1)!;
                  const firstStage = group.runs[0];
                  const isExpanded = expanded[group.id] ?? false;
                  const stageActive = stage.status === "running" && visiblyRunning;
                  const usage = group.runs.reduce((total, run) => total + (run.usage?.total ?? 0), 0);
                  const elapsedStage = { ...stage, startedAt: firstStage.startedAt };
                  return (
                    <section className={`stage-block ${stage.status}`} key={group.id}>
                      <button className="stage-header" type="button" onClick={() => setExpanded((current) => ({ ...current, [group.id]: !isExpanded }))}>
                        <span className="chevron">{isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
                        <span className="stage-status-icon">{stageActive ? stageStatusIcon(stage.status) : stage.status === "running" ? <span className="pending-dot" /> : stageStatusIcon(stage.status)}</span>
                        <span className="stage-name">{stageNames[stage.stage]}{stage.stage !== "codegen" && stage.attempt > 1 ? ` #${stage.attempt}` : ""}</span>
                        <span className="stage-state">{stageStatusLabel(stage.status)}</span>
                        <span className="stage-metric">{formatElapsed(elapsedStage)}</span>
                        <span className="stage-metric">{usage ? `${usage.toLocaleString()} tokens` : "--"}</span>
                      </button>
                      {isExpanded && (
                        <div className="stage-stream">
                          {group.runs.map((run, attemptIndex) => (
                            <div className="stage-attempt" key={run.id}>
                              <div className="stream-lines" aria-live={run.id === stage.id && stageActive ? "polite" : "off"}>
                                {stageOutputLines(run).map((line, index) => <div className="stream-line" key={`${run.id}-${index}`}><span className="stream-dot" /><span>{line}</span></div>)}
                              </div>
                              {run.status === "failed" && run.error && (
                                <div className="stage-attempt-error"><CircleAlert size={14} /><div><strong>执行报错{group.runs.length > 1 ? ` · 第 ${attemptIndex + 1} 次` : ""}</strong><p>{run.error.message}</p><ErrorDetails error={run.error} /></div></div>
                              )}
                              {run.status === "running" && run.toolError && (
                                <div className="stage-attempt-error"><CircleAlert size={14} /><div><strong>调试报错</strong><p>{run.toolError.message}</p><ErrorDetails error={run.toolError} /></div></div>
                              )}
                            </div>
                          ))}
                          {stageActive && <div className="stream-live"><LoaderCircle className="spin" size={14} /> 正在处理</div>}
                          {stage.summary && stage.status !== "running" && (
                            <div className={`stage-result ${stage.status}`}>
                              <span className="stage-result-icon">{stageStatusIcon(stage.status)}</span>
                              <div><strong>{stage.status === "completed" || stage.status === "skipped" ? "阶段结果" : stageStatusLabel(stage.status)}</strong><p>{stage.summary}</p></div>
                            </div>
                          )}
                          {stage.status === "cancelled" && stage.error && <div className="stage-error"><CircleAlert size={14} /> {stage.error.message}</div>}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>

              {generatedImages.length > 0 && (
                <div className="artifact-images">
                  {generatedImages.map((artifact) => <a href={getArtifactUrl(artifact)} target="_blank" rel="noreferrer" key={artifact.id}><img src={getArtifactUrl(artifact)} alt={artifact.name} /><span>{artifact.name}</span></a>)}
                </div>
              )}

              {snapshot.job.status === "failed" && <section className="job-result failed"><CircleAlert size={17} /><div><strong>任务执行失败</strong><p>{snapshot.job.error?.message ?? "后端已结束本次任务"}</p><ErrorDetails error={snapshot.job.error} /></div></section>}
              {snapshot.job.status === "cancelled" && <section className="job-result cancelled"><CircleAlert size={17} /><div><strong>任务已取消</strong><p>已生成的文件可能是不完整产物。</p></div></section>}
              {snapshot.job.status === "waiting_input" && <section className="job-result waiting"><Clock3 size={17} /><div><strong>需要补充信息</strong><p>{snapshot.job.summary ?? "请在下方回复缺少的尺寸或约束。"}</p></div></section>}
              {snapshot.job.status === "completed" && (
                <section className="final-summary">
                  <div className="summary-title"><Check size={17} /> 模型已生成并通过验证</div>
                  <p>{completionSummary(snapshot.job.summary)}</p>
                  <div className="artifact-manifest">
                    {finalArtifacts.map((artifact) => (
                      <div className="artifact-manifest-row" key={artifact.id}>
                        <a href={getArtifactUrl(artifact)} download aria-label={`下载 ${artifact.name}`}>{artifact.name}</a>
                        <span className="artifact-description">{artifactDescription(artifact)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </article>
          )}
        </div>

        <footer className="composer-area">
          <div className="usage-line">
            <span>{visiblyRunning ? <><LoaderCircle className="spin" size={13} /> 正在生成</> : connection === "syncing" || connection === "stale" ? <><RefreshCw className="spin" size={13} /> 正在同步服务器</> : snapshot?.job.status === "failed" ? "任务失败" : snapshot?.job.status === "cancelled" ? "任务已取消" : "就绪"}</span>
            <span>输入 {(snapshot?.usage.input ?? 0).toLocaleString()} · 输出 {(snapshot?.usage.output ?? 0).toLocaleString()} · 共 {totalTokens.toLocaleString()} tokens</span>
          </div>
          {pendingImages.length > 0 && (
            <div className="pending-attachments" aria-label="待发送图片">
              {pendingImages.map((image) => (
                <div className={`pending-image ${image.status}`} key={image.localId} title={image.error ?? image.name}>
                  <img src={image.previewUrl} alt={image.name} />
                  {image.status === "uploading" && <span className="pending-image-state"><LoaderCircle className="spin" size={14} /> 上传中</span>}
                  {image.status === "failed" && <span className="pending-image-state failed"><CircleAlert size={14} /> 失败</span>}
                  <button type="button" onClick={() => removePendingImage(image.localId)} aria-label={`移除 ${image.name}`} title="移除图片"><X size={13} /></button>
                </div>
              ))}
            </div>
          )}
          <div className="composer">
            <input ref={fileInputRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => { void chooseImages(event.target.files); event.target.value = ""; }} />
            <button className="icon-button" type="button" aria-label="添加图片" title="添加 PNG、JPEG 或 WebP" disabled={sending || serverRunning} onClick={() => fileInputRef.current?.click()}><Paperclip size={18} /></button>
            <textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder={snapshot?.job.status === "waiting_input" ? "补充缺少的尺寸或约束" : "描述你要生成或修改的模型"} rows={1} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} />
            {serverRunning ? <button className="send-button stop" type="button" aria-label="停止生成" title="停止生成" onClick={cancel} disabled={sending}><Square size={15} fill="currentColor" /></button> : <button className="send-button" type="button" aria-label="发送" title={uploadsBlocked ? "请等待图片上传完成或移除失败图片" : "发送"} onClick={submit} disabled={!input.trim() || sending || uploadsBlocked}><Send size={17} /></button>}
          </div>
          <div className={`attachment-note ${uploadError ? "upload-error" : ""}`}><Image size={13} /> {uploadError ?? "PNG、JPEG 或 WebP，单张不超过 10 MiB"}</div>
        </footer>
      </section>

      <StlViewer
        url={stlUrl}
        filename={validatedStl?.name ?? "等待验证后的 STL"}
        generatedAt={validatedStl?.createdAt}
        size={validatedStl?.size}
        isGenerating={visiblyRunning}
      />

      {settingsOpen && (
        <div className="settings-popover" role="dialog" aria-modal="false" aria-labelledby="settings-title">
          <div className="settings-heading">
            <div><h2 id="settings-title">模型设置</h2><p>User · 本地工作区</p></div>
            <button className="dialog-close" type="button" aria-label="关闭模型设置" title="关闭" disabled={settingsStatus === "saving"} onClick={() => setSettingsOpen(false)}><X size={17} /></button>
          </div>
          <label className="settings-field">
            <span>模型</span>
            <select
              value={settingsDraft?.modelId ?? ""}
              disabled={settingsStatus === "saving" || !modelOptions.length}
              onChange={(event) => {
                const nextModel = modelOptions.find((item) => item.id === event.target.value);
                if (!nextModel || !settingsDraft) return;
                const nextEffort = nextModel.efforts.includes(settingsDraft.effort) ? settingsDraft.effort : (nextModel.efforts[0] ?? "medium");
                setSettingsDraft({ modelId: nextModel.id, effort: nextEffort });
              }}
            >
              {!modelOptions.length && <option value="">暂无可用模型</option>}
              {modelOptions.map((option) => <option value={option.id} key={option.id}>{option.label} ({option.id})</option>)}
            </select>
          </label>
          <fieldset className="settings-field effort-field">
            <legend>Effort</legend>
            <div className="effort-options">
              {(settingsDraft?.modelId ? modelOptions.find((item) => item.id === settingsDraft.modelId)?.efforts : [])?.map((effort) => (
                <button className={settingsDraft?.effort === effort ? "effort-option selected" : "effort-option"} type="button" key={effort} disabled={settingsStatus === "saving"} onClick={() => setSettingsDraft((current) => current ? { ...current, effort: effort as ModelEffort } : current)}>{effort.toUpperCase()}</button>
              ))}
            </div>
          </fieldset>
          <p className="settings-note">设置会应用到下一次新建或修改请求，正在运行的任务不会切换模型。</p>
          {settingsError && <div className="settings-error"><CircleAlert size={14} /> {settingsError}</div>}
          <div className="settings-footer">
            <span className={`settings-state ${settingsStatus}`}>{settingsStatus === "loading" ? "正在读取" : settingsStatus === "saving" ? "正在保存" : settingsStatus === "saved" ? "已保存" : settingsStatus === "error" ? "保存失败" : ""}</span>
            <div className="settings-actions">
              <button className="secondary-button" type="button" disabled={settingsStatus === "saving"} onClick={() => { setSettingsDraft(modelSettings); setSettingsOpen(false); }}>取消</button>
              <button className="settings-save" type="button" disabled={settingsStatus === "saving" || !settingsDraft || !modelOptions.length} onClick={() => void saveSettings()}>{settingsStatus === "saving" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} 保存</button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deletingId) setDeleteTarget(null); }}>
          <section className="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" aria-describedby="delete-dialog-description">
            <div className="dialog-heading">
              <div><h2 id="delete-dialog-title">删除 Session</h2><p>{deleteTarget.title || "未命名 Session"}</p></div>
              <button className="dialog-close" type="button" aria-label="关闭" title="关闭" disabled={Boolean(deletingId)} onClick={() => setDeleteTarget(null)}><X size={17} /></button>
            </div>
            <p id="delete-dialog-description" className="delete-warning">对话、执行记录、上传图片以及该 Session 生成的模型文件将被永久删除，无法恢复。</p>
            <p className="archive-retained"><Check size={15} /> 已成功归档到自进化库的模型、渲染图、摘要和经验将继续保留。</p>
            {deleteError && <div className="dialog-error"><CircleAlert size={15} /><span>{deleteError}</span></div>}
            <div className="dialog-actions">
              <button className="secondary-button" type="button" disabled={Boolean(deletingId)} onClick={() => setDeleteTarget(null)}>取消</button>
              <button className="danger-button" type="button" disabled={Boolean(deletingId)} onClick={() => void deleteSession()}>
                {deletingId ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
                {deletingId ? "正在删除" : "永久删除"}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
