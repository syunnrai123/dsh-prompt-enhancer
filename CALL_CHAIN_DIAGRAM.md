# dsh-prompt-enhancer 调用链与数据流图

## 触发路径

```
用户操作
  │
  ├─ 路径 A: 输入 /enhance <草稿>
  │    └─→ lib/index.js:1489 commands.register()
  │         └─→ handler(invocation) @ 1493
  │
  └─ 路径 B: 点击火花按钮 ✨
       └─→ lib/client.js:210 onClick()
            └─→ remote.commands.execute(sessionId, line, []) @ 218
                 └─→ 服务端路由到同一个 handler @ lib/index.js:1493
```

**关键发现**：两条路径最终执行**同一个命令处理器**，无分支差异。

---

## 完整调用链（lib/index.js）

```
┌─────────────────────────────────────────────────────────────┐
│  handler(invocation)                             @ 1493     │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 1. 解析配置与超时预算                     @ 1498-1507 │  │
│  │    withDeadline(signal, normalizeTimeout(config))      │  │
│  └───────────────────────────────────────────────────────┘  │
│                         ↓                                    │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 2. 采集工作区信号                         @ 1508      │  │
│  │    signals = await gatherSignals(...)                  │  │
│  │                                                          │  │
│  │    ┌──────────────────────────────────────────────┐    │  │
│  │    │ gatherSignals() @ 1007-1063                  │    │  │
│  │    │  • 读取 cwd                                   │    │  │
│  │    │  • gatherRefFiles(draft) → 解析 @-引用       │    │  │
│  │    │  • gatherRecentFiles() → 会话操作历史        │    │  │
│  │    │  • gatherGit() → 未提交改动                  │    │  │
│  │    │  • walkWorkspace() → 目录树骨架              │    │  │
│  │    │  • manifestCandidates() → package.json 等   │    │  │
│  │    │  • readmeCandidates() → README.md           │    │  │
│  │    │  • gatherEntityHits() → 关键词定位文件       │    │  │
│  │    │  • gatherGitLog() → 提交历史                 │    │  │
│  │    │  返回 signals 对象（8 个字段）                │    │  │
│  │    └──────────────────────────────────────────────┘    │  │
│  └───────────────────────────────────────────────────────┘  │
│                         ↓                                    │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 3. 档位路由                               @ 1509      │  │
│  │    tier = routeTier(signals, pathMentions)             │  │
│  │                                                          │  │
│  │    ┌──────────────────────────────────────────────┐    │  │
│  │    │ routeTier() @ 1238-1247                      │    │  │
│  │    │  • T0: signals === undefined (禁用)          │    │  │
│  │    │  • T3: cwd 缺失 或 空工作区                  │    │  │
│  │    │  • T1: @-引用命中 或 路径提及与会话/git 交叉 │    │  │
│  │    │  • T2: 其他（有项目但无锚点）                │    │  │
│  │    └──────────────────────────────────────────────┘    │  │
│  └───────────────────────────────────────────────────────┘  │
│                         ↓                                    │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 4. 组装上下文包                           @ 1510      │  │
│  │    pack = buildPack(signals, tier, maxChars)           │  │
│  │                                                          │  │
│  │    ┌──────────────────────────────────────────────┐    │  │
│  │    │ buildPack() @ 1255-1316                      │    │  │
│  │    │                                               │    │  │
│  │    │  T1 档位输出（锚定）:                        │    │  │
│  │    │    ├─ [引用文件] @ 1268-1275                 │    │  │
│  │    │    ├─ [工作区骨架] @ 1277-1278               │    │  │
│  │    │    ├─ [关键词定位文件] @ 1279-1284           │    │  │
│  │    │    ├─ [本会话最近操作] @ 1292-1294           │    │  │
│  │    │    └─ [git 未提交改动] @ 1296-1300           │    │  │
│  │    │                                               │    │  │
│  │    │  T2 档位输出（项目感知）:                    │    │  │
│  │    │    ├─ [项目清单要点] @ 1302-1306             │    │  │
│  │    │    ├─ [README 摘要] @ 1307-1309              │    │  │
│  │    │    ├─ [测试线索] @ 1310-1311                 │    │  │
│  │    │    ├─ [git 提交历史] @ 1312-1314             │    │  │
│  │    │    └─ [关键词定位文件] @ 1279-1284           │    │  │
│  │    │                                               │    │  │
│  │    │  T3/T0: 返回空字符串                         │    │  │
│  │    └──────────────────────────────────────────────┘    │  │
│  └───────────────────────────────────────────────────────┘  │
│                         ↓                                    │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 5. 执行增强                               @ 1522      │  │
│  │    result = await runEnhancement(...)                  │  │
│  │                                                          │  │
│  │    ┌──────────────────────────────────────────────┐    │  │
│  │    │ runEnhancement() @ 1318-1359                 │    │  │
│  │    │  ↓                                            │    │  │
│  │    │ enhance() @ 1365-1407                        │    │  │
│  │    │  ↓                                            │    │  │
│  │    │ 【关键】frameDraft(draft, pack) @ 1376      │    │  │
│  │    │                                               │    │  │
│  │    │  ┌────────────────────────────────────────┐  │    │  │
│  │    │  │ frameDraft() @ 196-200                 │  │    │  │
│  │    │  │                                         │  │    │  │
│  │    │  │  base = "Enhance this draft prompt     │  │    │  │
│  │    │  │          (JSON-encoded):\n"            │  │    │  │
│  │    │  │          + JSON.stringify({ draft })   │  │    │  │
│  │    │  │                                         │  │    │  │
│  │    │  │  if (pack.length === 0) return base    │  │    │  │
│  │    │  │                                         │  │    │  │
│  │    │  │  return base + "\n\n"                  │  │    │  │
│  │    │  │         + "--- context pack ---\n"     │  │    │  │
│  │    │  │         + pack                          │  │    │  │
│  │    │  │         + "\n--- end ---"               │  │    │  │
│  │    │  └────────────────────────────────────────┘  │    │  │
│  │    │                                               │    │  │
│  │    │  ↓                                            │    │  │
│  │    │ ctx.llm.stream(options) @ 1387               │    │  │
│  │    │   options.messages[0].content[0].text        │    │  │
│  │    │   = frameDraft() 的返回值                    │    │  │
│  │    └──────────────────────────────────────────────┘    │  │
│  └───────────────────────────────────────────────────────┘  │
│                         ↓                                    │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 6. 返回结果                               @ 1527-1537 │  │
│  │    { status: 'ok', text, meta, cached }                │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 数据流：从采集到模型

```
gatherSignals()
  ↓
  返回 signals 对象:
  {
    cwd: string,
    refFiles: [{ path, content, meta }],  ← @-引用文件
    recent: { files, toolCount },         ← 会话操作历史
    git: { changed, diffStat },           ← 未提交改动
    project: { labels, entryCount },      ← 项目特征
    workspace: { skeleton, files },       ← 目录树
    manifests: string,                    ← package.json 等解析结果
    readme: { file, text },               ← README 内容
    entities: { hits, searched }          ← 关键词定位结果
  }
  ↓
routeTier(signals, pathMentions)
  ↓
  返回 tier: 'T0' | 'T1' | 'T2' | 'T3'
  ↓
buildPack(signals, tier, maxChars)
  ↓
  拼接多段文本:
  "[引用文件]\n- path\n```\ncontent\n```\n[已压缩: ...]"
  + "[工作区骨架]\n..."
  + "[项目清单要点]\n..."
  + "[README 摘要]\n..."
  + ...
  ↓
  返回 pack: string (≤ maxChars)
  ↓
frameDraft(draft, pack)
  ↓
  返回完整 prompt:
  "Enhance this draft prompt (JSON-encoded):\n{\"draft\":\"...\"}\n\n--- context pack (verified facts only) ---\n[引用文件]\n...\n--- end of context pack ---"
  ↓
ctx.llm.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 上述 prompt }] }] })
  ↓
模型接收到的 prompt 包含完整的 draft + context pack
```

---

## 缓存机制

```
缓存键生成 @ lib/index.js:1514
  ↓
  routeKey = JSON.stringify([
    draft,              ← 用户输入
    resolved.provider,  ← 模型提供商
    resolved.model,     ← 模型名称
    tier,               ← T0/T1/T2/T3
    digest(pack)        ← pack 内容的 SHA-256 摘要（前 12 字符）
  ])
  ↓
缓存查询 @ lib/index.js:1515-1517
  ↓
  if (cached) return { status: 'ok', text: cached.text, meta, cached: true }
  ↓
  否则执行 runEnhancement() 并写入缓存
```

**关键性质**：
- ✅ 缓存键包含 `digest(pack)`，pack 内容变化必定失效
- ✅ 空 pack 与非空 pack 的 digest 不同（空 pack → `digest('')`）
- ✅ 缓存命中时返回的 `cached.text` 是之前已包含 pack 的增强结果
- ✅ **不存在"采集被跳过但返回看似正常结果"的情况**

---

## 超时覆盖范围

```
withDeadline(signal, timeout) @ lib/index.js:1505
  ↓
  deadline = {
    signal: AbortSignal,  ← 带超时的取消信号
    remaining: number     ← 剩余毫秒数
  }
  ↓
传递到采集阶段:
  gatherSignals(..., deadline.signal) @ 1508
    ↓ 信号传递给所有子采集函数
    gatherRefFiles(..., signal)
    gatherGit(..., signal)
    walkWorkspace(..., signal)
    ...
  ↓
传递到生成阶段:
  runEnhancement(..., deadline.signal) @ 1522
    ↓
    enhance(..., signal)
      ↓
      ctx.llm.stream({ signal }) @ 1387
  ↓
超时触发:
  signal.throwIfAborted() @ 多处检查点
  ↓ 抛出 AbortError
  ↓
handler 捕获 @ 1530-1531
  ↓
  return { status: 'error', error: finishError(e), meta }
```

**关键性质**：
- ✅ 超时覆盖采集 + 生成 + 重试全流程
- ✅ 超时不会导致跳过采集，只会在中途抛错
- ✅ 用户会看到明确的错误信息，不会静默失败

---

## 档位路由决策树

```
signals === undefined?
  ├─ 是 → T0 (contextEnabled: false)
  └─ 否 ↓

signals.cwd === undefined?
  ├─ 是 → T3 (无工作目录)
  └─ 否 ↓

signals.project.entryCount === 0 && signals.git.changedCount === 0?
  ├─ 是 → T3 (空工作区)
  └─ 否 ↓

signals.refFiles.length > 0?
  ├─ 是 → T1 (有 @-引用)
  └─ 否 ↓

草稿中的路径提及 ∩ (会话操作文件 ∪ git 改动文件) ≠ ∅?
  ├─ 是 → T1 (路径锚定)
  └─ 否 → T2 (项目感知)
```

---

## 文件压缩策略

```
compressFileContent(path, content, maxChars)
  ↓
shouldSkipContent(path)?  ← package-lock.json, *.min.js, 二进制
  ├─ 是 → 返回 { content: '', meta: '[已跳过内容: ...]' }
  └─ 否 ↓

content.length ≤ maxChars?
  ├─ 是 → 返回 { content: 原文, meta: undefined }
  └─ 否 ↓

detectLanguage(path)
  ↓
extractOutline(content, lang) → outline 数组
  ↓
outlineBudget = maxChars * 0.3
contentBudget = maxChars - outlineBudget
  ↓
compressHeadTail(content, contentBudget)
  ↓ 60% 头 + 40% 尾 + "… 省略 N 行 …"
  ↓
合并 outline + headTail
  ↓
添加 meta: '[已压缩: 原文 X 行/Y 字节 → 保留 Z 行]'
  ↓
返回 { content: 压缩后内容, meta }
```

---

## 验证方法

### 方法 1：运行测试套件
```bash
cd dsh-prompt-enhancer
npm test
```
预期：31 个测试全部通过，包含 10 个端到端验证用例。

### 方法 2：运行快速验证脚本
```bash
cd dsh-prompt-enhancer
node verify-context-works.mjs
```
预期：输出 "✅ 所有验证通过！上下文采集完全生效。"

### 方法 3：手动检查调用链
1. 在 `lib/index.js:1376` 行设置断点（`frameDraft(draft, pack)`）
2. 触发 `/enhance @src/app.js` 命令
3. 观察 `pack` 参数内容
4. 单步执行到 `ctx.llm.stream(options)`
5. 查看 `options.messages[0].content[0].text` 是否包含 pack

---

**文档版本**：2026-10-04  
**对应代码版本**：dsh-prompt-enhancer (当前 main 分支)
