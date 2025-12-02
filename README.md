# AI Studio Chat Compressor

[![Tampermonkey Install](https://img.shields.io/badge/Tampermonkey-一键安装-27ae60?logo=tampermonkey&logoColor=white)](https://lxchx.github.io/aistudio-compressor/aistudio-compressor.user.js)

一个运行在 Google AI Studio（MakerSuite）里的油猴脚本，提供以下能力：

- **一键压缩**：注入预设 Prompt，总结并截取聊天历史。
- **快照注入**：将压缩结果和尾部历史拼接成新的分支，便于继续对话。
- **网络监控**：拦截 `GenerateContent` / `CreatePrompt` / `ResolveDriveResource` 等请求，方便排查。
- **可视化设置**：独立的配置页（GitHub Pages）支持 Prompt、自定义正则以及尾部保留策略。

> ⚠️ 本脚本仅在 `https://aistudio.google.com/prompts/*` 页面生效，需搭配 Tampermonkey 之类的用户脚本管理器使用。

## 快速开始

1. **安装脚本**：点击上方「一键安装」按钮，Tampermonkey 将自动打开并导入脚本。
2. **允许站点匹配**：确认脚本匹配 `https://aistudio.google.com/prompts/*` 与 `https://aistudio.google.com/prompts/new_chat`。
3. **打开 AI Studio**：进入任意对话页面，工具栏右侧会出现 `developer_guide` 图标的按钮。
4. **压缩对话**：点击按钮后脚本会自动填入压缩 Prompt、发送请求，并在响应返回后创建新分支。

## 设置面板（GitHub Pages）

- 页面：<https://lxchx.github.io/aistudio-compressor>
- 功能：
  - 编辑压缩 Prompt（同步 Tampermonkey 本地存储）。
  - 自定义快照提取正则（默认按 `<state_snapshot>` 标签截取）。
  - 设置尾部保留百分比/最少字符数，决定被拼接进新分支的历史范围。
  - 从脚本发送的 `postMessage` 事件中自动同步当前设置。

脚本端菜单：

```text
Tampermonkey -> AI Studio Chat Compressor
├─ 打开 Compressor 设置... （跳转至上方链接）
└─ 重置 Compressor 设置
```

## 本地开发

```bash
# 安装依赖（无特别要求，推荐 Node 18+ 以便开发工具）
cd aistudio-compressor

# 调试：可使用任意静态服务器或 VS Code Live Server 预览 index.html
npx serve .
```

GitHub Pages CI（`.github/workflows/deploy-gh-pages.yml`）会在 push 到 `main` 且目录有改动时自动部署 `aistudio-compressor/`，生成的站点作为脚本设置页使用。

## 目录结构

```
aistudio-compressor/
├── aistudio-compressor.user.js   # 核心 Tampermonkey 脚本
├── index.html                    # Settings UI（部署到 GH Pages）
├── README.md                     # 说明文档（当前文件）
└── .github/workflows/            # Pages 部署 CI
```

欢迎根据需要 fork/修改，或在 Issues 中反馈问题。请注意遵守 AI Studio / Google 的使用条款，自行承担使用风险。 
