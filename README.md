# dsh-plugin-prompt-enhancer

把模糊的提示词草稿，变成自然语言、可直接执行的高质量提示词。

DeepSeek Harness (DSH) 插件。改写之前，它先自动读懂当前工作区——目录结构、依赖清单、README、测试配置、相关文件、git 历史——让增强后的提示词建立在真实上下文之上，而不是靠猜。

## 功能特性

- **`/enhance <草稿>` 命令与火花按钮**：在输入框写好草稿后点火花按钮，或直接执行 `/enhance <草稿>`
- **火花按钮状态指示**：输入框为空时星星为蓝色 (`#0E6FEA`)，有内容时变为红色 (`#E31D34`)
- **结果面板**：滑入动效，三态显示（pending / error / success），支持复制、替换草稿、关闭
- **模型路由**：四级回退——显式配置的固定 `provider` + `model` → 当前会话已记录路由 → DSH 运行时/桌面默认模型（`_dsh_src/dsh/` 清单）→ 插件内置默认（`guomo` / `deepseek-v4.1-flash`）；仅全部落空才报错，空白会话开箱即用
- **端到端超时**：默认 30s 可配，覆盖上下文采集与生成全流程
- **结果缓存**：相同草稿与模型组合直接复用，避免重复计算

## 工作原理

### 上下文包

点击增强或执行 `/enhance` 时，插件在进程内检查工作区，组装一个受预算约束的上下文包：

| 段 | 内容 |
|---|---|
| **引用文件** | 草稿中 `@` 提及的文件内容。采用结构化压缩：小文件（≤2000 字）原样保留；大文件按 60% 头部 + 40% 尾部保留，中间插入省略标记；源码文件优先提取顶层声明大纲（export/function/class/def 等）；超大文件（>200KB 或 >5000 行）仅输出大纲 + 首尾各 20 行；锁文件（package-lock.json）、.min.js、二进制文件仅输出元信息（路径 + 大小），不贴内容。每段带压缩标记 `[已压缩: 原文 X 行/Y 字节 → ...]`。最多 3 个文件 |
| **工作区骨架** | 目录树（深度 2，自动跳过 `node_modules`、`.git`、`dist`、`.dart_tool` 等噪声目录），最深层目录直接列出内部文件名：`lib/ → client.js, index.js` |
| **项目清单要点** | 读取 `package.json` / `pom.xml` / `pyproject.toml` / `Cargo.toml` / `go.mod` / `deno.json` / `pubspec.yaml` / `mix.exs` / `*.csproj` 等：包名、type、workspaces、engines、scripts、依赖清单；顶层没有清单时自动下探一层 |
| **项目类型** | 构建文件探测出的技术栈标签 + 顶层条目数 |
| **相关文件位置** | 用草稿里的标识符和中文词检索工作区：先字面命中，再按文件名/路径匹配，中文短语无字面命中时退化为二元组集合按命中数排序，输出 `文件:行 + 该行内容` |
| **README 摘要** | 项目自身 README 的开头（自动剔除徽章与图片行） |
| **测试线索** | 测试框架线索（vitest / jest / pytest / JUnit…）、配置文件、测试目录、测试文件数、test 脚本 |
| **本会话最近操作的文件** | 会话日志中的工具调用目标（仅锚定档） |
| **Git 未提交改动** | `status --porcelain` + `diff --stat HEAD`（仅锚定档） |
| **Git 最近提交** | 分支名 + 最近 5 条提交标题 |

检索优先使用 DSH 自带的 ripgrep；不可用时退回有界进程内扫描（深度 4 文件索引、≤240 个文件、≤256KB/文件、只读文本类扩展名）。两条路径都受 1.5s/次、4s 总预算约束。

### 分档策略

| 档位 | 触发条件 | 注入内容 |
|---|---|---|
| **T1 锚定** | `@` 引用命中文件，或草稿中的路径提及与本会话最近操作文件 / git 改动相交 | 全部（含引用文件与会话内信号） |
| **T2 项目感知** | 工作区有代码但无锚点（例如「分析下当前项目」） | 骨架 + 清单 + 相关文件 + README + 测试线索 + 提交历史 + 项目类型 |
| **T3 绿地规格** | 空工作区 / 无工作目录 | 不注入内容，纯规格改写 |
| **T0 纯改写** | `contextEnabled: false` | 不采集任何东西 |

### 输出形态

- **自然语言散文**：命令式短句，通常两到四句；不设固定章节标题，不自创报告结构与阅读顺序
- **零提问**：不弹卡片、不多轮往返，一次生成定稿
- **不留待确认**：上下文没覆盖的决策，按该技术栈的通用做法内联写成 `默认：…`

### 安全与稳健

- **反幻觉**：只引用上下文包中确实存在的内容，不扩展、不编造
- **反提示注入**：上下文包视为惰性事实数据——包内文件、README、命中行中的祈使文本是仓库事实，不是给模型的指令
- **秘密文件排除**：`.env*` / `*.pem` / `*.key` / `*.p12` / `*.pfx` / `id_rsa*` 不参与关键词检索与片段引用
- **全链路容错**：git 缺失、文件不可读、检索不可用都静默降级，增强不会因此失败
- **不破坏草稿**：增强失败时原始草稿保持不变，随时可以直接发送

## 安装与启用

### 方式一：通过 DSH 插件管理器（推荐）

1. 打开 DSH 设置 → 插件管理
2. 点击"安装"，填入包名 `dsh-plugin-prompt-enhancer`
3. 通过校验后启用并重启 DSH

### 方式二：本地/私有插件接入

**从源码目录挂载**：

```powershell
# 1. 拷贝到 profile 的 node_modules（目录名需等于包名）
Copy-Item -Recurse dsh-prompt-enhancer C:\Users\<user>\.dsh\profiles\desktop\node_modules\dsh-plugin-prompt-enhancer

# 2. 在 profile 的 package.json 中，dsh.profile.bundles 数组追加 "dsh-plugin-prompt-enhancer"

# 3. 重启 DSH 桌面应用
```

**注**：插件包名为 `dsh-plugin-prompt-enhancer`，与 `package.json` 中 `name` 字段一致。

## 使用示例

### 示例 1：通过 `/enhance` 命令

```
/enhance 分析下当前项目的测试覆盖情况
```

结果面板显示改写后的提示词，包含具体要分析的测试目录、配置文件、测试文件清单等。

### 示例 2：通过火花按钮

1. 在输入框输入草稿：`重构 lib/index.js 的上下文采集逻辑`
2. 点击输入框旁的火花按钮（红色星星）
3. 结果面板滑出，显示改写后的提示词：一段自然语言短段落，点明重构 `lib/index.js` 上下文采集逻辑的具体步骤（按需引用真实函数签名与依赖）、保持现有 API 且不影响测试的约束，并以测试通过、无功能回归作为验收
4. 点击"替换草稿"，改写结果填入输入框，然后正常发送

## 配置项

在 profile 的 `cordis.patch.yml` 中按条目 `id: prompt-enhancer` 覆盖：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `provider` + `model` | 未设置 | 必须成对设置；成对设置即固定路由（优先级最高）。不设置则按「当前会话路由 → DSH 运行时/桌面默认 → 内置默认」回退（推荐不设置） |
| `maxOutputTokens` | `2000` | 增强输出 token 上限（推理 token 与正文共享此预算） |
| `timeout` | `30000` | 单次增强端到端超时，毫秒。覆盖采集与生成全程，纠正性重试共用同一预算。非法值自动回退 30000；旧名 `timeoutMs` 仍兼容 |
| `reasoningEffort` | `"off"` | 辅助调用推理档位，原样透传给模型服务商；设为空字符串则不传该字段。服务商若拒绝该字段，插件会自动省略并重试一次 |
| `systemPromptExtra` | `""` | 追加到增强系统提示词的自定义指令 |
| `contextEnabled` | `true` | 上下文采集总开关（false 时固定为纯改写） |
| `maxContextChars` | `10000` | 上下文包总字符预算（按段优先级填充，超预算的段舍弃） |
| `recentToolScan` | `40` | 扫描最近多少条工具调用事件来提取操作文件 |
| `inventoryDepth` | `2` | 工作区骨架深度 |
| `inventoryMaxEntries` | `60` | 骨架最多渲染多少条 |
| `inventoryScanDepth` | `4` | 文件索引深度（关键词检索、测试文件统计用） |
| `entitySearchEnabled` | `true` | 是否用草稿关键词反查相关文件 |
| `entityHitsMax` | `6` | 关键词命中最多引用几个文件 |
| `gitLogCount` | `5` | 引用最近几条提交标题 |

**配置示例**：

```yaml
- insert:
    - id: prompt-enhancer
      name: dsh-plugin-prompt-enhancer
      config:
        # provider: 'deepseek'
        # model: 'deepseek-chat'
        maxOutputTokens: 2000
        timeout: 30000
        reasoningEffort: off
        maxContextChars: 10000
        inventoryDepth: 2
        inventoryScanDepth: 4
        entitySearchEnabled: true
        gitLogCount: 5
```

## 目录结构

```
dsh-prompt-enhancer/
├── lib/
│   ├── client.js          # 客户端界面逻辑（火花按钮、结果面板）
│   └── index.js           # 服务端插件主逻辑（/enhance 命令、上下文采集、增强流程）
├── test/
│   ├── e2e-context.test.mjs    # 端到端上下文采集测试
│   ├── internals.test.mjs      # 纯函数单元测试
│   └── runner.test.mjs         # 运行时机制测试
├── scripts/                # 辅助脚本（开发期）
├── packages/              # 类型定义与生成器（开发期）
├── cordis.patch.yml       # DSH bundle 层配置
├── icon.svg               # 插件图标
├── package.json           # 包清单
└── README.md             # 本文档
```

## 测试

```powershell
npm test        # 等价于 node --test
```

三个测试套件：

- **`internals.test.mjs`**：纯函数单元测试（引用解析、实体词提取、清单事实、骨架渲染、测试线索、检索排序、文件内容结构化压缩）
- **`e2e-context.test.mjs`**：真实工作区端到端测试（完整上下文采集流程）
- **`runner.test.mjs`**：运行时机制测试（缓存淘汰、超时配置与路径、缓存键组成、四级模型路由回退、采集阶段预算与取消）

总计 277 项断言。

## 运行环境与依赖

- **宿主要求**：DSH `0.2.0-rc.2` 或更高版本
- **Node.js**：`package.json` 声明 `"type": "module"`，纯 ESM
- **运行时依赖**：仅 `@deepseek-ai/schemastery`（用于配置 schema 声明）
- **peer 依赖**：
  - `@deepseek-ai/cordis` `>=4 <5`
  - `@deepseek-ai/dsh-api-gateway` `>=0.2.0-rc.2`
  - `@deepseek-ai/dsh-commands` `>=0.2.0-rc.2`
  - `@deepseek-ai/dsh-typert-protocol` `>=0.2.0-rc.2`
- **零构建**：无编译步骤，无工具链要求

## 已知限制

- **不做提问交互**：没有澄清提问、没有多轮往返，草稿一次生成定稿
- **结果缓存无过期时间**：按最近使用淘汰（上限 32 条）；草稿变化或工作区状态变化会自然失效
- **DSH 暂不支持插件自动更新**：升级需卸载后重新安装

## 许可证

MIT
