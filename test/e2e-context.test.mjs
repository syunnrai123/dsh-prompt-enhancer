/**
 * End-to-end tests for context gathering and pack assembly.
 * Verifies that gathered context is actually passed to the model prompt.
 */
import { strictEqual as eq, ok, match, doesNotMatch } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { __internals } = await import('../lib/index.js');
const { gatherSignals, routeTier, buildPack, frameDraft, extractPathMentions } = __internals;

test('frameDraft: empty pack returns base only', () => {
	const draft = '分析项目';
	const result = frameDraft(draft, '');
	ok(result.includes('Enhance this draft prompt'), 'contains base instruction');
	ok(result.includes(JSON.stringify({ draft })), 'contains JSON-encoded draft');
	doesNotMatch(result, /context pack/, 'should not contain context pack markers');
});

test('frameDraft: non-empty pack is framed correctly', () => {
	const draft = '优化 @src/app.js';
	const pack = '[引用文件]\n- src/app.js\n```\nexport const x = 1;\n```';
	const result = frameDraft(draft, pack);
	ok(result.includes('Enhance this draft prompt'), 'contains base instruction');
	ok(result.includes(JSON.stringify({ draft })), 'contains JSON-encoded draft');
	match(result, /--- context pack \(verified facts only\) ---/, 'contains pack start marker');
	ok(result.includes('[引用文件]'), 'contains pack content');
	ok(result.includes('export const x = 1'), 'contains file content');
	match(result, /--- end of context pack ---/, 'contains pack end marker');
});

test('gatherSignals + buildPack: @-referenced file appears in pack', async () => {
	const root = await mkdtemp(join(tmpdir(), 'e2e-ctx-'));
	try {
		await mkdir(join(root, 'src'), { recursive: true });
		await writeFile(join(root, 'src', 'app.js'), 'export const VERSION = "1.0.0";\nexport function main() { return 42; }', 'utf8');
		await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'test-proj', type: 'module' }), 'utf8');

		const ctx = {
			sessionQuery: {
				readSurface: async () => ({ session: { cwd: root } }),
				filterEvents: async () => [],
			},
		};
		const config = { contextEnabled: true, maxContextChars: 10000, entitySearchEnabled: true, inventoryDepth: 2, inventoryMaxEntries: 60, inventoryScanDepth: 4, entityHitsMax: 6, gitLogCount: 5, recentToolScan: 40 };
		const draft = '检查 @src/app.js 的逻辑';

		const signals = await gatherSignals(ctx, config, { session: { id: 'test-session' } }, draft, undefined);
		const tier = routeTier(signals, extractPathMentions(draft));
		const pack = buildPack(signals, tier, 10000);

		eq(tier, 'T1', 'should route to T1 (anchored) tier');
		ok(signals.refFiles.length > 0, 'should have resolved @-ref');
		ok(pack.includes('[引用文件'), 'pack should contain ref file section');
		ok(pack.includes('src/app.js'), 'pack should contain file path');
		ok(pack.includes('VERSION'), 'pack should contain file content');
		ok(pack.includes('main'), 'pack should contain function name');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('gatherSignals + buildPack: large file gets compression marker', async () => {
	const root = await mkdtemp(join(tmpdir(), 'e2e-compress-'));
	try {
		await mkdir(join(root, 'lib'), { recursive: true });
		const largeContent = 'import x from "dep";\n'.repeat(50) + 'export function foo() { return 1; }\n'.repeat(100) + 'const internal = 1;\n'.repeat(200);
		await writeFile(join(root, 'lib', 'large.js'), largeContent, 'utf8');

		const ctx = {
			sessionQuery: {
				readSurface: async () => ({ session: { cwd: root } }),
				filterEvents: async () => [],
			},
		};
		const config = { contextEnabled: true, maxContextChars: 10000, entitySearchEnabled: true, inventoryDepth: 2, inventoryMaxEntries: 60, inventoryScanDepth: 4, entityHitsMax: 6, gitLogCount: 5, recentToolScan: 40 };
		const draft = '优化 @lib/large.js';

		const signals = await gatherSignals(ctx, config, { session: { id: 'test-session' } }, draft, undefined);
		const pack = buildPack(signals, 'T1', 10000);

		ok(signals.refFiles.length > 0, 'should resolve ref');
		ok(signals.refFiles[0].meta !== undefined, 'should have compression meta');
		ok(signals.refFiles[0].meta.includes('已压缩'), 'meta should indicate compression');
		ok(pack.includes('[已压缩:'), 'pack should show compression marker');
		ok(pack.includes('省略'), 'pack should show ellipsis');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('gatherSignals + buildPack: lock file skips content', async () => {
	const root = await mkdtemp(join(tmpdir(), 'e2e-lock-'));
	try {
		const lockData = JSON.stringify({ name: 'test', lockfileVersion: 3, packages: {} }, null, 2).repeat(100);
		await writeFile(join(root, 'package-lock.json'), lockData, 'utf8');

		const ctx = {
			sessionQuery: {
				readSurface: async () => ({ session: { cwd: root } }),
				filterEvents: async () => [],
			},
		};
		const config = { contextEnabled: true, maxContextChars: 10000, entitySearchEnabled: true, inventoryDepth: 2, inventoryMaxEntries: 60, inventoryScanDepth: 4, entityHitsMax: 6, gitLogCount: 5, recentToolScan: 40 };
		const draft = '检查 @package-lock.json';

		const signals = await gatherSignals(ctx, config, { session: { id: 'test-session' } }, draft, undefined);
		const pack = buildPack(signals, 'T1', 10000);

		ok(signals.refFiles.length > 0, 'should resolve lock file ref');
		eq(signals.refFiles[0].content, '', 'lock file content should be empty');
		ok(signals.refFiles[0].meta.includes('已跳过内容'), 'meta should indicate skipped');
		ok(pack.includes('[已跳过内容: package-lock.json'), 'pack should show skip marker');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('gatherSignals + buildPack: workspace skeleton excludes noise dirs', async () => {
	const root = await mkdtemp(join(tmpdir(), 'e2e-noise-'));
	try {
		await mkdir(join(root, 'src'), { recursive: true });
		await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
		await mkdir(join(root, '.git'), { recursive: true });
		await writeFile(join(root, 'src', 'main.js'), 'export default 1;', 'utf8');
		await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = {};', 'utf8');
		await writeFile(join(root, '.git', 'config'), '[core]', 'utf8');

		const ctx = {
			sessionQuery: {
				readSurface: async () => ({ session: { cwd: root } }),
				filterEvents: async () => [],
			},
		};
		const config = { contextEnabled: true, maxContextChars: 10000, entitySearchEnabled: true, inventoryDepth: 2, inventoryMaxEntries: 60, inventoryScanDepth: 4, entityHitsMax: 6, gitLogCount: 5, recentToolScan: 40 };
		const draft = '分析项目结构';

		const signals = await gatherSignals(ctx, config, { session: { id: 'test-session' } }, draft, undefined);
		const tier = routeTier(signals, extractPathMentions(draft));
		const pack = buildPack(signals, tier, 10000);

		ok(pack.includes('src/'), 'pack should include src dir');
		ok(pack.includes('已跳过 node_modules/.git/dist 等'), 'pack header should mention skipped dirs');
		ok(!signals.workspace.files.some(f => f.includes('node_modules')), 'workspace files should not include node_modules content');
		ok(!signals.workspace.files.some(f => f.includes('.git')), 'workspace files should not include .git content');
		ok(pack.includes('main.js'), 'pack should list files in src');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('gatherSignals + buildPack: T2 tier includes project facts but not session signals', async () => {
	const root = await mkdtemp(join(tmpdir(), 'e2e-t2-'));
	try {
		await mkdir(join(root, 'src'), { recursive: true });
		await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo-app', type: 'module', scripts: { test: 'vitest', build: 'vite build' }, dependencies: { react: '^19' } }), 'utf8');
		await writeFile(join(root, 'README.md'), '# Demo App\n\nA sample application.', 'utf8');
		await writeFile(join(root, 'src', 'index.js'), 'export default ;', 'utf8');

		const ctx = {
			sessionQuery: {
				readSurface: async () => ({ session: { cwd: root } }),
				filterEvents: async () => [],
			},
		};
		const config = { contextEnabled: true, maxContextChars: 10000, entitySearchEnabled: true, inventoryDepth: 2, inventoryMaxEntries: 60, inventoryScanDepth: 4, entityHitsMax: 6, gitLogCount: 5, recentToolScan: 40 };
		const draft = '优化这个项目';

		const signals = await gatherSignals(ctx, config, { session: { id: 'test-session' } }, draft, undefined);
		const tier = routeTier(signals, extractPathMentions(draft));
		const pack = buildPack(signals, tier, 10000);

		eq(tier, 'T2', 'should route to T2 (project-aware) tier');
		ok(pack.includes('[项目清单要点'), 'pack should include manifest section');
		ok(pack.includes('demo-app'), 'pack should include package name');
		ok(pack.includes('test, build'), 'pack should list scripts');
		ok(pack.includes('dependencies(1): react'), 'pack should list dependencies');
		ok(pack.includes('[README 摘要'), 'pack should include README section');
		ok(pack.includes('Demo App'), 'pack should include README content');
		doesNotMatch(pack, /本会话最近操作/, 'T2 should NOT include recent session files');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('gatherSignals: contextEnabled=false returns undefined', async () => {
	const ctx = {
		sessionQuery: {
			readSurface: async () => ({ session: { cwd: '/some/path' } }),
			filterEvents: async () => [],
		},
	};
	const config = { contextEnabled: false };
	const draft = '分析项目';

	const signals = await gatherSignals(ctx, config, { session: { id: 'test' } }, draft, undefined);
	eq(signals, undefined, 'should return undefined when context disabled');
});

test('buildPack: T3 (greenfield) returns empty pack', () => {
	const signals = {
		cwd: undefined,
		refFiles: [],
		refMisses: [],
		recent: { files: [], toolCount: 0 },
		git: { changed: [], diffStat: '', changedCount: 0 },
		project: { labels: [], entryCount: 0, names: [] },
		workspace: { skeleton: [], dirFiles: new Map(), files: [], dirs: [], truncated: false },
		manifests: '',
		readme: { file: undefined, text: '' },
		tests: '',
		gitLog: { branch: undefined, commits: [] },
		entities: { hits: [], searched: [] },
	};
	const pack = buildPack(signals, 'T3', 10000);
	eq(pack, '', 'T3 should return empty pack');
});

test('frameDraft: pack content survives JSON encoding', () => {
	const draft = '优化 @"file with spaces.js"';
	const pack = '[引用文件]\n- file with spaces.js\n```\nconst x = "quoted \'string\'";\n```';
	const framed = frameDraft(draft, pack);
	ok(framed.includes(JSON.stringify({ draft })), 'JSON-encoded draft should be present');
	ok(framed.includes('file with spaces.js'), 'file path should be preserved');
	ok(framed.includes("const x = \"quoted 'string'\""), 'code content should be preserved');
});
