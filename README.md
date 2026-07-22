# CADIR

CADIR 是一个面向 CAD 建模任务的单智能体 Web 应用。用户通过网页输入自然语言需求，后端将同一会话交给 OpenCode 持续执行：需求分析、代码生成、CADIR/FreeCAD 运行、视觉反馈和最终自进化归档。

CADIR 生成的不是只能查看的网格截图，而是可继续编辑的跨平台 CAD 模型。一次成功任务会保存 Python/JSON 设计源文件，并导出 STEP、STL 和 FreeCAD `FCStd` 文件；同时保存等轴测、正视、俯视和右视渲染图，方便检查模型结果。

## 特点

- 浏览器中的 ChatGPT 风格对话界面，支持流式输出和任务阶段状态。
- 一个 OpenCode 智能体在同一会话中持续推进任务，不使用子智能体架构。
- Docker 中运行 API、网页和包含 FreeCAD 环境的 OpenCode CAD 运行时。
- `cadir_run` 负责执行和验证 CADIR 模型；FreeCAD 用于将结果转换为可编辑的 `FCStd` 文件。
- 后端持久化会话、阶段事件、错误、Token 用量和产物，浏览器断开后可重新连接并回放事件。
- 成功任务的自进化产物单独保存到 `cadir-rag-library` 归档卷；当前版本只保存，不启用检索。

## 系统结构

```text
Browser
   │ HTTP/SSE
   ▼
web (Nginx + React)
   │ /api
   ▼
api (Fastify BFF)
   │ OpenCode API + internal callbacks
   ▼
opencode (OpenCode + CADIR runtime + FreeCADCmd)
   │
   ├── /workspace/jobs       任务、运行记录和最终产物
   └── /home/cadir/...       OpenCode 本地数据
```

API 是会话和任务状态的唯一来源。浏览器不会接触 LLM API Key；OpenCode 的工具回调通过内部 Token 访问 API。

## 快速部署（Docker Compose）

### 先决条件

- Docker Desktop 或 Docker Engine，包含 Compose v2
- 至少 4 GB 可用内存（OpenCode、Node API 和 FreeCAD 同时运行）
- 一个可用的 OpenAI-compatible LLM 服务地址和 API Key

### 1. 准备配置

在仓库根目录复制环境变量模板：

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，至少填写以下值。真实的 `.env` 不要提交到 Git：

```dotenv
CADIR_LLM_BASE_URL=https://openrouter.icu/v1
CADIR_LLM_API_KEY=替换为服务端API密钥
INTERNAL_API_TOKEN=生成一个随机的内部调用令牌
OPENCODE_SERVER_PASSWORD=生成一个随机的OpenCode密码
```

`CADIR_LLM_BASE_URL` 必须提供 OpenAI-compatible `/v1` 接口。默认模型是 `gpt-5.6-sol`；网页中的模型设置会使用后端公布的可用模型列表进行校验。

### 2. 构建并启动

```bash
docker compose up -d --build
```

查看服务状态：

```bash
docker compose ps
```

查看实时日志：

```bash
docker compose logs -f api opencode web
```

### 3. 打开网页

默认地址：

- Web：<http://localhost:5173>
- API 健康检查：<http://localhost:3001/health>

自定义端口时，在 `.env` 中设置：

```dotenv
CADIR_WEB_PORT=5182
CADIR_API_PORT=3021
```

然后重新创建服务：

```bash
docker compose up -d
```

## 数据和产物

Compose 使用以下 named volumes 保存数据，重启容器不会丢失：

| Volume | 内容 |
| --- | --- |
| `cadir-data` | 会话、任务状态、事件和 Token 用量数据库文件 |
| `cadir-jobs` | 每个任务的 requirements、模型源文件、渲染图和导出模型 |
| `cadir-rag-library` | 成功自进化归档：`model.py`、`model.json`、渲染图、摘要和经验；当前不做检索 |
| `opencode-data` | OpenCode 的本地运行数据 |

成功任务的最终运行目录通常包含：

```text
requirements.md
model.py
model.json
model.step
model.stl
model.FCStd
render-isometric.png
render-front.png
render-top.png
render-right.png
manifest.json
```

网页最后的完成消息会列出这些文件的实际位置。删除某个 session 时，会删除该 session 的任务目录和普通任务记录；已写入独立自进化归档卷的案例不会被 session 删除操作清理。

## 常用运维命令

停止服务但保留数据：

```bash
docker compose stop
```

启动已有容器：

```bash
docker compose start
```

重新构建某个服务：

```bash
docker compose build api opencode web
docker compose up -d
```

停止并删除容器、网络（保留 named volumes）：

```bash
docker compose down
```

连同所有持久化数据一起删除（不可恢复）：

```bash
docker compose down -v
```

## 本地开发（可选）

Docker Compose 是推荐的完整运行方式，因为 `opencode` 镜像中包含 FreeCAD。只修改网页时可以使用本地 Vite：

```bash
pnpm install
pnpm dev
```

API 单独开发：

```bash
cd apps/api
npm install
npm run dev
```

完整类型检查和测试：

```bash
cd apps/api
npm run typecheck
npm test

cd ../..
pnpm build
```

本地 API 运行仍需要一个可访问的 OpenCode 服务；如果没有配置 `OPENCODE_URL`，提交的任务会以 `OPENCODE_UNAVAILABLE` 进入失败状态。

## 一次任务的执行流程

1. 用户在一个 session 中提交自然语言 CAD 需求。
2. API 创建 job，并记录 OpenCode usage 基线，避免重试阶段重复计算历史 Token。
3. OpenCode 在同一个会话内依次完成需求分析、代码生成和 `cadir_run` CAD 运行。
4. 视觉反馈阶段检查四个方向的渲染图；失败时回到代码生成修正，成功后才进入自进化。
5. 自进化阶段将成功模型、渲染图、摘要和经验写入独立归档库。
6. API 注册最终产物并通过 SSE 推送状态；网页断线重连后会先获取快照，再从最后一个事件序号继续接收。

## 许可证和参考资料

本仓库包含 CADIR Web Agent 实现、Docker 部署文件、CAD 运行时和 SimpleCADAPI 参考资料。项目设计文档见 [`CADIR_OPENCODE_WEB_TASK.md`](./CADIR_OPENCODE_WEB_TASK.md)。
