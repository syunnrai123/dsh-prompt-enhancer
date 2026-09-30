# dsh-prompt-enhancer

DeepSeek Harness (DSH) 提示词增强插件：结合工作区上下文，把模糊的提示词草稿改写为结构化、可直接执行的高质量提示词。

## 当前状态：P2（上下文感知）

- ✅ `/enhance <草稿>` 命令 + 输入框火花按钮（星星随草稿状态变色：空 `#0E6FEA` / 有词 `#E31D34`）
- ✅ 结果面板（滑入动效、复制 / 替换草稿 / 关闭、pending / error / success 三态）
- ✅ 模型路由默认跟随当前会话（`session.requestHeader()`），可配置覆盖
- ✅ 30s 硬超时 + 结果缓存（草稿+路由+上下文摘要键）
- ✅ **P2 三档上下文策略**（全部 DSH 内部能力，进程内零常驻子进程）：

| 档位 | 触发条件 | 注入内容 | 系统提示词 |
|---|---|---|---|
| T1 锚定 | @ 引用命中文件，或草稿实体与本会话最近操作文件 / git 改动相交 | 引用文件内容(≤2000字/个，≤3个) + 最近操作文件(≤8) + git status/diff --stat + 项目类型 | 锚定模式（引用已验证事实，不确定标"待确认"） |
| T2 项目感知 | 工作区有代码但无锚点（典型=未实现的新功能） | 仅项目级事实（构建文件探测） | 锚定模式 |
| T3 绿地规格 | 空工作区 / 无 cwd | 不注入任何内容 | 绿地规格模式（目标/需求/边界/验收标准/待确认） |

- ✅ 反幻觉红线：系统提示词强制"只引用上下文包中确实存在的内容"
- ✅ 信号采集全部容错（git 缺失 / 文件不可读 / sessionQuery 异常都静默降级，增强永不因此失败）
- ✅ meta 行展示档位与信号摘要：`增强完成 · T1 锚定 · 模型 x/y · 首 token · 总计 · tokens · 引用文件 1 · 近期文件 5 · git改动 3`
- ✅ 28 项纯函数单测（`node test/internals.test.mjs`）

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
| `maxContextChars` | 6000 | 上下文包总字符预算 |
| `recentToolScan` | 40 | 扫描最近多少条 tool/call 事件提取操作文件 |

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 命令骨架 + 纯 LLM 改写 + 路由跟随 + 超时/缓存 | ✅ 完成 |
| P1 | 输入框按钮 + 草稿回写 + 结果面板 | ✅ 完成 |
| P2 | DSH 内部上下文采集 + 三档策略路由 | ✅ 完成 |
| P2.5 | 草稿实体 ripgrep 反查（零命中时兜底定位相关文件） | 待做 |
| P3 | 双档模型（快速/质量）、预采集防抖、性能基准用例 | 待做 |

## 设计要点

- **零构建**：纯 ESM JavaScript，唯一依赖 schemastery 打包在包内，无工具链要求
- **进程内调用**：`ctx.llm.stream()` 直连，无子进程（对比 cc-gui 每次 fork Node 的泄漏教训）
- **上下文全部来自 DSH 内部**：`ctx.sessionQuery.filterEvents`（tool/call 事件）、`readSurface`（cwd）、@ 引用语法解析、git status/diff（一次性子进程，1.5s 超时）、构建文件探测——不依赖任何外部 MCP
- **增强失败永不阻塞**：超时/出错时原始草稿不动，用户始终可以发送原文
