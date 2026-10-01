# dsh-prompt-enhancer

DeepSeek Harness (DSH) 提示词增强插件：先把工作区"查清楚"，再把模糊的提示词草稿改写为结构化、可直接执行的高质量提示词。

## 当前状态：P3-lite（上下文优先，纯采集版）

**只有上下文采集，没有任何提问交互**：不弹卡片、不多轮往返，单次生成定稿。曾经的"提问卡片"方案整体留在 `git stash` 里（`stash@{0}`），需要时可再评估。

- ✅ `/enhance <草稿>` 命令 + 输入框火花按钮（星星随草稿状态变色：空 `#0E6FEA` / 有词 `#E31D34`）
- ✅ 结果面板（滑入动效、复制 / 替换草稿 / 关闭、pending / error / success 三态）
- ✅ 模型路由默认跟随当前会话（`session.requestHeader()`），可配置覆盖
- ✅ 30s 硬超时 + 结果缓存（草稿+路由+上下文摘要键）
- ✅ **工作区自检上下文包**（全部 DSH 内部能力，进程内；单次采集实测 ~100ms）：

| 段 | 内容 | 作用（对应原本会问/会猜的问题） |
|---|---|---|
| 引用文件 | 草稿 `@` 提及的文件内容（≤2000 字/个，≤3 个） | "你说的那个文件" |
| 工作区骨架 | 目录树（深度 2，跳过 node_modules/.git/dist 等 40+ 噪声目录），最深层目录**直接列出内部文件名**：`lib/ → client.js, index.js` | 项目结构 / 入口在哪 / 改哪个文件 |
| 项目清单要点 | 真实读取 `package.json`/`pom.xml`/`pyproject.toml`/`Cargo.toml`/`go.mod` 等：包名、type、workspaces、engines、scripts、依赖清单；顶层没有清单时自动下探一层（多项目/子包） | 什么技术栈/语言/依赖/怎么跑 |
| 项目类型 | 构建文件探测标签 + 顶层条目数 | 同上（兜底） |
| 相关文件位置 | 用草稿里的标识符/中文词在工作区检索：先字面命中，再**文件名/路径**匹配，中文短语无字面命中时退化为**二元组集合**按命中数排序，输出 `文件:行 + 该行内容` | "这个功能在哪个文件里？" |
| README 摘要 | 项目自己的 README 开头（自动剔除徽章/图片行），同样支持下探 | "这个项目是干什么的？" |
| 测试线索 | 测试框架线索（vitest/jest/pytest/JUnit…）、配置文件名、测试目录、测试文件数、test 脚本 | 用什么测试/测试放哪 |
| 本会话最近操作的文件 | 会话日志里的 tool/call 目标（T1 才有） | "我们刚才在改什么？" |
| Git 未提交改动 | `status --porcelain` + `diff --stat HEAD`（T1 才有） | "当前在做什么？" |
| Git 最近提交 | 分支名 + 最近 5 条提交标题 | "这个仓库最近的动向？" |

| 档位 | 触发条件 | 注入内容 |
|---|---|---|
| T1 锚定 | `@` 引用命中文件，或草稿实体与本会话最近操作文件 / git 改动相交 | 全部（含引用文件与会话内信号） |
| T2 项目感知 | 工作区有代码但无锚点（典型="分析下当前项目"） | 骨架 + 清单 + 相关文件 + README + 测试线索 + 提交历史 + 项目类型（不含会话内信号） |
| T3 绿地规格 | 空工作区 / 无 cwd | 不注入内容，绿地规格模式 |
| T0 纯改写 | `contextEnabled: false` | 不采集任何东西 |

- ✅ **检索能力自适应**：优先用 DSH 自带的 ripgrep（`@vscode/ripgrep` 解包路径 / PATH / 包解析三路探测），拿不到就退回**有界进程内扫描**（深度 4 文件索引、≤240 个文件、≤256KB/文件、只读文本类扩展名），两条路径都受 1.5s/次、4s 总预算约束
- ✅ **提示词把"从包里答"写死**：语言/框架/入口/目录/依赖/测试命令/在做的事一律从上下文包回答，不许写成待确认；宽泛草稿要自己从骨架和命中文件定范围；有合理默认时写成 `默认：…` 而不是留开放问题
- ✅ 反幻觉红线：系统提示词强制"只引用上下文包中确实存在的内容"
- ✅ 信号采集全部容错（git 缺失 / 文件不可读 / sessionQuery 异常都静默降级，增强永不因此失败）
- ✅ meta 行展示档位与信号摘要：`增强完成 · T2 项目感知 · 模型 x/y · 首 token · 总计 · tokens · 骨架 10 项 · 清单 · README · 测试线索`
- ✅ 95 项单测（`node test/internals.test.mjs`）

## 安装（本地开发）

```powershell
# 1. 拷贝包到 profile
Copy-Item -Recurse dsh-prompt-enhancer C:\Users\<user>\.dsh\profiles\desktop\node_modules\

# 2. profile package.json 的 dsh.profile.bundles 追加 "dsh-prompt-enhancer"

# 3. profile 的 cordis.patch.yml 可选覆盖配置（条目 id: prompt-enhancer）

# 4. 重启 DSH 桌面应用
```

## 配置（profile cordis.patch.yml，条目 id `prompt-enhancer`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` + `model` | 未设置 | 必须成对设置；不设置则跟随当前会话的模型路由（推荐） |
| `maxOutputTokens` | 2000 | 增强输出 token 上限（**推理 token 与正文共享此预算**，高推理档模型尤其注意） |
| `timeoutMs` | 30000 | 单次增强端到端超时 |
| `reasoningEffort` | `off` | 辅助调用推理档位（合法值 off/low/high/max）；`off` 把全部预算留给正文，设为空字符串则不传该字段 |
| `systemPromptExtra` | 空 | 追加到增强系统提示词的自定义指令 |
| `contextEnabled` | true | 上下文采集总开关（false 时固定 T0 纯改写） |
| `maxContextChars` | 10000 | 上下文包总字符预算（按段优先级填充，超预算的段直接舍弃） |
| `recentToolScan` | 40 | 扫描最近多少条 tool/call 事件提取操作文件 |
| `inventoryDepth` | 2 | 工作区骨架深度（最深层目录会内联列出文件名） |
| `inventoryMaxEntries` | 60 | 骨架最多渲染多少条 |
| `inventoryScanDepth` | 4 | 文件索引深度（关键词检索、测试文件统计用） |
| `entitySearchEnabled` | true | 是否用草稿关键词在工作区反查相关文件 |
| `entityHitsMax` | 6 | 关键词命中最多引用几个文件 |
| `gitLogCount` | 5 | 引用最近几条提交标题 |

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 命令骨架 + 纯 LLM 改写 + 路由跟随 + 超时/缓存 | ✅ 完成 |
| P1 | 输入框按钮 + 草稿回写 + 结果面板 | ✅ 完成 |
| P2 | DSH 内部上下文采集 + 三档策略路由 | ✅ 完成 |
| P2+ | 澄清提问（提问卡片多轮往返） | ⏸ 已实现后回退，整体保留在 `stash@{0}` |
| P3-lite | 工作区自检（骨架/清单/README/测试线索/提交历史）+ 关键词反查（含中文二元组回退） | ✅ 完成（当前版本） |
| P3.5 | 双档模型（快速/质量）、预采集防抖、性能基准用例 | 待做 |

## 设计要点

- **零构建**：纯 ESM JavaScript，唯一依赖 schemastery 打包在包内，无工具链要求
- **进程内调用**：`ctx.llm.stream()` 直连；子进程只有 git / ripgrep 两种一次性调用（各 1.5s 硬超时，对比 cc-gui 每次 fork Node 的泄漏教训）
- **上下文全部来自 DSH 内部**：`ctx.sessionQuery.filterEvents`（tool/call 事件）、`readSurface`（cwd）、@ 引用语法解析、有界目录遍历、清单/README 读取、git status/diff/log、关键词检索（DSH 自带 ripgrep 优先，缺失时进程内扫描兜底）——不依赖任何外部 MCP
- **单次生成定稿**：没有提问往返、没有二次改写；上下文在生成前一次采齐
- **增强失败永不阻塞**：超时/出错时原始草稿不动，用户始终可以发送原文
