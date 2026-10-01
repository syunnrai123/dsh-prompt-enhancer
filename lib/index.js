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
const TIMEOUT_DEFAULT_MS = 30_000;

// Context budgets (characters) — mirrors the cc-gui limiter philosophy.
const REF_FILE_BUDGET = 2000;
const REF_FILE_MAX = 3;
const REF_FILE_SKIP_BYTES = 512 * 1024;
const RECENT_FILES_MAX = 8;
const GIT_STATUS_MAX = 20;
const GIT_DIFF_BUDGET = 1200;
const PACK_BUDGET_DEFAULT = 10_000;
const GIT_TIMEOUT_MS = 1500;
const TOOL_SCAN_DEPTH = 40;
/** Workspace skeleton: breadth-first depth, rendered line cap, walk caps. */
const INVENTORY_DEPTH = 2;
const INVENTORY_SCAN_DEPTH = 4;
const INVENTORY_MAX_ENTRIES = 60;
const INVENTORY_WALK_FILES = 900;
const INVENTORY_WALK_DIRS = 150;
/** File names named inline for a directory the skeleton shows but does not open. */
const INVENTORY_DIR_FILES = 6;
/** Manifest facts, README extract, and the entity-search probe. */
const MANIFEST_BUDGET = 900;
const README_BUDGET = 900;
const ENTITY_TERMS_MAX = 3;
const ENTITY_HITS_MAX = 6;
const ENTITY_SEARCH_TIMEOUT_MS = 1500;
/** Whole keyword-location stage budget; later probes are skipped once it is spent. */
const ENTITY_SEARCH_BUDGET_MS = 4000;
const ENTITY_SCAN_MAX_FILES = 240;
const ENTITY_FILE_BYTES = 256 * 1024;
const ENTITY_LINE_MAX = 140;
/** Truncated output retries once with a doubled cap, never above this ceiling. */
const MAX_RETRY_TOKENS = 8000;
/** A truncated result below this many characters is noise, not a usable rewrite. */
const MIN_USABLE_PARTIAL = 120;

/** Directory names a workspace walk never descends into. */
const NOISE_DIRS = new Set([
	'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'output', 'target', 'bin', 'obj',
	'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '__pycache__',
	'.venv', 'venv', 'env', '.idea', '.vscode', '.gradle', '.mvn', 'vendor', 'tmp', 'temp', 'logs',
	'.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', 'Pods', 'DerivedData', '.dsh', '.pnpm-store',
	'.dart_tool', '.yarn', 'bower_components', '.terraform', '.serverless', 'cmake-build-debug',
	'CMakeFiles', 'elm-stuff', '.stack-work', '.metals', '.bloop', '.clj-kondo', '.ccls-cache',
]);

/** Extensions the entity scan reads; everything else is skipped as binary or noise. */
const TEXT_EXTENSIONS = new Set([
	'.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.properties',
	'.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.py', '.rb', '.go', '.rs', '.java',
	'.kt', '.kts', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.swift', '.m', '.mm', '.sh',
	'.ps1', '.bat', '.cmd', '.sql', '.html', '.htm', '.css', '.scss', '.less', '.xml', '.gradle',
	'.gitignore', '.editorconfig', '.dockerfile', '.lock',
]);

/** Test-configuration markers, in probe order. */
const TEST_MARKERS = [
	'vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'jest.config.js', 'jest.config.ts',
	'jest.config.mjs', 'jest.config.cjs', 'jest.config.json', 'pytest.ini', 'tox.ini', 'phpunit.xml',
	'phpunit.xml.dist', 'conftest.py', '.mocharc.json', '.mocharc.yml', 'karma.conf.js',
	'cypress.config.ts', 'playwright.config.ts',
];
/** Test-directory names, in probe order. */
const TEST_DIRS = ['test', 'tests', '__tests__', 'spec', 'e2e'];
/** README basenames, top level first, then one level into a subproject. */
const README_NAMES = new Set(['README.md', 'readme.md', 'README.zh.md', 'README.markdown', 'Readme.md', 'README.txt', 'README.rst', 'readme.txt', 'docs/index.md']);
/** Path-ish and generic ASCII words that never make a useful search term. */
const ENTITY_TERM_STOPWORDS = new Set([
	'lib', 'src', 'app', 'main', 'index', 'test', 'tests', 'spec', 'docs', 'doc', 'bin', 'dist', 'build',
	'config', 'utils', 'util', 'core', 'types', 'type', 'file', 'files', 'code', 'new', 'add', 'the',
	'and', 'for', 'with', 'from', 'this', 'that', 'use', 'all', 'any',
]);
/** Function words that split a Chinese run into name-like chunks. */
const CJK_SPLIT = /[的了着过和与及或并且而但因此所以请帮我你您他们她们吗呢吧啊呀嘛一下个这那哪些什么怎么如何是否以及然后当前本次全部所有可以应该需要把将从对向为于在]/u;

const Config = z.object({
	/** Explicit enhancement route; both fields must be supplied together. */
	provider: z.string(),
	model: z.string(),
	/** Auxiliary generation token cap. Reasoning tokens share this budget. */
	maxOutputTokens: z.natural().default(2000),
	/** End-to-end deadline for one enhancement, milliseconds; every corrective
	 *  retry shares it. Invalid values (missing, <=0, non-numeric) fall back to
	 *  the 30s default instead of failing plugin load — see normalizeTimeout. */
	timeout: z.any(),
	/** Legacy alias for `timeout`, honored for profiles that predate the rename. */
	timeoutMs: z.any(),
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
	/** Workspace skeleton depth and rendered entry cap. */
	inventoryDepth: z.natural().default(INVENTORY_DEPTH),
	inventoryMaxEntries: z.natural().default(INVENTORY_MAX_ENTRIES),
	/** How deep the file index (keyword search, test discovery) reaches. */
	inventoryScanDepth: z.natural().default(INVENTORY_SCAN_DEPTH),
	/** Search the workspace for the draft's identifiers so the model cites real files. */
	entitySearchEnabled: z.boolean().default(true),
	/** How many located files to cite in the pack. */
	entityHitsMax: z.natural().default(ENTITY_HITS_MAX),
	/** How many recent commit subjects to cite. */
	gitLogCount: z.natural().default(5),
});

/** Enhancement instruction: context-first, conventional fallback, no questions. */
function basePromptRules() {
	return [
		'You are a prompt-enhancement engine inside an AI coding harness.',
		'Rewrite the supplied draft prompt so an autonomous coding agent can act on it without guessing.',
		'',
		'Rules:',
		'- Respond with the enhanced prompt ONLY. No preamble, no explanation, no quotes around the whole answer.',
		'- Keep the language of the draft (a Chinese draft stays Chinese; an English draft stays English).',
		'- Preserve every concrete detail, path, identifier, and constraint the drafter already gave; never drop or alter them.',
		'- Extract as much grounding as possible from the supplied code context: language, framework, entry points, directory layout, dependencies, existing commands, ongoing work. Use those facts as-is and cite the real paths.',
		'- Whatever the context does not cover, resolve yourself with the general, conventional implementation for that stack, stated inline as "默认：…" — never by asking the drafter.',
		'- Never ask questions and never emit 待确认 / open-question lines. The enhanced prompt must be fully actionable as written. A fallback 默认 must stay a mainstream, defensible choice and must never contradict the context.',
		'- Structure the output with exactly these Markdown sections (or the draft language equivalents): 目标 / 需求 / 边界与约束 / 验收标准. Nothing before, between, or after them.',
		'- Calibrate effort to the draft: an already-precise draft gets light edits only; a one-line idea gets a full specification. Do not pad.',
		'- Address the agent directly and imperatively; keep it concise enough to read at a glance. Do not use emoji anywhere.',
	];
}

/** T1/T2 system prompt: a verified context pack will accompany the draft. */
function anchoredPrompt(extra) {
	const lines = [
		...basePromptRules(),
		'',
		'Context handling — resolve from the pack before anything else:',
		'- The user message ends with a context pack the harness gathered by INSPECTING this workspace itself: referenced files, the directory skeleton, manifest facts, the README, test setup, keyword-located files, git history.',
		'- Everything the pack states is already verified: language, framework, entry points, directory layout, dependencies, existing test and build commands, and current work in progress. Weave these facts into 需求 and 边界与约束, citing the pack\'s real paths.',
		'- Cite ONLY what the pack states — never expand, guess, or invent beyond it.',
		'- Fix the scope yourself from the pack. A broad draft ("分析这个项目", "优化这个模块") becomes a concrete list of the directories, modules, and files to cover, chosen from the skeleton and the located files.',
		'- Anything the pack does not answer is resolved by the general conventional implementation for this stack, stated inline as "默认：…" — it is never a question.',
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
		'- Turn the idea into a complete specification: 目标 / 需求 / 边界与约束 / 验收标准.',
		'- For every decision the draft leaves open, pick the general conventional implementation for that kind of project and state it inline as "默认：…" — do not ask, do not hedge.',
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

/** Translate terminal finish reasons into an enhancement failure.
 *  Some providers report request rejection through the finish channel instead of
 *  throwing — notably an unsupported reasoning-effort value — so the message is
 *  classified here too and tagged for the drop-the-field retry. */
function finishError(finish) {
	switch (finish?.kind) {
		case undefined:
		case 'stop':
			return undefined;
		case 'error':
		case 'aborted': {
			const message = finish.failure?.message ?? String(finish.kind);
			const error = new Error(message);
			error.code = /reasoning effort/i.test(message)
				? 'ENHANCE_EFFORT_UNSUPPORTED'
				: finish.failure?.code;
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

/** Provider/model pairs that rejected the reasoning-effort field: the field is
 *  omitted outright next time, so one unsupported provider costs one retry ever. */
const effortUnsupported = new Set();

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

/** Effective end-to-end timeout: `timeout` wins, the legacy `timeoutMs` alias
 *  follows, and anything invalid (missing, <=0, non-numeric) falls back to 30s.
 *  Never throws, so a bad profile value cannot break plugin load. */
function normalizeTimeout(config) {
	for (const raw of [config?.timeout, config?.timeoutMs]) {
		const value = Number(raw);
		if (Number.isFinite(value) && value > 0) return Math.floor(value);
	}
	return TIMEOUT_DEFAULT_MS;
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
	['deno.json', 'Deno'],
	['pubspec.yaml', 'Dart / Flutter'],
	['pom.xml', 'Java / Maven'],
	['build.gradle', 'Java / Gradle'],
	['build.gradle.kts', 'Java / Gradle'],
	['Cargo.toml', 'Rust / Cargo'],
	['go.mod', 'Go'],
	['requirements.txt', 'Python / pip'],
	['pyproject.toml', 'Python'],
	['setup.py', 'Python'],
	['Pipfile', 'Python / Pipenv'],
	['composer.json', 'PHP / Composer'],
	['Gemfile', 'Ruby'],
	['mix.exs', 'Elixir / Mix'],
	['build.sbt', 'Scala / sbt'],
	['meson.build', 'C/C++ / Meson'],
	['CMakeLists.txt', 'C/C++ / CMake'],
	['Makefile', 'Make'],
]);
const MANIFEST_NAMES = new Set(MANIFEST_HINTS.keys());
/** Manifest names that are project-specific rather than fixed, e.g. Foo.csproj. */
const MANIFEST_PATTERNS = [[/\.csproj$/i, 'C# / .NET']];
const isManifestName = (name) => MANIFEST_NAMES.has(name) || MANIFEST_PATTERNS.some(([pattern]) => pattern.test(name));

/** Project type from manifest files plus the top-level entry names. */
async function gatherProject(cwd) {
	const entries = await readdir(cwd).catch(() => []);
	const hits = [];
	for (const [file, label] of MANIFEST_HINTS) {
		if (entries.includes(file) && !hits.includes(label)) hits.push(label);
	}
	for (const [pattern, label] of MANIFEST_PATTERNS) {
		if (entries.some((entry) => pattern.test(entry)) && !hits.includes(label)) hits.push(label);
	}
	return { labels: hits.slice(0, 2), entryCount: entries.length, names: entries.slice(0, 200) };
}

// ── workspace inspection (the model should resolve facts itself, not ask) ────

/** Breadth-first walk of the workspace: a shallow skeleton plus a bounded file index.
 *  Files just below the skeleton's deepest level are recorded per directory, so the
 *  rendered skeleton still says what lives inside e.g. `lib/`. */
async function walkWorkspace(cwd, depth, maxEntries, scanDepth = INVENTORY_SCAN_DEPTH, maxFiles = INVENTORY_WALK_FILES) {
	const dirs = [];
	const files = [];
	const skeleton = [];
	const dirFiles = new Map();
	let truncated = false;
	let queue = [{ rel: '', level: 0 }];
	while (queue.length > 0 && dirs.length < INVENTORY_WALK_DIRS) {
		const next = [];
		for (const dir of queue) {
			if (dirs.length >= INVENTORY_WALK_DIRS) {
				truncated = true;
				break;
			}
			dirs.push(dir.rel);
			const children = await readdir(dir.rel.length === 0 ? cwd : resolve(cwd, dir.rel), { withFileTypes: true }).catch(() => []);
			children.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
			for (const child of children) {
				const rel = dir.rel.length === 0 ? child.name : `${dir.rel}/${child.name}`;
				if (child.isDirectory()) {
					if (NOISE_DIRS.has(child.name)) continue;
					if (dir.level + 1 <= depth) {
						if (skeleton.length < maxEntries) skeleton.push({ rel, dir: true, level: dir.level + 1 });
						else truncated = true;
					}
					if (dir.level + 1 < scanDepth) next.push({ rel, level: dir.level + 1 });
					continue;
				}
				if (!child.isFile()) continue;
				if (files.length < maxFiles) files.push(rel);
				if (dir.level + 1 <= depth) {
					if (skeleton.length < maxEntries) skeleton.push({ rel, dir: false, level: dir.level + 1 });
					else truncated = true;
				} else if (dir.rel.length > 0) {
					// One level below the rendered skeleton: name the files in place.
					const bucket = dirFiles.get(dir.rel) ?? { names: [], count: 0 };
					bucket.count += 1;
					if (bucket.names.length < INVENTORY_DIR_FILES) bucket.names.push(child.name);
					dirFiles.set(dir.rel, bucket);
				}
			}
		}
		queue = next;
	}
	return { skeleton, files, dirs, dirFiles, truncated };
}

/** Render the skeleton as relative paths, directories first with a slash. */
function renderSkeleton(skeleton, dirFiles) {
	return skeleton.map((entry) => {
		if (!entry.dir) return entry.rel;
		const bucket = dirFiles?.get(entry.rel);
		if (bucket === undefined || bucket.names.length === 0) return `${entry.rel}/`;
		const extra = bucket.count > bucket.names.length ? ` +${String(bucket.count - bucket.names.length)}` : '';
		return `${entry.rel}/  → ${bucket.names.join(', ')}${extra}`;
	}).join('\n');
}

/** Facts pulled out of one manifest file: the language, deps, and runnable scripts. */
function manifestFacts(file, text) {
	const lines = [];
	const push = (label, value) => {
		if (value !== undefined && String(value).trim().length > 0) lines.push(`- ${label}: ${String(value).trim()}`);
	};
	const json = () => { try { return JSON.parse(text); } catch { return undefined; } };
	switch (file) {
		case 'package.json': {
			const value = json();
			if (value === undefined) break;
			push('name', value.name);
			push('type', value.type);
			push('packageManager', value.packageManager);
			if (value.workspaces !== undefined) push('workspaces', Array.isArray(value.workspaces) ? value.workspaces.join(', ') : JSON.stringify(value.workspaces));
			if (value.engines !== undefined) push('engines', Object.entries(value.engines).map(([k, v]) => `${k} ${String(v)}`).join(', '));
			const scripts = Object.keys(value.scripts ?? {}).slice(0, 6);
			if (scripts.length > 0) push('scripts', scripts.join(', '));
			const deps = Object.keys(value.dependencies ?? {});
			if (deps.length > 0) push(`dependencies(${String(deps.length)})`, deps.slice(0, 10).join(', '));
			const dev = Object.keys(value.devDependencies ?? {});
			if (dev.length > 0) push(`devDependencies(${String(dev.length)})`, dev.slice(0, 8).join(', '));
			break;
		}
		case 'pom.xml': {
			push('artifactId', /<artifactId>([^<]+)<\/artifactId>/u.exec(text)?.[1]);
			push('groupId', /<groupId>([^<]+)<\/groupId>/u.exec(text)?.[1]);
			const deps = [...text.matchAll(/<dependency>[\s\S]{0,400}?<artifactId>([^<]+)<\/artifactId>/gu)].map((m) => m[1]);
			if (deps.length > 0) push(`dependencies(${String(deps.length)})`, deps.slice(0, 8).join(', '));
			const plugins = [...text.matchAll(/<plugin>[\s\S]{0,300}?<artifactId>([^<]+)<\/artifactId>/gu)].map((m) => m[1]);
			if (plugins.length > 0) push('plugins', plugins.slice(0, 6).join(', '));
			break;
		}
		case 'Cargo.toml':
		case 'pyproject.toml':
		case 'go.mod':
		case 'composer.json':
		case 'Gemfile':
		case 'build.gradle':
		case 'build.gradle.kts':
		case 'requirements.txt':
		case 'CMakeLists.txt':
		case 'Makefile':
		default: {
			const kept = text.split(/\r?\n/u)
				.map((line) => line.trim())
				.filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('//'))
				.slice(0, 12);
			if (kept.length > 0) lines.push(kept.map((line) => `- ${line.slice(0, 120)}`).join('\n'));
			break;
		}
	}
	return lines.join('\n');
}

/** Read the given manifests (project-relative paths) and turn them into citable facts. */
async function gatherManifests(cwd, candidates, budget) {
	const facts = [];
	for (const file of candidates.slice(0, 3)) {
		try {
			const info = await stat(resolve(cwd, file));
			if (!info.isFile() || info.size > REF_FILE_SKIP_BYTES) continue;
			const text = await readFile(resolve(cwd, file), 'utf8');
			const body = manifestFacts(file.split('/').pop(), text).trim();
			if (body.length === 0) continue;
			const section = `${file}\n${body}`;
			if (facts.join('\n\n').length + section.length > budget) break;
			facts.push(section);
		} catch { /* unreadable manifest: skip */ }
	}
	return facts.join('\n\n');
}

/** First meaningful lines of the project's own README (top level first, then nested). */
async function gatherReadme(cwd, candidates, budget) {
	const candidate = candidates[0];
	if (candidate === undefined) return { file: undefined, text: '' };
	try {
		const info = await stat(resolve(cwd, candidate));
		if (!info.isFile() || info.size > REF_FILE_SKIP_BYTES) return { file: candidate, text: '' };
		const text = await readFile(resolve(cwd, candidate), 'utf8');
		const kept = [];
		let used = 0;
		for (const line of text.split(/\r?\n/u)) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			// Badge and image-only lines cost bytes and say nothing.
			if (/^\[!\[|^!\[|^<img|^<p align/u.test(trimmed)) continue;
			kept.push(trimmed);
			used += trimmed.length;
			if (used >= budget) break;
		}
		return { file: candidate, text: kept.join('\n').slice(0, budget) };
	} catch {
		return { file: candidate, text: '' };
	}
}

/** Test framework, test directories, and test-file count from the workspace index. */
function summarizeTests(present, files, manifestText) {
	const marks = TEST_MARKERS.filter((mark) => present.includes(mark));
	const label = marks[0] ?? (files.some((file) => /\.test\.[cm]?[jt]sx?$/u.test(file)) ? '*.test.*'
		: files.some((file) => /(^|\/)(test_.*\.py|.*_test\.go)$/u.test(file)) ? 'pytest / go test'
			: files.some((file) => /(^|\/)test\/.*\.java$/u.test(file)) ? 'JUnit' : undefined);
	const dirs = TEST_DIRS.filter((dir) => files.some((file) => file === dir || file.startsWith(`${dir}/`)));
	const testFiles = files.filter((file) => /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.go$|(^|\/)[^/]*Test\.java$/u.test(file)).length;
	const script = /- scripts: ([^\n]*)/u.exec(manifestText)?.[1]?.split(',').map((part) => part.trim()).find((part) => /test|check|lint/u.test(part));
	const bits = [];
	if (label !== undefined) bits.push(`框架线索 ${label}`);
	if (marks.length > 0) bits.push(`配置 ${marks.slice(0, 2).join('、')}`);
	if (dirs.length > 0) bits.push(`目录 ${dirs.map((dir) => `${dir}/`).join('、')}`);
	if (testFiles > 0) bits.push(`测试文件 ${String(testFiles)} 个`);
	if (script !== undefined) bits.push(`脚本 ${script}`);
	return bits.join(' · ');
}

/** Recent commit subjects and the current branch: what the workspace is being changed for. */
async function gatherGitLog(cwd, count) {
	if (count <= 0) return { branch: undefined, commits: [] };
	const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
	const log = await git(cwd, ['log', `-${String(count)}`, '--pretty=format:%h %s']);
	const commits = (log ?? '').split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
	return { branch: branch !== undefined && branch.length > 0 && branch !== 'HEAD' ? branch : undefined, commits: commits.slice(0, count) };
}


/** Identifiers and CJK names worth searching the workspace for.
 *  Code-shaped tokens (SparkIcon, foo_bar, a.b) outrank English prose words. */
function extractEntityTerms(draft) {
	const identifiers = [];
	const words = [];
	const chunks = [];
	const stop = new Set();
	const push = (bucket, value) => {
		const term = value.trim();
		if (term.length < 3 || term.length > 40) return;
		if (stop.has(term.toLowerCase())) return;
		if (ENTITY_TERM_STOPWORDS.has(term.toLowerCase())) return;
		stop.add(term.toLowerCase());
		bucket.push(term);
	};
	for (const match of draft.matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,}/gu)) {
		const term = match[0];
		if (/[A-Z_./-]/u.test(term.slice(1))) push(identifiers, term);
		else if (term.length >= 4) push(words, term);
	}
	for (const match of draft.matchAll(/[\u4e00-\u9fff]{3,}/gu)) {
		const run = match[0].replace(/^(?:请|帮我|帮忙|麻烦)?(?:分析|优化|重构|实现|修复|检查|整理|梳理|看看|看下|评估|评审|添加|新增|删除|修改|调整|写|做)/u, '');
		for (const chunk of run.split(CJK_SPLIT)) {
			if (chunk.length >= 3 && chunk.length <= 8) push(chunks, chunk);
		}
	}
	const byLength = (a, b) => b.length - a.length;
	return [...identifiers.sort(byLength), ...chunks.sort(byLength), ...words.sort(byLength)].slice(0, ENTITY_TERMS_MAX);
}

/** Resolve the packaged ripgrep binary once; undefined when only the scan is available. */
let ripgrepPath;
async function resolveRipgrep() {
	if (ripgrepPath !== undefined) return ripgrepPath ?? undefined;
	const candidates = [];
	const platform = `${process.platform}-${process.arch}`;
	const pkg = `@vscode/ripgrep-${platform}`;
	for (const root of [process.resourcesPath, resolve(process.execPath, '..', 'resources')]) {
		if (typeof root !== 'string' || root.length === 0) continue;
		candidates.push(resolve(root, 'app.asar.unpacked', 'dsh', 'node_modules', pkg, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg'));
		candidates.push(resolve(root, 'app.asar.unpacked', 'node_modules', pkg, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg'));
	}
	for (const candidate of candidates) {
		try {
			const info = await stat(candidate);
			if (info.isFile()) {
				ripgrepPath = candidate;
				return candidate;
			}
		} catch { /* keep looking */ }
	}
	try {
		const imported = await import('@vscode/ripgrep');
		if (typeof imported?.rgPath === 'string') {
			ripgrepPath = imported.rgPath;
			return imported.rgPath;
		}
	} catch { /* not hoisted into this profile */ }
	ripgrepPath = null;
	return undefined;
}

/** One ripgrep probe: `<rel>:<line>:<text>` matches for a literal term. */
function ripgrepProbe(binary, cwd, term, limit) {
	return new Promise((resolvePromise) => {
		execFile(binary, [
			'--no-config', '--no-heading', '--line-number', '--max-count', '1', '--max-columns', String(ENTITY_LINE_MAX),
			'--glob', '!node_modules', '--glob', '!.git', '--glob', '!dist', '--glob', '!build',
			'--fixed-strings', '--ignore-case', term, '.',
		], { cwd, timeout: ENTITY_SEARCH_TIMEOUT_MS, windowsHide: true, maxBuffer: 512 * 1024 }, (error, stdout) => {
			if (stdout === undefined || stdout.length === 0) {
				resolvePromise([]);
				return;
			}
			const hits = [];
			for (const line of stdout.split(/\r?\n/u)) {
				if (hits.length >= limit) break;
				const match = /^(.+?):(\d+):(.*)$/u.exec(line);
				if (match === null) continue;
				hits.push({ file: match[1].replace(/^\.\//u, ''), line: Number(match[2]), text: match[3].trim() });
			}
			resolvePromise(error !== undefined && hits.length === 0 ? [] : hits);
		});
	});
}

/** Bounded in-process scan used when the packaged ripgrep is unavailable.
 *  Scores a file by how many of the given needles it contains. */
async function scanProbe(cwd, needles, files, limit) {
	const lowered = needles.map((needle) => needle.toLowerCase());
	const hits = [];
	let scanned = 0;
	let best = [];
	for (const file of files) {
		if (scanned >= ENTITY_SCAN_MAX_FILES) break;
		const dot = file.lastIndexOf('.');
		const ext = dot === -1 ? '' : file.slice(dot).toLowerCase();
		if (ext.length > 0 && !TEXT_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(file.toLowerCase())) continue;
		scanned += 1;
		try {
			const path = resolve(cwd, file);
			const info = await stat(path);
			if (!info.isFile() || info.size > ENTITY_FILE_BYTES) continue;
			const text = await readFile(path, 'utf8');
			const haystack = text.toLowerCase();
			let score = 0;
			let index = -1;
			for (const needle of lowered) {
				const at = haystack.indexOf(needle);
				if (at === -1) continue;
				score += 1;
				if (index === -1 || at < index) index = at;
			}
			if (score === 0) continue;
			const start = text.lastIndexOf('\n', index) + 1;
			const end = text.indexOf('\n', index);
			best.push({
				file,
				line: text.slice(0, index).split('\n').length,
				text: text.slice(start, end === -1 ? start + ENTITY_LINE_MAX : end).trim().slice(0, ENTITY_LINE_MAX),
				score,
			});
			if (best.length > limit * 4) {
				best = rankCounted(best).slice(0, limit * 2);
			}
		} catch { /* unreadable: skip */ }
	}
	hits.push(...rankCounted(best).slice(0, limit));
	return hits;
}

/** Bigram windows of a Chinese phrase: how a concept looks when it was never typed verbatim. */
function cjkBigrams(chunk) {
	const grams = [];
	for (let i = 0; i + 2 <= chunk.length; i += 1) grams.push(chunk.slice(i, i + 2));
	return [...new Set(grams)];
}

/** Rank scored hits: more distinct needles first, then shallower paths. */
function rankCounted(hits) {
	return [...hits].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.file.split('/').length - b.file.split('/').length);
}

/** One ripgrep probe asking how many lines of each file carry any needle. */
function ripgrepCounts(binary, cwd, needles, limit) {
	return new Promise((resolvePromise) => {
		const args = [
			'--no-config', '--count', '--no-heading', '--fixed-strings',
			'--glob', '!node_modules', '--glob', '!.git', '--glob', '!dist', '--glob', '!build',
		];
		for (const needle of needles) args.push('-e', needle);
		args.push('.');
		execFile(binary, args, { cwd, timeout: ENTITY_SEARCH_TIMEOUT_MS, windowsHide: true, maxBuffer: 512 * 1024 }, (_error, stdout) => {
			const hits = [];
			for (const line of (stdout ?? '').split(/\r?\n/u)) {
				const match = /^(.+?):(\d+)$/u.exec(line.trim());
				if (match === null) continue;
				hits.push({ file: match[1].replace(/^\.\//u, ''), score: Number(match[2]) });
			}
			resolvePromise(rankCounted(hits).slice(0, limit));
		});
	});
}

/** Read the first line of one file that carries any needle. */
async function firstMatchingLine(cwd, file, needles) {
	try {
		const path = resolve(cwd, file);
		const info = await stat(path);
		if (!info.isFile() || info.size > ENTITY_FILE_BYTES) return undefined;
		const text = await readFile(path, 'utf8');
		const lowered = text.toLowerCase();
		let index = -1;
		for (const needle of needles) {
			const at = lowered.indexOf(needle.toLowerCase());
			if (at !== -1 && (index === -1 || at < index)) index = at;
		}
		if (index === -1) return undefined;
		const start = text.lastIndexOf('\n', index) + 1;
		const end = text.indexOf('\n', index);
		return {
			line: text.slice(0, index).split('\n').length,
			text: text.slice(start, end === -1 ? start + ENTITY_LINE_MAX : end).trim().slice(0, ENTITY_LINE_MAX),
		};
	} catch {
		return undefined;
	}
}

/** A hit's usefulness: shallow, source-like, non-test paths rank first. */
function rankEntityHits(hits) {
	return [...hits].sort((a, b) => {
		const score = (hit) => hit.file.split('/').length * 10
			+ (/\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)tests?\//u.test(hit.file) ? 6 : 0)
			+ (/^(docs?|examples?|samples?)\//u.test(hit.file) ? 4 : 0);
		return score(a) - score(b);
	});
}

/**
 * Locate the files the draft is talking about: ripgrep when the packaged binary
 * resolves, otherwise a bounded in-process scan of the workspace index. A phrase
 * that appears nowhere verbatim is retried as its bigram set, ranked by how many
 * of those bigrams a file carries — which is what keeps Chinese drafts from
 * having to ask "which files do you mean?".
 */
async function gatherEntityHits(cwd, terms, files, limit) {
	if (terms.length === 0 || limit <= 0) return { hits: [], searched: [] };
	const deadline = Date.now() + ENTITY_SEARCH_BUDGET_MS;
	const binary = await resolveRipgrep();
	const collected = new Map();
	const searched = [];
	const merge = (hit, term, partial) => {
		const key = normPath(hit.file);
		const existing = collected.get(key);
		if (existing !== undefined) {
			if (partial === true) existing.partialTerms = [...new Set([...(existing.partialTerms ?? []), term])];
			else existing.terms = [...new Set([...(existing.terms ?? []), term])];
			if (existing.text === undefined || existing.text.length === 0) Object.assign(existing, { line: hit.line, text: hit.text });
			return;
		}
		collected.set(key, {
			...hit,
			...(partial === true ? { partialTerms: [term] } : { terms: [term] }),
		});
	};
	for (const term of terms) {
		if (collected.size >= limit || Date.now() > deadline) break;
		searched.push(term);
		const direct = binary === undefined
			? await scanProbe(cwd, [term], files, limit).catch(() => [])
			: await ripgrepProbe(binary, cwd, term, limit).catch(() => []);
		for (const hit of rankEntityHits(direct)) {
			merge(hit, term, false);
			if (collected.size >= limit) break;
		}
		// A name-shaped term ("mod3", "panel") usually lives in a file name rather
		// than in file contents; the index answers that without another search.
		const needle = normPath(term);
		for (const file of files) {
			if (collected.size >= limit) break;
			if (!normPath(file).includes(needle)) continue;
			merge({ file, line: 1, text: '（路径/文件名匹配）' }, term, false);
		}
		if (direct.length > 0 || collected.size >= limit || Date.now() > deadline) continue;
		// Only a Chinese phrase needs the bigram retry: an English token that
		// matches nothing literal would match every file as bigrams.
		if (!/[\u4e00-\u9fff]{2}/u.test(term)) continue;
		const grams = cjkBigrams(term);
		if (grams.length < 2) continue;
		const counted = binary === undefined
			? await scanProbe(cwd, grams, files, limit).catch(() => [])
			: await ripgrepCounts(binary, cwd, grams, limit).catch(() => []);
		for (const hit of counted) {
			if (collected.size >= limit) break;
			if ((hit.score ?? 0) < 2) continue; // a single bigram is far too loose
			const snippet = await firstMatchingLine(cwd, hit.file, grams);
			merge({ file: hit.file, line: snippet?.line ?? 1, text: snippet?.text ?? '' }, term, true);
		}
	}
	return { hits: [...collected.values()].slice(0, limit), searched };
}

/** Manifest files to read: the workspace's own first, then one level into a subproject. */
function manifestCandidates(topLevel, skeleton) {
	const nested = skeleton.filter((entry) => !entry.dir && entry.rel.includes('/')).map((entry) => entry.rel);
	return [
		...topLevel.filter((file) => isManifestName(file)),
		...nested.filter((rel) => isManifestName(rel.split('/').pop())),
	];
}

/** README files to summarize, same top-level-then-nested preference. */
function readmeCandidates(topLevel, skeleton) {
	const nested = skeleton.filter((entry) => !entry.dir && entry.rel.includes('/')).map((entry) => entry.rel);
	return [
		...[...README_NAMES].filter((file) => topLevel.includes(file)),
		...nested.filter((rel) => README_NAMES.has(rel.split('/').pop())),
	];
}


/** A signals object for a workspace we could not read. */
function emptySignals(cwd) {
	return {
		cwd,
		refs: [],
		refFiles: [],
		refMisses: [],
		recent: { files: [], toolCount: 0 },
		git: { changed: [], diffStat: '', changedCount: 0 },
		project: { labels: [], entryCount: -1, names: [] },
		workspace: { skeleton: [], files: [], dirs: [], truncated: false },
		manifests: '',
		readme: { file: undefined, text: '' },
		tests: '',
		gitLog: { branch: undefined, commits: [] },
		entities: { terms: [], hits: [], searched: [] },
	};
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
	if (cwd === undefined) return emptySignals(undefined);
	const refs = extractAtRefs(draft);
	const terms = config.entitySearchEnabled ? extractEntityTerms(draft) : [];
	// Touched-file signals first: they also serve as the suffix-fallback index
	// for refs written relative to a subdirectory.
	const [recent, gitInfo, project, workspace, gitLog] = await Promise.all([
		gatherRecentFiles(ctx, sessionId, config.recentToolScan).catch(() => ({ files: [], toolCount: 0 })),
		gatherGit(cwd).catch(() => ({ changed: [], diffStat: '', changedCount: 0 })),
		gatherProject(cwd).catch(() => ({ labels: [], entryCount: -1, names: [] })),
		walkWorkspace(cwd, config.inventoryDepth, config.inventoryMaxEntries, config.inventoryScanDepth).catch(() => ({ skeleton: [], files: [], dirs: [], truncated: false })),
		gatherGitLog(cwd, config.gitLogCount).catch(() => ({ branch: undefined, commits: [] })),
	]);
	const [manifests, readme, entities] = await Promise.all([
		gatherManifests(cwd, manifestCandidates(project.names, workspace.skeleton), MANIFEST_BUDGET).catch(() => ''),
		gatherReadme(cwd, readmeCandidates(project.names, workspace.skeleton), README_BUDGET).catch(() => ({ file: undefined, text: '' })),
		gatherEntityHits(cwd, terms, workspace.files, config.entityHitsMax).catch(() => ({ hits: [], searched: [] })),
	]);
	const tests = summarizeTests([...project.names, ...workspace.skeleton.map((entry) => entry.rel)], workspace.files, manifests);
	const knownPaths = [...workspace.files.map((file) => resolve(cwd, file)), ...recent.files, ...gitInfo.changed.map((line) => line.slice(3).trim())];
	const refResult = refs.length > 0
		? await gatherRefFiles(cwd, refs, knownPaths).catch(() => ({ files: [], misses: refs }))
		: { files: [], misses: [] };
	return {
		cwd,
		refs,
		refFiles: refResult.files,
		refMisses: refResult.misses,
		recent,
		git: gitInfo,
		project,
		workspace,
		manifests,
		readme,
		tests,
		gitLog,
		entities,
	};
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

/**
 * Assemble the bounded context pack. Order is by value, because the builder
 * stops at the first section that no longer fits: anchored drafts lead with the
 * files they named, then every draft gets the workspace's own structure and
 * facts, then the session-local signals only T1 is allowed to see.
 */
function buildPack(signals, tier, budget) {
	const parts = [];
	const workspace = signals.workspace ?? { skeleton: [], truncated: false };
	const entities = signals.entities ?? { hits: [], searched: [] };
	const readme = signals.readme ?? { file: undefined, text: '' };
	const gitLog = signals.gitLog ?? { branch: undefined, commits: [] };
	const project = signals.project ?? { labels: [], entryCount: -1 };
	const manifests = signals.manifests ?? '';
	const tests = signals.tests ?? '';
	const add = (title, body) => {
		if (body !== undefined && String(body).trim().length > 0) parts.push([title, String(body).trim()]);
	};
	if (tier === 'T1' && signals.refFiles.length > 0) {
		add('引用文件（草稿 @ 提及，已读取）', signals.refFiles.map((f) => `- ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join('\n'));
	}
	if (workspace.skeleton.length > 0) {
		add(`工作区骨架（已跳过 node_modules/.git/dist 等${workspace.truncated ? '，超出上限已截断' : ''}）`, renderSkeleton(workspace.skeleton, workspace.dirFiles));
	}
	add('项目清单要点（已读取文件内容）', manifests);
	if (project.labels.length > 0) {
		add('项目类型', `${project.labels.join(' + ')}（顶层条目 ${String(project.entryCount)} 个）`);
	}
	if (entities.hits.length > 0) {
		const terms = entities.searched.length > 0 ? `（检索词 ${entities.searched.join('、')}）` : '';
		add(`相关文件位置${terms}`, entities.hits.map((hit) => {
			const labels = [];
			if (hit.terms !== undefined && hit.terms.length > 0) labels.push(`命中 ${hit.terms.join('、')}`);
			if (hit.partialTerms !== undefined && hit.partialTerms.length > 0) labels.push(`部分命中 ${hit.partialTerms.join('、')}`);
			return `- ${hit.file}:${String(hit.line)}${labels.length === 0 ? '' : `（${labels.join('；')}）`}\n  ${hit.text ?? ''}`.trimEnd();
		}).join('\n'));
	}
	if (readme.text.length > 0) {
		add(`README 摘要（${readme.file ?? 'README'} 开头部分）`, readme.text);
	}
	if (tests.length > 0) {
		add('测试线索', tests);
	}
	if (tier === 'T1') {
		if (signals.recent.files.length > 0) {
			add('本会话最近操作的文件（时间倒序）', signals.recent.files.map((p) => `- ${p}`).join('\n'));
		}
		if (signals.git.changedCount > 0) {
			const lines = [signals.git.changed.join('\n')];
			if (signals.git.diffStat.length > 0) lines.push('', 'diff --stat HEAD:', signals.git.diffStat);
			add(`Git 未提交改动（共 ${String(signals.git.changedCount)} 项）`, lines.join('\n'));
		}
	}
	if (gitLog.commits.length > 0) {
		add(`Git 最近提交${gitLog.branch === undefined ? '' : `（分支 ${gitLog.branch}）`}`, gitLog.commits.map((line) => `- ${line}`).join('\n'));
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
	const workspace = signals.workspace ?? { skeleton: [] };
	const entities = signals.entities ?? { hits: [] };
	const readme = signals.readme ?? { text: '' };
	const gitLog = signals.gitLog ?? { commits: [] };
	const project = signals.project ?? { labels: [] };
	const bits = [];
	if (signals.refFiles.length > 0) bits.push(`引用文件 ${signals.refFiles.length}`);
	if (signals.refMisses.length > 0) bits.push(`引用未命中 ${signals.refMisses.length}（${signals.refMisses.slice(0, 2).join('、')}）`);
	if (workspace.skeleton.length > 0) bits.push(`骨架 ${workspace.skeleton.length} 项`);
	if ((signals.manifests ?? '').length > 0) bits.push('清单');
	if (entities.hits.length > 0) bits.push(`关键词命中 ${entities.hits.length}`);
	if (readme.text.length > 0) bits.push('README');
	if ((signals.tests ?? '').length > 0) bits.push('测试线索');
	if (signals.recent.files.length > 0) bits.push(`近期文件 ${signals.recent.files.length}`);
	if (signals.git.changedCount > 0) bits.push(`git改动 ${signals.git.changedCount}`);
	if (gitLog.commits.length > 0) bits.push(`提交 ${gitLog.commits.length}`);
	if (project.labels.length > 0) bits.push(project.labels[0]);
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
		signal,
	};
	if (attempt.effort !== undefined && attempt.effort.length > 0 && !effortUnsupported.has(`${route.provider}/${route.model}`)) {
		options.reasoningEffort = attempt.effort;
	}
	if (agent?.session?.id !== undefined) options.sessionId = agent.session.id;
	signal.throwIfAborted();
	try {
		for await (const chunk of ctx.llm.stream(options)) {
			signal.throwIfAborted();
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
			effortUnsupported.add(`${route.provider}/${route.model}`);
			const wrapped = new Error(String(error?.message ?? error));
			wrapped.code = 'ENHANCE_EFFORT_UNSUPPORTED';
			throw wrapped;
		}
		throw error;
	}
	signal.throwIfAborted();
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
	if (attempt.effortDropped === true || effortUnsupported.has(`${route.provider}/${route.model}`)) {
		meta.push('已自动省略 reasoningEffort');
	}

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
	if (terminal !== undefined) {
		if (terminal.code === 'ENHANCE_EFFORT_UNSUPPORTED') effortUnsupported.add(`${route.provider}/${route.model}`);
		throw terminal;
	}
	if (sawToolCall) throw new Error('prompt-enhancer: 增强输出包含工具调用（应当只输出文本）');
	const enhanced = text.trim();
	if (enhanced.length === 0) throw new Error('prompt-enhancer: 增强模型没有产生文本');
	return { text: enhanced, meta: meta.join(' · '), totalMs, truncated: false };
}

/**
 * Run the enhancement with at most one corrective retry for a recoverable
 * failure (truncation or an unsupported reasoning-effort field). The timeout
 * deadline covers every attempt, so a retry spends what is left of the same
 * end-to-end budget instead of starting a fresh one.
 */
async function runEnhancement(ctx, config, agent, draft, signals, tier, pack, signal) {
	const deadline = withDeadline(signal, normalizeTimeout(config));
	let state = { maxTokens: config.maxOutputTokens, effortDropped: false };
	let truncatedResult;
	try {
		for (;;) {
			const attempt = { maxTokens: state.maxTokens, effort: state.effortDropped ? '' : config.reasoningEffort, effortDropped: state.effortDropped };
			try {
				const result = await enhance(ctx, config, agent, draft, signals, tier, pack, attempt, deadline.signal);
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
	} finally {
		deadline.dispose();
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

const __internals = {
	extractAtRefs, extractPathMentions, pathsFromToolDoc, routeTier, buildPack, digest, gatherRefFiles, signalSummary, normPath, nextAttempt, finishError,
	extractEntityTerms, manifestFacts, renderSkeleton, rankEntityHits, summarizeTests, walkWorkspace, gatherEntityHits, gatherSignals,
	resolveRipgrep, cjkBigrams, rankCounted, manifestCandidates, readmeCandidates, emptySignals, createCache, withDeadline, normalizeTimeout,
};

export { Config, apply, inject, name, __internals };
