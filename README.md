# dsh-prompt-enhancer

DeepSeek Harness (DSH) 提示词增强插件：把模糊的提示词草稿改写为结构化、可直接执行的高质量提示词。

## 当前状态：P0（最小可用）

- ✅ `/enhance <草稿>` 斜杠命令——纯 LLM 改写，流式调用，带耗时 meta
- ✅ 模型路由默认跟随当前会话（`session.requestHeader()`），可在配置中显式指定 `provider`+`model`
- ✅ 30s 硬超时 + 结果缓存（同草稿重复增强零耗时）
- ✅ 反幻觉系统提示词（不确定处标记 ❓待确认，禁止编造路径/API）
- ✅ 已在真实 loader 中验证加载（rescue profile 启动 + apply 标记验证）

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
| `maxOutputTokens` | 800 | 增强输出 token 上限 |
| `timeoutMs` | 30000 | 单次增强端到端超时 |
| `systemPromptExtra` | 空 | 追加到增强系统提示词的自定义指令 |

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 命令骨架 + 纯 LLM 改写 + 路由跟随 + 超时/缓存 | ✅ 完成 |
| P1 | 输入框增强按钮（`conversation.input.activity` 插槽）+ `InputActions.insertText` 草稿回写 + 流式预览 UI | 待做 |
| P2 | DSH 内部上下文采集：会话最近工具事件（`ctx.sessionQuery`）、@ 引用解析、git 改动、项目类型；三档策略路由（T1 锚定 / T2 项目感知 / T3 绿地规格化） | 待做 |
| P3 | 双档模型（快速/质量）、预采集防抖、性能基准用例 | 待做 |

## 设计要点

- **零构建**：纯 ESM JavaScript，唯一依赖 schemastery 打包在包内，无工具链要求
- **进程内调用**：`ctx.llm.stream()` 直连，无子进程（对比 cc-gui 每次 fork Node 的泄漏教训）
- **增强失败永不阻塞**：超时/出错时原始草稿不动，用户始终可以发送原文
