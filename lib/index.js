/**
 * dsh-prompt-enhancer — P2: `/enhance` slash command with DSH-internal context.
 *
 * Rewrites a vague draft prompt into a structured, self-contained prompt through
 * an auxiliary `ctx.llm.stream()` call. Model route follows the current session's
 * logged `request/header` route unless the profile config pins `provider`+`model`.
 *
 * P2 context tiers (all signals gathered from DSH internals, in-process):
 *  - T1 anchored: draft has @refs / entity hits in recent tool events or git changes
 *  - T2 project-aware: workspace has code but no anchors (unimplemented features)
 *  - T3 greenfield: empty workspace / no signals -> pure specification rewrite
 *
 * Anti-hallucination: the system prompt only ever cites the verified context
 * pack; anything uncertain becomes a marked open question.
 */

import z from '@deepseek-ai/schemastery';
import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const name = 'prompt-enhancer';
const inject = ['llm', 'commands', 'sessionQuery'];

const TIMEOUT_CODE = 'PROMPT_ENHANCE_TIMEOUT';
const CACHE_LIMIT = 32;

// Context budgets (characters) — mirrors the cc-gui limiter philosophy.
const REF_FILE_BUDGET = 2000;
const REF_FILE_MAX = 3;
const REF_FILE_SKIP_BYTES = 512 * 1024;
const RECENT_FILES_MAX = 8;
const GIT_STATUS_MAX = 20;
const GIT_DIFF_BUDGET = 1200;
const PACK_BUDGET_DEFAULT = 6000;
const GIT_TIMEOUT_MS = 1500;
const TOOL_SCAN_DEPTH = 40;
/** Truncated output retries once with a doubled cap, never above this ceiling. */
const MAX_RETRY_TOKENS = 8000;
/** A truncated result below this many characters is noise, not a usable rewrite. */
const MIN_USABLE_PARTIAL = 120;

const Config = z.object({
	/** Explicit enhancement route; both fields must be supplied together. */
	provider: z.string(),
	model: z.string(),
	/** Auxiliary generation token cap. Reasoning tokens share this budget. */
	maxOutputTokens: z.natural().default(2000),
	/** End-to-end deadline for one enhancement call, milliseconds. */
	timeoutMs: z.natural().default(30_000),
	/** Reasoning effort for the auxiliary call; 'off' keeps the budget for the rewrite. Empty string omits the field. */
	reasoningEffort: z.string().default('off'),
	/** Extra instructions appended to the enhancement system prompt. */
	systemPromptExtra: z.string(),
	/** Master switch for DSH-internal context gathering (tiers T1/T2). */
	contextEnabled: z.boolean().default(true),
	/** Total character budget for the assembled context pack. */
	maxContextChars: z.natural().default(PACK_BUDGET_DEFAULT),
	/** How many recent tool/call events to scan for touched files. */
	recentToolScan: z.natural().default(TOOL_SCAN_DEPTH),
});

/** Enhancement instruction: rewrite only, never fabricate, keep language. */
function basePromptRules() {
	return [
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
}

/** T1/T2 system prompt: a verified context pack will accompany the draft. */
function anchoredPrompt(extra) {
	const lines = [
		...basePromptRules(),
		'',
		'Context handling:',
		'- The user message ends with a context pack of VERIFIED facts gathered from this workspace (referenced files, recently touched files, git changes, project type).',
		'- Use the pack as grounding: you may cite its paths and facts in a "背景事实（已验证）" section. Cite ONLY what the pack states — never expand, guess, or invent beyond it.',
		'- Anything the pack does not answer becomes a marked open question (待确认), never an assumption.',
		'- If the pack is irrelevant to the draft, ignore it silently and enhance from the draft alone.',
	];
	if (extra && extra.trim()) lines.push('', extra.trim());
	return lines.join('\n');
}

/** T3 system prompt: greenfield specification rewrite, no context. */
function greenfieldPrompt(extra) {
	const lines = [
		...basePromptRules(),
		'',
		'Greenfield mode:',
		'- No workspace context is available (empty or new project), so enhance purely from the draft\'s own content.',
		'- Turn the idea into a complete specification: 目标 / 需求 / 边界与约束 / 验收标准 / 待确认问题. Propose sensible technical defaults but mark every assumption as 待确认.',
		'- End with a short "执行方式" note telling the agent to inspect the workspace state first before writing code.',
	];
	if (extra && extra.trim()) lines.push('', extra.trim());
	return lines.join('\n');
}

/** Frame the draft as JSON so its text cannot break the framing. */
function frameDraft(draft, pack) {
	const base = `Enhance this draft prompt (JSON-encoded):\n${JSON.stringify({ draft })}`;
	if (pack === undefined || pack.length === 0) return base;
	return `${base}\n\n--- context pack (verified facts only) ---\n${pack}\n--- end of context pack ---`;
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

/** Tiny LRU keyed by draft+route+context so repeated enhancement is free. */
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

/** Cheap stable string digest for cache keys (not cryptographic). */
function digest(text) {
	let h1 = 0x811c9dc5;
	let h2 = 0x1000193;
	for (let i = 0; i < text.length; i += 7) {
		h1 = (h1 ^ text.charCodeAt(i)) * 0x01000193 >>> 0;
		h2 = (h2 + text.charCodeAt(text.length - 1 - i)) >>> 0;
	}
	return `${h1.toString(36)}-${h2.toString(36)}-${text.length}`;
}

// ── signal gathering (every gather is failure-tolerant) ─────────────────────

/** Extract @path / @"quoted path" mentions from the draft (file-reference grammar:
 *  the @ token starts at input start or after whitespace, so emails stay untouched). */
function extractAtRefs(draft) {
	const refs = [];
	const seen = new Set();
	const re = /(?<=^|\s)@"([^"\n]+)"|(?<=^|\s)@([A-Za-z0-9_.\-/\\:]+)/g;
	for (const m of draft.matchAll(re)) {
		const ref = (m[1] ?? m[2] ?? '').trim();
		if (ref.length === 0 || seen.has(ref)) continue;
		seen.add(ref);
		refs.push(ref);
		if (refs.length >= 5) break;
	}
	return refs;
}

/** Extract path-like tokens the drafter typed (backticked or ext.path forms). */
function extractPathMentions(draft) {
	const out = [];
	const seen = new Set();
	const push = (value) => {
		const v = value.trim().replace(/[，。；、）)]+$/u, '');
		if (v.length < 3 || v.length > 200 || seen.has(v)) return;
		seen.add(v);
		out.push(v);
	};
	for (const m of draft.matchAll(/`([^`\n]+)`/g)) push(m[1]);
	for (const m of draft.matchAll(/(?:[A-Za-z0-9_\-./\\]*\/)?[A-Za-z0-9_.\-]+\.[A-Za-z]{1,6}\b/g)) {
		if (m[0].includes('/')) push(m[0]);
	}
	return out.slice(0, 5);
}

/** Normalize separators so suffix matching works across / and \ forms. */
function normPath(p) {
	return p.replace(/\\/g, '/').toLowerCase();
}

/** Read @-referenced files with bounded content.
 *  Resolution order: absolute/cwd-relative exact path, then a suffix match
 *  against known touched files (handles drafts written relative to a
 *  subdirectory, e.g. "lib/client.js" -> ".../dsh-prompt-enhancer/lib/client.js").
 *  Returns resolved files plus the refs that hit nothing. */
async function gatherRefFiles(cwd, refs, knownPaths) {
	const files = [];
	const misses = [];
	const known = knownPaths.map(normPath);
	for (const ref of refs.slice(0, REF_FILE_MAX + 2)) {
		if (files.length >= REF_FILE_MAX) {
			misses.push(ref);
			continue;
		}
		try {
			let path = isAbsolute(ref) ? ref : resolve(cwd, ref);
			let exists = false;
			try {
				const info = await stat(path);
				exists = info.isFile();
			} catch { exists = false; }
			if (!exists) {
				// Suffix fallback: the ref may be relative to a subdirectory.
				const target = normPath(ref);
				const hit = known.find((k) => k === target || k.endsWith(`/${target}`));
				if (hit !== undefined) path = knownPaths[known.indexOf(hit)];
				else {
					misses.push(ref);
					continue;
				}
			}
			const info = await stat(path);
			if (!info.isFile() || info.size > REF_FILE_SKIP_BYTES) {
				misses.push(ref);
				continue;
			}
			const content = await readFile(path, 'utf8');
			if (content.length === 0) {
				misses.push(ref);
				continue;
			}
			files.push({ path: ref, resolved: path, content: content.length > REF_FILE_BUDGET ? `${content.slice(0, REF_FILE_BUDGET)}\n... (truncated)` : content });
		} catch { /* unreadable: count as miss */ misses.push(ref); }
	}
	return { files, misses };
}

/** Pull file paths out of one tool/call document text ("<name>\n<json-args>"). */
function pathsFromToolDoc(text) {
	const sep = text.search(/\s/);
	if (sep === -1) return [];
	const tool = text.slice(0, sep);
	if (!/^(read|write|edit|str-replace-editor|glob|grep|notebook)/.test(tool)) return [];
	try {
		const args = JSON.parse(text.slice(sep + 1));
		const values = [];
		for (const key of ['file_path', 'path', 'absolute_path', 'notebook_path']) {
			const value = args?.[key];
			if (typeof value === 'string' && value.length > 0) values.push(value);
		}
		return values;
	} catch {
		return [];
	}
}

/** Recent touched files from the session log's tool/call events (newest first). */
async function gatherRecentFiles(ctx, sessionId, scanDepth) {
	if (sessionId === undefined) return { files: [], toolCount: 0 };
	const docs = await ctx.sessionQuery.filterEvents(String(sessionId), [{ kind: 'type', values: ['tool/call'] }]);
	const tail = docs.slice(-scanDepth);
	const files = [];
	const seen = new Set();
	for (const doc of tail.reverse()) {
		for (const p of pathsFromToolDoc(doc.text)) {
			if (seen.has(p)) continue;
			seen.add(p);
			files.push(p);
			if (files.length >= RECENT_FILES_MAX) return { files, toolCount: docs.length };
		}
	}
	return { files, toolCount: docs.length };
}

/** Run git with a hard timeout; resolves undefined when git or repo is absent. */
function git(cwd, args) {
	return new Promise((resolvePromise) => {
		execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 512 }, (error, stdout) => {
			resolvePromise(error ? undefined : stdout);
		});
	});
}

/** Uncommitted-change summary: status lines + diff stat (current intent signal). */
async function gatherGit(cwd) {
	const status = await git(cwd, ['status', '--porcelain']);
	if (status === undefined) return { changed: [], diffStat: '', changedCount: 0 };
	const changed = status.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
	const diffStat = (await git(cwd, ['diff', 'stat', 'HEAD'])) ?? '';
	return {
		changed: changed.slice(0, GIT_STATUS_MAX),
		diffStat: diffStat.length > GIT_DIFF_BUDGET ? `${diffStat.slice(0, GIT_DIFF_BUDGET)}... (truncated)` : diffStat.trim(),
		changedCount: changed.length,
	};
}

const MANIFEST_HINTS = new Map([
	['package.json', 'Node.js / npm'],
	['pnpm-workspace.yaml', 'Node.js / pnpm'],
	['tsconfig.json', 'TypeScript'],
	['pom.xml', 'Java / Maven'],
	['build.gradle', 'Java / Gradle'],
	['build.gradle.kts', 'Java / Gradle'],
	['Cargo.toml', 'Rust / Cargo'],
	['go.mod', 'Go'],
	['requirements.txt', 'Python / pip'],
	['pyproject.toml', 'Python'],
	['composer.json', 'PHP / Composer'],
	['Gemfile', 'Ruby'],
	['CMakeLists.txt', 'C/C++ / CMake'],
	['Makefile', 'Make'],
]);

/** Project type from manifest files plus a top-level entry count. */
async function gatherProject(cwd) {
	const entries = await readdir(cwd).catch(() => []);
	const hits = [];
	for (const [file, label] of MANIFEST_HINTS) {
		if (entries.includes(file) && !hits.includes(label)) hits.push(label);
	}
	return { labels: hits.slice(0, 2), entryCount: entries.length };
}

/** Gather every signal; individual failures degrade silently. */
async function gatherSignals(ctx, config, agent, draft) {
	if (!config.contextEnabled) return undefined;
	const sessionId = agent?.session?.id;
	const cwd = await (async () => {
		if (sessionId === undefined) return undefined;
		try {
			const surface = await ctx.sessionQuery.readSurface(String(sessionId));
			const value = surface?.session?.cwd;
			return typeof value === 'string' && value.length > 0 ? value : undefined;
		} catch {
			return undefined;
		}
	})();
	if (cwd === undefined) {
		return { cwd: undefined, refs: [], refFiles: [], refMisses: [], recent: { files: [], toolCount: 0 }, git: { changed: [], diffStat: '', changedCount: 0 }, project: { labels: [], entryCount: -1 } };
	}
	const refs = extractAtRefs(draft);
	// Touched-file signals first: they also serve as the suffix-fallback index
	// for refs written relative to a subdirectory.
	const [recent, gitInfo, project] = await Promise.all([
		gatherRecentFiles(ctx, sessionId, config.recentToolScan).catch(() => ({ files: [], toolCount: 0 })),
		gatherGit(cwd).catch(() => ({ changed: [], diffStat: '', changedCount: 0 })),
		gatherProject(cwd).catch(() => ({ labels: [], entryCount: -1 })),
	]);
	const knownPaths = [...recent.files, ...gitInfo.changed.map((line) => line.slice(3).trim())];
	const refResult = refs.length > 0
		? await gatherRefFiles(cwd, refs, knownPaths).catch(() => ({ files: [], misses: refs }))
		: { files: [], misses: [] };
	return { cwd, refs, refFiles: refResult.files, refMisses: refResult.misses, recent, git: gitInfo, project };
}

/** Tier routing over gathered signals and draft entity hits.
 *  Both sides are separator-normalized: drafts write "lib/x.ts" while session
 *  and git paths carry Windows backslashes. */
function routeTier(signals, entities) {
	if (signals === undefined) return 'T0';
	const { cwd, refFiles, recent, git, project } = signals;
	if (cwd === undefined || (project.entryCount === 0 && git.changedCount === 0)) return 'T3';
	if (refFiles.length > 0) return 'T1';
	const wanted = entities.map(normPath);
	const touched = [...recent.files.map(normPath), ...git.changed.map(normPath)];
	if (wanted.some((e) => touched.some((t) => t.includes(e)))) return 'T1';
	return 'T2';
}

/** Assemble the bounded context pack: T1 gets all signals, T2 project facts only. */
function buildPack(signals, tier, budget) {
	const parts = [];
	if (tier === 'T1') {
		if (signals.refFiles.length > 0) {
			parts.push(['引用文件（草稿 @ 提及，已读取）', signals.refFiles.map((f) => `- ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join('\n')]);
		}
		if (signals.recent.files.length > 0) {
			parts.push(['本会话最近操作的文件（时间倒序）', signals.recent.files.map((p) => `- ${p}`).join('\n')]);
		}
		if (signals.git.changedCount > 0) {
			const lines = [signals.git.changed.join('\n')];
			if (signals.git.diffStat.length > 0) lines.push('', 'diff --stat HEAD:', signals.git.diffStat);
			parts.push([`Git 未提交改动（共 ${String(signals.git.changedCount)} 项）`, lines.join('\n')]);
		}
	}
	if (signals.project.labels.length > 0) {
		parts.push(['项目类型', signals.project.labels.join(' + ')]);
	}
	if (parts.length === 0) return '';
	let pack = '';
	for (const [title, body] of parts) {
		const section = `[${title}]\n${body}\n\n`;
		if (pack.length + section.length > budget) break;
		pack += section;
	}
	return pack.trim();
}

/** One-line signal summary for the meta line. */
function signalSummary(signals, tier) {
	if (tier === 'T3') return '绿地规格模式（无工作区信号）';
	if (tier === 'T0') return '纯改写（上下文关闭）';
	const bits = [];
	if (signals.refFiles.length > 0) bits.push(`引用文件 ${signals.refFiles.length}`);
	if (signals.refMisses.length > 0) bits.push(`引用未命中 ${signals.refMisses.length}（${signals.refMisses.slice(0, 2).join('、')}）`);
	if (signals.recent.files.length > 0) bits.push(`近期文件 ${signals.recent.files.length}`);
	if (signals.git.changedCount > 0) bits.push(`git改动 ${signals.git.changedCount}`);
	if (signals.project.labels.length > 0) bits.push(signals.project.labels[0]);
	return bits.length > 0 ? bits.join(' · ') : '项目感知模式';
}

const TIER_LABELS = { T1: 'T1 锚定', T2: 'T2 项目感知', T3: 'T3 绿地规格', T0: 'T0 纯改写' };

/**
 * Decide the single corrective retry for a failed attempt, or undefined to settle.
 * Two recoverable failures: output truncated at the token cap (retry bigger) and
 * a provider rejecting the reasoning-effort field (retry without it).
 */
function nextAttempt(failure, state) {
	if (failure?.code === 'ENHANCE_EFFORT_UNSUPPORTED' && !state.effortDropped) {
		return { maxTokens: state.maxTokens, effortDropped: true };
	}
	if (failure?.code === 'ENHANCE_TRUNCATED' && state.maxTokens < MAX_RETRY_TOKENS) {
		return { maxTokens: Math.min(state.maxTokens * 2, MAX_RETRY_TOKENS), effortDropped: state.effortDropped };
	}
	return undefined;
}

/**
 * Run one enhancement attempt and return text plus timing facts.
 * A truncated stream returns its usable partial text with `truncated: true`
 * instead of throwing, so the caller can decide to retry or settle.
 */
async function enhance(ctx, config, agent, draft, signals, tier, pack, attempt, signal) {
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
			messages: [{ role: 'user', content: [{ type: 'text', text: frameDraft(draft, pack) }] }],
			system: tier === 'T3' ? greenfieldPrompt(config.systemPromptExtra) : anchoredPrompt(config.systemPromptExtra),
			maxTokens: attempt.maxTokens,
			signal: deadline.signal,
		};
		if (attempt.effort !== undefined && attempt.effort.length > 0) options.reasoningEffort = attempt.effort;
		if (agent?.session?.id !== undefined) options.sessionId = agent.session.id;
		deadline.signal.throwIfAborted();
		try {
			for await (const chunk of ctx.llm.stream(options)) {
				deadline.signal.throwIfAborted();
				switch (chunk.type) {
					case 'text-delta':
						if (firstTokenMs === undefined) firstTokenMs = Date.now() - started;
						text += chunk.text;
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
		} catch (error) {
			// Providers that reject an unknown effort field report it here.
			if (attempt.effort !== undefined && /reasoning effort/i.test(String(error?.message ?? ''))) {
				const wrapped = new Error(String(error?.message ?? error));
				wrapped.code = 'ENHANCE_EFFORT_UNSUPPORTED';
				throw wrapped;
			}
			throw error;
		}
		deadline.signal.throwIfAborted();
		const totalMs = Date.now() - started;
		const meta = [
			'增强完成',
			TIER_LABELS[tier] ?? tier,
			`模型 ${route.provider}/${route.model}（${route.source === 'config' ? '配置指定' : '跟随会话'}）`,
			`首token ${fmtMs(firstTokenMs ?? totalMs)}`,
			`总计 ${fmtMs(totalMs)}`,
		];
		if (usage !== undefined) meta.push(`tokens ${usage.inputTokens ?? '?'}/${usage.outputTokens ?? '?'}`);
		if (signals !== undefined && tier !== 'T0') meta.push(signalSummary(signals, tier));

		if (finish?.kind === 'max-tokens') {
			const partial = text.trim();
			if (partial.length >= MIN_USABLE_PARTIAL) {
				return { text: partial, meta: meta.join(' · '), totalMs, truncated: true };
			}
			const error = new Error(`prompt-enhancer: 输出在 ${String(attempt.maxTokens)} token 上限内几乎没产生内容，请调大 maxOutputTokens 配置`);
			error.code = 'ENHANCE_TRUNCATED';
			error.partialText = partial;
			throw error;
		}
		const terminal = finishError(finish);
		if (terminal !== undefined) throw terminal;
		if (sawToolCall) throw new Error('prompt-enhancer: 增强输出包含工具调用（应当只输出文本）');
		const enhanced = text.trim();
		if (enhanced.length === 0) throw new Error('prompt-enhancer: 增强模型没有产生文本');
		return { text: enhanced, meta: meta.join(' · '), totalMs, truncated: false };
	} finally {
		deadline.dispose();
	}
}

/**
 * Run the enhancement with at most one corrective retry for a recoverable
 * failure (truncation or an unsupported reasoning-effort field).
 */
async function runEnhancement(ctx, config, agent, draft, signals, tier, pack, signal) {
	let state = { maxTokens: config.maxOutputTokens, effortDropped: false };
	let truncatedResult;
	for (;;) {
		const attempt = { maxTokens: state.maxTokens, effort: state.effortDropped ? '' : config.reasoningEffort };
		try {
			const result = await enhance(ctx, config, agent, draft, signals, tier, pack, attempt, signal);
			if (result.truncated && nextAttempt({ code: 'ENHANCE_TRUNCATED' }, state) !== undefined) {
				truncatedResult = result; // keep as fallback while one bigger attempt runs
				state = nextAttempt({ code: 'ENHANCE_TRUNCATED' }, state);
				continue;
			}
			return result;
		} catch (error) {
			const next = nextAttempt(error, state);
			if (next === undefined) {
				if (error?.code === 'ENHANCE_TRUNCATED' && typeof error.partialText === 'string' && error.partialText.length >= MIN_USABLE_PARTIAL) {
					return { text: error.partialText, meta: '增强完成 · 输出截断', totalMs: 0, truncated: true };
				}
				if (truncatedResult !== undefined) return truncatedResult;
				throw error;
			}
			state = next;
		}
	}
}

function apply(ctx, config) {
	const cache = createCache(CACHE_LIMIT);

	ctx.commands.register({
		name: 'enhance',
		description: '提示词增强：结合工作区上下文把模糊草稿改写为结构化、可直接执行的提示词',
		input: { hint: '<提示词草稿>' },
		async handler(invocation) {
			const { agent, rawInput } = invocation ?? {};
			const signal = invocation?.signal;
			const draft = (rawInput ?? '').trim();
			if (draft.length === 0) {
				return {
					kind: 'error',
					text: '用法：/enhance <提示词草稿>。草稿为空——请把要增强的内容直接跟在命令后面，或在输入框输入草稿后点击火花按钮。',
				};
			}
			const signals = await gatherSignals(ctx, config, agent, draft);
			const tier = routeTier(signals, extractPathMentions(draft));
			const pack = tier === 'T1' || tier === 'T2' ? buildPack(signals, tier, config.maxContextChars) : '';
			let routeKey;
			try {
				const resolved = resolveRoute(config, agent);
				routeKey = JSON.stringify([draft, resolved.provider, resolved.model, tier, digest(pack)]);
			} catch {
				routeKey = undefined; // route errors surface below in the real call
			}
			const cached = routeKey === undefined ? undefined : cache.get(routeKey);
			if (cached !== undefined) {
				return { kind: 'success', text: `${cached.text}\n\n---\n缓存命中 · ${cached.meta}` };
			}
			try {
				const result = await runEnhancement(ctx, config, agent, draft, signals, tier, pack, signal);
				if (routeKey !== undefined && !result.truncated) cache.set(routeKey, result);
				const body = result.truncated
					? `注意：本次输出触及 token 上限，以下结果可能不完整（可调大 maxOutputTokens 后重试）。\n\n${result.text}`
					: result.text;
				const meta = result.truncated ? `${result.meta} · 输出截断` : result.meta;
				return { kind: 'success', text: `${body}\n\n---\n${meta}` };
			} catch (error) {
				if (error?.code === TIMEOUT_CODE || error?.name === 'AbortError' || signal?.aborted) {
					return { kind: 'error', text: error?.message ?? 'prompt-enhancer: 已取消' };
				}
				return { kind: 'error', text: `增强失败：${error?.message ?? String(error)}\n原始草稿未被修改，可直接发送。` };
			}
		},
	});
}

const __internals = { extractAtRefs, extractPathMentions, pathsFromToolDoc, routeTier, buildPack, digest, gatherRefFiles, signalSummary, normPath, nextAttempt };

export { Config, apply, inject, name, __internals };
