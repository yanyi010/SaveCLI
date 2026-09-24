<div align="center">
  <img src="docs/assets/banner.svg" alt="SaveCLI — 为终端打造的 token 高效编码智能体" width="100%" />

  <br />

  <p>
    <a href="https://github.com/yanyi010/SaveCLI/releases"><img src="https://img.shields.io/github/v/release/yanyi010/SaveCLI?style=flat-square&label=release&color=2DD4BF" alt="release" /></a>
    <img src="https://img.shields.io/badge/runtime%20deps-0-34D399?style=flat-square" alt="zero runtime dependencies" />
    <img src="https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white" alt="node ≥ 20" />
    <img src="https://img.shields.io/badge/tests-133%20passing-22D3EE?style=flat-square" alt="133 tests passing" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license" /></a>
  </p>

  <p>
    <a href="README.md">English</a> · <b>简体中文</b>
  </p>

  <p>
    <a href="#快速开始">快速开始</a> ·
    <a href="#token-经济">Token 经济</a> ·
    <a href="#mission-模式">Mission 模式</a> ·
    <a href="#安全模型">安全模型</a> ·
    <a href="#模型供应商">模型供应商</a> ·
    <a href="#配置">配置</a>
  </p>
</div>

---

**SaveCLI** 是一个为终端打造的 token 高效编码智能体：完备的编码智能体能力、
极简的体量 —— 单一的零依赖 Node 二进制、约 350 token 的系统提示词，
以及一整套在每一轮都在为你省钱的 token 经济特性。它还内置了
**Mission Driver** —— 一个 planner / engineer / reviewer
循环，可以脱离人工连续工作数小时。

## 快速开始

```bash
npm install -g savecli
savecli setup     # 引导式配置：供应商、密钥、模型 —— 带连接测试
savecli           # 完成，开始对话
```

要求 Node ≥ 20。安装到此为止 —— 没有依赖树。

<p align="center">
  <img src="docs/assets/demo.svg" alt="一次 SaveCLI 会话：将 lodash 迁移为原生 JS，工具流实时展开，随后查看 /usage" width="90%" />
</p>

## 为什么选 SaveCLI

| | **SaveCLI** | 常见 CLI |
|---|---|---|
| 运行时依赖 | **0** | 50–300 个包 |
| 启动耗时（`--version`） | **~260 ms** | 0.3–2 s |
| 系统提示词 | **~350 token** | 1–15k token |
| 响应缓存 | **有** | 罕见 |
| 自动压缩 | **有，支持聚焦指令** | 手动 |
| 凭证卫生 | **0600 权限 + 全链路脱敏** | 参差不齐 |
| 遥测 | **完全没有** | 参差不齐 |

## Token 经济

以下特性全部默认开启，并可在 `/usage` 中随时查看账目。

<p align="center">
  <img src="docs/assets/token-economy.svg" alt="六项 token 经济特性：响应缓存、自动压缩、输出截断、上下文脱敏、提示词缓存、用量账本" width="100%" />
</p>

- **响应缓存** —— 相同会话直接从磁盘应答（`~/.savecli/cache/responses`，
  LRU 200，私有权限）。重复运行花费 0 token。
- **自动压缩** —— 估算上下文超过 24k token 时，由廉价小模型总结较早轮次，
  近期轮次保持原文。`/compact <focus>` 可手动执行并附带聚焦指令。
- **工具输出截断** —— 超大输出仅保留首尾（8 KB 上限）。
- **上下文脱敏** —— 工具输出在进入会话前会被擦除其中的密钥类内容。
- **提示词缓存** —— 尽可能使用 Anthropic 缓存断点（system + 最后一条消息）
  以及 OpenAI 兼容缓存。
- **用量账本** —— 每次请求连同成本估算追加到 `~/.savecli/usage.jsonl`；
  `savecli usage` 可查看今日 / 7 天 / 全部统计。

## Mission 模式

为「以小时计」的工作而生 —— 发起一个 mission，然后去忙别的：

```bash
savecli mission start "migrate tests to vitest" \
  --criteria "all suites green" --autonomy pragmatic --max-tasks 20
savecli mission list
savecli mission status <id>
savecli mission resume <id>
```

<p align="center">
  <img src="docs/assets/mission-driver.svg" alt="Mission Driver 循环：brief、planner、engineer、reviewer，含通过与重试回路" width="100%" />
</p>

- **Planner**（小模型）从 mission 简报中挑选下一个任务。
- **Engineer**（主模型）以*全新上下文*执行每个任务 ——
  不漂移、不带陈旧历史。
- **Reviewer**（只读工具）核验真实证据，返回 pass / fail / blocked。
  失败任务携带评审反馈重试（最多 3 次）。
- token、任务数、时长、尝试次数均有硬性预算；每一步状态落盘到
  `~/.savecli/missions/`；Ctrl-C 暂停后可干净地恢复。

## 安全模型

凭证永远不离开 `~/.savecli/credentials.json`（0600 权限，原子写入）：

- `.ssh`、`.aws`、`~/.savecli` 及疑似凭证路径对 read/write/bash 工具
  **默认拒绝** —— `sudo rm` 式的拒绝规则无法被绕过，即使在 `--yolo`
  模式下也不行。
- 写入 `.git/**` 或 `.savecli/**` 一律被拒绝；修改根目录 `AGENTS.md` /
  `CLAUDE.md` 需要交互批准。
- 所有日志输出到 stderr，全量脱敏，且仅在设置 `SAVECLI_DEBUG=1` 时启用。
- 供应商错误响应在展示前先脱敏。
- bash 命令走 deny / allow / ask 三道闸门；回答 *always* 只会添加一条
  保守的、会话级的模式（如 `git status*`），绝不放开整个命令。
- read 工具在 stat **之前**检查路径安全判定，agent 连「受保护文件是否
  存在」都无法探测。

## 模型供应商

内置档案：`anthropic`、`claude`、`openai`、`codex`、`deepseek`、
`moonshot`、`zhipu`、`openrouter`、`ollama`、`lmstudio` —— 以及任何通过
自定义 base URL 接入的 OpenAI 兼容网关：

```bash
savecli setup                          # 引导式：供应商、密钥、模型
savecli config profile mygate          # 交互式档案编辑器
savecli config set defaultProfile mygate
savecli -m deepseek                    # 单次运行覆盖
savecli -m anthropic/claude-haiku-4-5  # 供应商/模型 形式
```

密钥解析顺序：`SAVECLI_API_KEY` 环境变量 → 档案 `apiKeyEnv` → 凭证库
（`auth login`）→ 内联（仅限用户级配置；项目级配置中的密钥出于安全
会被忽略）。Claude / Codex 登录使用 device-code 流程，并提供手动粘贴
回退方案。

## 日常使用

```bash
savecli                        # REPL：流式输出、插队指令、斜杠命令
savecli "fix the failing test" # 单次执行，带工具进度
git diff | savecli -p "review" # print 模式：只输出答案，可脚本化
```

REPL 斜杠命令：`/help /model /usage /compact /clear /fork /undo
/resume /todos /set /yolo /exit`，另支持来自
`.savecli/commands/*.md` 的自定义命令（可用 `$ARGUMENTS`）。

- **插队指令（_steering_）** —— agent 工作时可随时输入；消息会在下一次
  模型迭代前注入，不丢任何按键。
- **`/undo`** —— 撤销上一轮产生的全部文件修改（每次变更前都有快照）。
- **`/fork`** —— 从当前会话分叉，向两个方向分别探索。

## 配置

分层：默认值 < `~/.savecli/config.json` < 项目 `.savecli/config.json` <
环境变量。所有键都可以从 CLI 查询：

```bash
savecli config list                 # 全部键 + 说明
savecli config set permissions.bashAsk false
savecli config set tokenSaving.compactThresholdTokens 18000
savecli config edit                 # 在 $EDITOR 中打开
```

环境变量：`SAVECLI_HOME`、`SAVECLI_PROFILE`、`SAVECLI_MODEL`、
`SAVECLI_BASE_URL`、`SAVECLI_API_KEY`、`SAVECLI_NO_CACHE`、`SAVECLI_DEBUG`。

## 开发

```bash
npm install
npm run build      # tsc → dist/
npm test           # vitest：133 个测试，含真实-HTTP 供应商 mock
npm run lint       # eslint（0 错误）
npm run typecheck  # tsc --noEmit
```

要求：Node ≥ 20。零运行时依赖。

## 许可证

[MIT](LICENSE)

<br />

<div align="center">
  <img src="docs/assets/logo.svg" alt="SaveCLI logo" width="56" />
  <br />
  <sub><b>SaveCLI</b> —— 把 token 花在工作上，而不是开销上。</sub>
</div>
