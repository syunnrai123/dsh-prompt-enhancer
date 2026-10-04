#!/usr/bin/env node
/**
 * Quick verification script: prove context gathering works end-to-end.
 * Usage: node verify-context-works.mjs
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { __internals } = await import('./lib/index.js');
const { gatherSignals, routeTier, buildPack, frameDraft, extractPathMentions } = __internals;

console.log('=== dsh-prompt-enhancer 上下文采集生效性验证 ===\n');

const root = await mkdtemp(join(tmpdir(), 'verify-ctx-'));
let allPassed = true;

try {
	// 创建测试工作区
	await mkdir(join(root, 'src'), { recursive: true });
	await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });

	await writeFile(join(root, 'src', 'app.js'),
		'export const VERSION = "1.0.0";\nexport function main() { return 42; }\n// 这是一个应用入口文件\n',
		'utf8');

	await writeFile(join(root, 'package.json'),
		JSON.stringify({ name: 'demo-app', type: 'module', scripts: { test: 'vitest', build: 'tsc' }, dependencies: { react: '^19' } }, null, 2),
		'utf8');

	await writeFile(join(root, 'package-lock.json'),
		JSON.stringify({ name: 'demo-app', lockfileVersion: 3, packages: {} }, null, 2).repeat(50),
		'utf8');

	await writeFile(join(root, 'README.md'),
		'# Demo App\n\n这是一个演示项目。\n',
		'utf8');

	await writeFile(join(root, 'node_modules', 'dep', 'index.js'),
		'module.exports = {};',
		'utf8');

	// 模拟 DSH 上下文
	const ctx = {
		sessionQuery: {
			readSurface: async () => ({ session: { cwd: root } }),
			filterEvents: async () => [],
		},
	};

	const config = {
		contextEnabled: true,
		maxContextChars: 10000,
		entitySearchEnabled: true,
		inventoryDepth: 2,
		inventoryMaxEntries: 60,
		inventoryScanDepth: 4,
		entityHitsMax: 6,
		gitLogCount: 5,
		recentToolScan: 40
	};

	// 测试 1：@-引用文件采集
	console.log('✓ 测试 1：@-引用文件采集');
	const draft1 = '检查 @src/app.js 和 @package-lock.json 的内容';
	const signals1 = await gatherSignals(ctx, config, { session: { id: 'test-1' } }, draft1, undefined);
	const tier1 = routeTier(signals1, extractPathMentions(draft1));
	const pack1 = buildPack(signals1, tier1, 10000);
	const framed1 = frameDraft(draft1, pack1);

	if (tier1 !== 'T1') {
		console.error('  ✗ 应该路由到 T1 档位，实际：', tier1);
		allPassed = false;
	} else {
		console.log('  ✓ 正确路由到 T1 档位');
	}

	if (!pack1.includes('[引用文件')) {
		console.error('  ✗ pack 缺少 [引用文件] 段');
		allPassed = false;
	} else {
		console.log('  ✓ pack 包含 [引用文件] 段');
	}

	if (!pack1.includes('src/app.js') || !pack1.includes('VERSION')) {
		console.error('  ✗ pack 缺少 app.js 内容');
		allPassed = false;
	} else {
		console.log('  ✓ app.js 内容出现在 pack 中');
	}

	if (!pack1.includes('[已跳过内容: package-lock.json')) {
		console.error('  ✗ 锁文件应该跳过内容');
		allPassed = false;
	} else {
		console.log('  ✓ 锁文件正确跳过内容，只输出元信息');
	}

	if (!framed1.includes('--- context pack (verified facts only) ---')) {
		console.error('  ✗ framed prompt 缺少 context pack 标记');
		allPassed = false;
	} else {
		console.log('  ✓ context pack 正确拼接进最终 prompt');
	}

	console.log('');

	// 测试 2：T2 档位（项目感知）
	console.log('✓ 测试 2：T2 档位（项目感知，无 @ 引用）');
	const draft2 = '优化这个项目的性能';
	const signals2 = await gatherSignals(ctx, config, { session: { id: 'test-2' } }, draft2, undefined);
	const tier2 = routeTier(signals2, extractPathMentions(draft2));
	const pack2 = buildPack(signals2, tier2, 10000);

	if (tier2 !== 'T2') {
		console.error('  ✗ 应该路由到 T2 档位，实际：', tier2);
		allPassed = false;
	} else {
		console.log('  ✓ 正确路由到 T2 档位');
	}

	if (!pack2.includes('[项目清单要点')) {
		console.error('  ✗ pack 缺少项目清单');
		allPassed = false;
	} else {
		console.log('  ✓ pack 包含项目清单');
	}

	if (!pack2.includes('demo-app') || !pack2.includes('test, build')) {
		console.error('  ✗ 清单内容不完整');
		allPassed = false;
	} else {
		console.log('  ✓ 清单包含包名和脚本列表');
	}

	if (!pack2.includes('[README 摘要')) {
		console.error('  ✗ pack 缺少 README');
		allPassed = false;
	} else {
		console.log('  ✓ pack 包含 README 摘要');
	}

	if (pack2.includes('本会话最近操作')) {
		console.error('  ✗ T2 不应该包含会话信号');
		allPassed = false;
	} else {
		console.log('  ✓ T2 正确排除会话内信号');
	}

	console.log('');

	// 测试 3：噪声目录过滤
	console.log('✓ 测试 3：噪声目录过滤');
	if (signals2.workspace.files.some(f => f.includes('node_modules'))) {
		console.error('  ✗ workspace.files 不应包含 node_modules');
		allPassed = false;
	} else {
		console.log('  ✓ workspace.files 正确排除 node_modules');
	}

	if (!signals2.workspace.files.includes('src/app.js')) {
		console.error('  ✗ workspace.files 应该包含 src/app.js');
		allPassed = false;
	} else {
		console.log('  ✓ workspace.files 包含正常源码文件');
	}

	console.log('');

	// 测试 4：contextEnabled=false
	console.log('✓ 测试 4：contextEnabled=false 返回 T0');
	const configDisabled = { ...config, contextEnabled: false };
	const signals3 = await gatherSignals(ctx, configDisabled, { session: { id: 'test-3' } }, draft2, undefined);
	if (signals3 !== undefined) {
		console.error('  ✗ contextEnabled=false 应该返回 undefined');
		allPassed = false;
	} else {
		console.log('  ✓ 正确返回 undefined');
	}

	const tier3 = routeTier(signals3, []);
	if (tier3 !== 'T0') {
		console.error('  ✗ 应该路由到 T0，实际：', tier3);
		allPassed = false;
	} else {
		console.log('  ✓ 正确路由到 T0（纯改写）');
	}

	console.log('');

	// 总结
	console.log('='.repeat(60));
	if (allPassed) {
		console.log('✅ 所有验证通过！上下文采集完全生效。');
		console.log('');
		console.log('验证了：');
		console.log('  • @-引用文件被采集并出现在 pack 中');
		console.log('  • 锁文件跳过内容只输出元信息');
		console.log('  • pack 通过 frameDraft() 拼接进最终 prompt');
		console.log('  • T1/T2 档位路由正确');
		console.log('  • 项目清单、README、工作区骨架被采集');
		console.log('  • T2 排除会话内信号');
		console.log('  • node_modules 等噪声目录被过滤');
		console.log('  • contextEnabled=false 正确降级为 T0');
		process.exit(0);
	} else {
		console.error('❌ 部分验证失败，请查看上方错误。');
		process.exit(1);
	}

} catch (error) {
	console.error('❌ 验证过程出错：', error.message);
	console.error(error.stack);
	process.exit(1);
} finally {
	await rm(root, { recursive: true, force: true });
}
