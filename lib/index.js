/**
 * dsh-prompt-enhancer — P0: `/enhance` slash command.
 *
 * Rewrites a vague draft prompt into a structured, self-contained prompt through
 * an auxiliary `ctx.llm.stream()` call. Model route follows the current session's
 * logged `request/header` route unless the profile config pins `provider`+`model`.
 *
 * P1 will add the composer button + draft write-back (`InputActions.insertText`)
 * and streaming preview; P2 adds DSH-internal context gathering (session events,
 * @-references, git, ripgrep). This file deliberately has zero imports beyond
 * schemastery so it loads in any profile without a build step.
 */

import z from '@deepseek-ai/schemastery';

const name = 'prompt-enhancer';
const inject = ['llm', 'commands'];

const TIMEOUT_CODE = 'PROMPT_ENHANCE_TIMEOUT';
const CACHE_LIMIT = 32;

const Config = z.object({
  /** Explicit enhancement route; both fields must be supplied together. */
  provider: z.string(),
  model: z.string(),
  /** Auxiliary generation token cap. */
  maxOutputTokens: z.natural().default(800),
  /** End-to-end deadline for one enhancement call, milliseconds. */
  timeoutMs: z.natural().default(30_000),
  /** Extra instructions appended to the enhancement system prompt. */
  systemPromptExtra: z.string(),
});

/** Enhancement instruction: rewrite only, never fabricate, keep language. */
function systemPrompt(extra) {
  const lines = [
    'You are a prompt-enhancement engine inside an AI coding harness.',
    'Rewrite the supplied draft prompt so an autonomous coding agent can act on it without guessing.',
    '',
    'Rules:',
    '- Respond with the enhanced prompt ONLY. No preamble, no explanation, no quotes around the whole answer.',
    '- Keep the language of the draft (a Chinese draft stays Chinese; an English draft stays English).',
    '- Preserve every concrete detail, path, identifier, and constraint the drafter already gave; never drop or alter them.',
    '- Never invent facts, file paths, APIs, or requirements. Anything uncertain becomes a clearly marked open question, e.g. "待确认: ..." / "OPEN QUESTION: ...". Do not use emoji anywhere.',
    '- Resolve vagueness into structure. When it helps, organize with short Markdown sections such as 目标 / 背景 / 需求 / 边界与约束 / 验收标准 / 待确认问题 (or the draft language equivalents).',
    '- Calibrate effort to the draft: an already-precise draft gets light edits only; a one-line idea gets a full specification. Do not pad.',
    '- Address the agent directly and imperatively; keep it concise enough to read at a glance.',
  ];
  if (extra && extra.trim()) lines.push('', extra.trim());
  return lines.join('\n');
}

/** Frame the draft as JSON so its text cannot break the framing. */
function frameDraft(draft) {
  return `Enhance this draft prompt (JSON-encoded):\n${JSON.stringify({ draft })}`;
}

/** Translate terminal finish reasons into an enhancement failure. */
function finishError(finish) {
  switch (finish?.kind) {
    case undefined:
    case 'stop':
      return undefined;
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure?.message ?? String(finish.kind));
      error.code = finish.failure?.code;
      return error;
    }
    case 'max-tokens':
      return new Error('prompt-enhancer: 增强输出达到 maxOutputTokens 上限，请调大配置或精简草稿');
    case 'tool-calls':
      return new Error('prompt-enhancer: 增强模型意外请求了工具调用（应当只输出文本）');
    default:
      return new Error(`prompt-enhancer: 不支持的结束原因 "${String(finish?.kind)}"`);
  }
}

/** Resolve the enhancement route: explicit pair, else the session's logged route. */
function resolveRoute(config, agent) {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model, source: 'config' };
  }
  if (config.provider !== undefined || config.model !== undefined) {
    throw new Error('prompt-enhancer: provider 与 model 必须成对配置（要么都填，要么都不填以跟随当前会话模型）');
  }
  const route = agent?.session?.requestHeader()?.config;
  if (route?.provider === undefined || route?.model === undefined) {
    throw new Error('prompt-enhancer: 当前会话还没有已记录的模型路由——请先发送一条消息，或在插件配置中显式指定 provider + model');
  }
  return { provider: route.provider, model: route.model, source: 'session' };
}

/** Compose the invocation signal with a timeout deadline. */
function withDeadline(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error(`prompt-enhancer: 增强超时（${timeoutMs}ms），已中止。可直接发送原始草稿。`);
    error.code = TIMEOUT_CODE;
    controller.abort(error);
  }, timeoutMs);
  const forward = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  if (signal) {
    if (signal.aborted) forward(signal.reason);
    else signal.addEventListener('abort', () => forward(signal.reason), { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forward);
    },
  };
}

/** Tiny LRU keyed by draft+route so repeated enhancement of the same draft is free. */
function createCache(limit) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value); // refresh recency
      return value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      if (map.size > limit) map.delete(map.keys().next().value);
    },
  };
}

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * Run one enhancement and return the assembled text plus timing facts.
 * Streaming keeps first-token latency visible to the caller for P1 preview UI.
 */
async function enhance(ctx, config, agent, draft, onDelta, signal) {
  const started = Date.now();
  const route = resolveRoute(config, agent);
  const deadline = withDeadline(signal, config.timeoutMs);
  try {
    let firstTokenMs;
    let sawToolCall = false;
    let finish;
    let usage;
    let text = '';
    const options = {
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: frameDraft(draft) }] }],
      system: systemPrompt(config.systemPromptExtra),
      maxTokens: config.maxOutputTokens,
      signal: deadline.signal,
    };
    if (agent?.session?.id !== undefined) options.sessionId = agent.session.id;
    deadline.signal.throwIfAborted();
    for await (const chunk of ctx.llm.stream(options)) {
      deadline.signal.throwIfAborted();
      switch (chunk.type) {
        case 'text-delta':
          if (firstTokenMs === undefined) firstTokenMs = Date.now() - started;
          text += chunk.text;
          onDelta?.(chunk.text, text);
          break;
        case 'tool-call-delta':
          sawToolCall = true;
          break;
        case 'usage':
          usage = chunk.usage;
          break;
        case 'finish':
          finish = chunk.reason;
          break;
        default:
          break; // block-start / block-end / reasoning-delta: not needed for text assembly
      }
    }
    deadline.signal.throwIfAborted();
    const terminal = finishError(finish);
    if (terminal !== undefined) throw terminal;
    if (sawToolCall) throw new Error('prompt-enhancer: 增强输出包含工具调用（应当只输出文本）');
    const enhanced = text.trim();
    if (enhanced.length === 0) throw new Error('prompt-enhancer: 增强模型没有产生文本');
    const totalMs = Date.now() - started;
    const meta = [
      `增强完成`,
      `模型 ${route.provider}/${route.model}（${route.source === 'config' ? '配置指定' : '跟随会话'}）`,
      `首token ${fmtMs(firstTokenMs ?? totalMs)}`,
      `总计 ${fmtMs(totalMs)}`,
    ];
    if (usage !== undefined) meta.push(`tokens ${usage.inputTokens ?? '?'}/${usage.outputTokens ?? '?'}`);
    return { text: enhanced, meta: meta.join(' · '), totalMs };
  } finally {
    deadline.dispose();
  }
}

function apply(ctx, config) {
  const cache = createCache(CACHE_LIMIT);

  ctx.commands.register({
    name: 'enhance',
    description: '提示词增强：把模糊草稿改写为结构化、可直接执行的提示词',
    input: { hint: '<提示词草稿>' },
    async handler(invocation) {
      const { agent, rawInput } = invocation ?? {};
      const signal = invocation?.signal;
      const draft = (rawInput ?? '').trim();
      if (draft.length === 0) {
        return {
          kind: 'error',
          text: '用法：/enhance <提示词草稿>。草稿为空——请把要增强的内容直接跟在命令后面（P1 将支持一键增强输入框当前草稿）。',
        };
      }
      let routeKey;
      try {
        const resolved = resolveRoute(config, agent);
        routeKey = JSON.stringify([draft, resolved.provider, resolved.model]);
      } catch {
        routeKey = undefined; // route errors surface below in the real call
      }
      const cached = routeKey === undefined ? undefined : cache.get(routeKey);
      if (cached !== undefined) {
        return { kind: 'success', text: `${cached.text}\n\n---\n缓存命中 · ${cached.meta}` };
      }
      try {
        const result = await enhance(ctx, config, agent, draft, undefined, signal);
        if (routeKey !== undefined) cache.set(routeKey, result);
        return { kind: 'success', text: `${result.text}\n\n---\n${result.meta}` };
      } catch (error) {
        if (error?.code === TIMEOUT_CODE || error?.name === 'AbortError' || signal?.aborted) {
          return { kind: 'error', text: error?.message ?? 'prompt-enhancer: 已取消' };
        }
        return { kind: 'error', text: `增强失败：${error?.message ?? String(error)}\n原始草稿未被修改，可直接发送。` };
      }
    },
  });
}

export { Config, apply, inject, name };
