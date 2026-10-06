/**
 * node:test suite for the runtime machinery: cache behaviour, the shared
 * timeout deadline, the cache-key composition (draft / route / pack), and the
 * four-level route fallback (config pair / session / runtime manifests / built-in).
 * Run with `node --test test/`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, apply, __internals } from '../lib/index.js';

const {
	createCache, withDeadline, digest, normalizeTimeout, gatherSignals,
	resolveRoute, routeFromRuntimeDoc, readRuntimeRoute, runtimeRouteBases, setRuntimeRoute, resetRuntimeRoute, DEFAULT_ROUTE, classifyTransportError,
} = __internals;

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
function* okGen() {
	yield { type: 'text-delta', text: '先梳理当前项目的目录结构与依赖清单，再分析核心模块的调用关系，最后按优先级给出改进清单。' };
	yield { type: 'finish', reason: { kind: 'stop' } };
}

/** Register the real plugin on a fake ctx with a scripted llm; count stream calls
 *  and gather invocations (readSurface) so context-gathering is observable. */
function makeHarness({ routeOf, timeout = 5000, gen = okGen, surfaceDelay = 0, config = {} }) {
	const calls = [];
	const handlers = {};
	const services = {};
	let surfaceCalls = 0;
	let currentRoute = { provider: 'p', model: 'm' };
	const agent = {
		session: {
			id: 's1',
			requestHeader: () => ({ config: routeOf ? routeOf() : currentRoute }),
		},
	};
	const ctx = {
		get: (key) => services[key],
		provide: (name, value) => { services[name] = value; },
		commands: { register: (definition) => { handlers[definition.name] = definition.handler; } },
		llm: {
			async *stream(options) {
				calls.push(options);
				yield* gen();
			},
		},
		sessionQuery: {
			filterEvents: async () => [],
			readSurface: async () => {
				surfaceCalls += 1;
				if (surfaceDelay > 0 && surfaceCalls === 1) await sleep(surfaceDelay);
				return { session: { cwd: undefined } };
			},
		},
	};
	apply(ctx, Config({ timeout, ...config }));
	return {
		calls,
		handlers,
		surfaceCalls: () => surfaceCalls,
		setRoute: (route) => { currentRoute = route; },
		run: (draft, signal) => handlers.enhance({ agent, rawInput: draft, signal }),
	};
}

// ── createCache (LRU) ──────────────────────────────────────────

test('cache: evicts the least recently used entry', () => {
	const cache = createCache(2);
	cache.set('a', 1);
	cache.set('b', 2);
	assert.equal(cache.get('a'), 1); // refresh a past b
	cache.set('c', 3);
	assert.equal(cache.get('b'), undefined);
	assert.equal(cache.get('a'), 1);
	assert.equal(cache.get('c'), 3);
});

test('cache: overwriting a key does not grow the map', () => {
	const cache = createCache(1);
	cache.set('a', 1);
	cache.set('a', 2);
	assert.equal(cache.get('a'), 2);
	cache.set('b', 3);
	assert.equal(cache.get('a'), undefined);
	assert.equal(cache.get('b'), 3);
});

// ── withDeadline (timeout semantics) ───────────────────────────

test('deadline: fires with the TIMEOUT code and message', async () => {
	const deadline = withDeadline(undefined, 20);
	await sleep(60);
	assert.equal(deadline.signal.aborted, true);
	assert.equal(deadline.signal.reason.code, 'PROMPT_ENHANCE_TIMEOUT');
	assert.match(deadline.signal.reason.message, /增强超时（20ms）/);
});

test('deadline: dispose cancels the timer', async () => {
	const deadline = withDeadline(undefined, 20);
	deadline.dispose();
	await sleep(60);
	assert.equal(deadline.signal.aborted, false);
});

test('deadline: forwards an outer abort reason', async () => {
	const outer = new AbortController();
	const deadline = withDeadline(outer.signal, 10_000);
	const reason = new Error('user cancelled');
	outer.abort(reason);
	assert.equal(deadline.signal.aborted, true);
	assert.equal(deadline.signal.reason, reason);
	deadline.dispose();
});

// ── digest (cache-key component) ───────────────────────────────

test('digest: stable, distinguishing, length-tagged', () => {
	assert.equal(digest('abc'), digest('abc'));
	assert.notEqual(digest('abc'), digest('abd'));
	assert.ok(digest('abc').endsWith('-3'));
});

// ── timeout configuration (normalizeTimeout) ───────────────────

test('timeout: defaults to 45000ms when unset', () => {
	assert.equal(normalizeTimeout(Config({})), 45_000);
});

test('timeout: a custom value is honored', () => {
	assert.equal(normalizeTimeout(Config({ timeout: 1500 })), 1500);
	assert.equal(normalizeTimeout(Config({ timeout: 2500.9 })), 2500); // floats floor
	assert.equal(normalizeTimeout(Config({ timeout: '2500' })), 2500); // numeric strings accepted
});

test('timeout: invalid values fall back to 45000ms without throwing', () => {
	assert.equal(normalizeTimeout(Config({ timeout: -5 })), 45_000);
	assert.equal(normalizeTimeout(Config({ timeout: 0 })), 45_000);
	assert.equal(normalizeTimeout(Config({ timeout: 'abc' })), 45_000);
	assert.equal(normalizeTimeout(Config({ timeout: null })), 45_000);
});

test('timeout: legacy timeoutMs alias still honored', () => {
	assert.equal(normalizeTimeout(Config({ timeoutMs: 250 })), 250);
	assert.equal(normalizeTimeout(Config({ timeout: 100, timeoutMs: 250 })), 100);
});

test('deadline: abort() cancels early with the caller reason', async () => {
	const deadline = withDeadline(undefined, 10_000);
	const reason = new Error('superseded');
	deadline.abort(reason);
	assert.equal(deadline.signal.aborted, true);
	assert.equal(deadline.signal.reason, reason);
	deadline.dispose();
});

// ── end-to-end cache behaviour through the real apply() ────────

test('flow: an identical draft hits the cache without a second call', async () => {
	const h = makeHarness({});
	const first = await h.run('分析下当前项目');
	const second = await h.run('分析下当前项目');
	assert.equal(h.calls.length, 1);
	assert.equal(first.kind, 'success');
	assert.ok(first.text.includes('目录结构'));
	assert.ok(second.text.includes('缓存命中'));
});

test('flow: a different draft misses the cache', async () => {
	const h = makeHarness({});
	await h.run('分析下当前项目');
	await h.run('优化下当前项目');
	assert.equal(h.calls.length, 2);
});

test('flow: a route change misses the cache', async () => {
	const h = makeHarness({});
	await h.run('分析下当前项目');
	h.setRoute({ provider: 'p', model: 'other-model' });
	await h.run('分析下当前项目');
	assert.equal(h.calls.length, 2);
	assert.equal(h.calls[1].model, 'other-model');
});

test('flow: timeout aborts with a clear error and is never cached', async () => {
	const h = makeHarness({
		timeout: 60,
		gen: async function* slowGen() {
			await sleep(300);
			yield { type: 'finish', reason: { kind: 'stop' } };
		},
	});
	const first = await h.run('慢慢增强这个草稿');
	assert.equal(first.kind, 'error');
	assert.match(first.text, /增强超时（60ms）/);
	const second = await h.run('慢慢增强这个草稿');
	assert.equal(h.calls.length, 2); // errors must not poison the cache
	assert.match(second.text, /增强超时/);
});

test('flow: a configured custom timeout drives the deadline end to end', async () => {
	const h = makeHarness({
		timeout: 50,
		gen: async function* slowGen() {
			await sleep(250);
			yield { type: 'text-delta', text: 'too late' };
			yield { type: 'finish', reason: { kind: 'stop' } };
		},
	});
	const result = await h.run('自定义超时值测试');
	assert.equal(result.kind, 'error');
	assert.match(result.text, /增强超时（50ms）/); // the message carries the configured value
});

test('flow: a generous custom timeout leaves the happy path intact', async () => {
	const h = makeHarness({ timeout: 10_000 });
	const result = await h.run('正常增强这个草稿');
	assert.equal(result.kind, 'success');
	assert.ok(result.text.includes('目录结构'));
});

test('flow: the deadline covers the gathering phase, not just generation', async () => {
	// readSurface stalls past the 60ms deadline; the model must never be called.
	const h = makeHarness({ timeout: 60, surfaceDelay: 300 });
	const result = await h.run('采集也要受预算约束');
	assert.equal(result.kind, 'error');
	assert.match(result.text, /增强超时（60ms）/);
	assert.equal(h.calls.length, 0);
});

test('gather: an already-aborted signal rejects before any work', async () => {
	const controller = new AbortController();
	controller.abort(new Error('stop before gathering'));
	await assert.rejects(
		() => gatherSignals({}, Config({ provider: 'p', model: 'm' }), { session: { id: 'x' } }, '草稿', controller.signal),
		/stop before gathering/,
	);
});

test('flow: the corrective retry spends the same end-to-end budget', async () => {
	// First attempt fails fast with an unsupported effort field; the retry would
	// succeed, but the 80ms shared deadline is already spent by the slow reply.
	let attemptNo = 0;
	const h = makeHarness({
		timeout: 80,
		gen: async function* scripted() {
			attemptNo += 1;
			if (attemptNo === 1) {
				yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider "x" model "y" does not support reasoning effort "off"' } } };
				return;
			}
			await sleep(400); // retry arrives after the shared deadline fired
			yield { type: 'text-delta', text: 'late' };
			yield { type: 'finish', reason: { kind: 'stop' } };
		},
	});
	const result = await h.run('重试预算测试');
	assert.equal(result.kind, 'error');
	assert.match(result.text, /增强超时（80ms）/);
});

// ── resolveRoute: the four-level fallback ──────────────────────

const sessionAgent = (route) => ({ session: { id: 's1', requestHeader: () => ({ config: route }) } });
const throwingAgent = { session: { requestHeader: () => { throw new Error('no header in a blank session'); } } };

test('route: the built-in default is the DSH default model', () => {
	assert.deepEqual(DEFAULT_ROUTE, { provider: 'guomo', model: 'deepseek-v4.1-flash' });
});

test('route: an explicit config pair pins the route over the session', async () => {
	const route = await resolveRoute(
		Config({ provider: 'pin-p', model: 'pin-m' }),
		sessionAgent({ provider: 's-p', model: 's-m' }),
	);
	assert.deepEqual(route, { provider: 'pin-p', model: 'pin-m', source: 'config' });
});

test('route: an empty-string pair counts as unset and falls through to the session', async () => {
	const route = await resolveRoute(
		Config({ provider: '', model: '' }),
		sessionAgent({ provider: 's-p', model: 's-m' }),
	);
	assert.deepEqual(route, { provider: 's-p', model: 's-m', source: 'session' });
});

test('route: half a pair still throws the pairing error', async () => {
	await assert.rejects(
		() => resolveRoute(Config({ provider: 'pin-p' }), sessionAgent({ provider: 's-p', model: 's-m' })),
		/prompt-enhancer: provider 与 model 必须成对配置/,
	);
});

test('route: the session route is followed when no pair is configured', async () => {
	const route = await resolveRoute(Config({}), sessionAgent({ provider: 's-p', model: 's-m' }));
	assert.deepEqual(route, { provider: 's-p', model: 's-m', source: 'session' });
});

test('route: a blank session (no logged route) picks up the runtime level', async () => {
	const route = await resolveRoute(
		Config({}),
		sessionAgent(undefined),
		{ runtime: { provider: 'rt-p', model: 'rt-m' } },
	);
	assert.deepEqual(route, { provider: 'rt-p', model: 'rt-m', source: 'runtime' });
});

test('route: a session route outranks the runtime level', async () => {
	const route = await resolveRoute(
		Config({}),
		sessionAgent({ provider: 's-p', model: 's-m' }),
		{ runtime: { provider: 'rt-p', model: 'rt-m' } },
	);
	assert.deepEqual(route, { provider: 's-p', model: 's-m', source: 'session' });
});

test('route: a runtime entry missing its model half is skipped', async () => {
	const route = await resolveRoute(
		Config({}),
		sessionAgent(undefined),
		{ runtime: { provider: 'rt-p' } },
	);
	assert.deepEqual(route, { provider: 'guomo', model: 'deepseek-v4.1-flash', source: 'builtin' });
});

test('route: a blank session with no runtime entry lands on the built-in default', async () => {
	const route = await resolveRoute(Config({}), sessionAgent(undefined), { runtime: undefined });
	assert.deepEqual(route, { provider: 'guomo', model: 'deepseek-v4.1-flash', source: 'builtin' });
});

test('route: a throwing requestHeader counts as no session route', async () => {
	const route = await resolveRoute(Config({}), throwingAgent, { runtime: undefined });
	assert.deepEqual(route, { provider: 'guomo', model: 'deepseek-v4.1-flash', source: 'builtin' });
});

test('route: all four levels failing throws the original untouched-draft error', async () => {
	await assert.rejects(
		() => resolveRoute(Config({}), sessionAgent(undefined), { runtime: undefined, builtin: undefined }),
		/prompt-enhancer: 当前会话还没有已记录的模型路由——请先发送一条消息，或在插件配置中显式指定 provider \+ model/,
	);
});

// ── routeFromRuntimeDoc (level-3 field probes) ─────────────────

test('runtime doc: top-level provider and model', () => {
	assert.deepEqual(routeFromRuntimeDoc({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm' });
});

test('runtime doc: dsh.agentDefaultModel nesting', () => {
	assert.deepEqual(
		routeFromRuntimeDoc({ name: 'x', dsh: { agentDefaultModel: { provider: 'p', model: 'm' } } }),
		{ provider: 'p', model: 'm' },
	);
});

test('runtime doc: bare defaultModel nesting', () => {
	assert.deepEqual(routeFromRuntimeDoc({ defaultModel: { provider: 'p', model: 'm' } }), { provider: 'p', model: 'm' });
});

test('runtime doc: missing, half-filled, or non-string fields skip', () => {
	assert.equal(routeFromRuntimeDoc({}), undefined);
	assert.equal(routeFromRuntimeDoc({ provider: 'p' }), undefined);
	assert.equal(routeFromRuntimeDoc({ provider: 3, model: 'm' }), undefined);
	assert.equal(routeFromRuntimeDoc(null), undefined);
	assert.equal(routeFromRuntimeDoc('nope'), undefined);
	assert.equal(routeFromRuntimeDoc([]), undefined);
});

// ── readRuntimeRoute (real filesystem probes) ──────────────────

test('runtime route: reads the default route out of the dsh package manifest', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dpenh-rt-'));
	try {
		await mkdir(join(root, '_dsh_src', 'dsh'), { recursive: true });
		await writeFile(
			join(root, '_dsh_src', 'dsh', 'package.json'),
			JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime', dsh: { agentDefaultModel: { provider: 'rt-p', model: 'rt-m' } } }),
			'utf8',
		);
		const route = await readRuntimeRoute([root]);
		assert.deepEqual(route, { provider: 'rt-p', model: 'rt-m' });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('runtime route: desktop-runtime.json outranks package.json', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dpenh-rt2-'));
	try {
		await mkdir(join(root, '_dsh_src', 'dsh'), { recursive: true });
		await writeFile(join(root, '_dsh_src', 'dsh', 'desktop-runtime.json'), JSON.stringify({ provider: 'dt-p', model: 'dt-m', files: [] }), 'utf8');
		await writeFile(join(root, '_dsh_src', 'dsh', 'package.json'), JSON.stringify({ provider: 'pk-p', model: 'pk-m' }), 'utf8');
		const route = await readRuntimeRoute([root]);
		assert.deepEqual(route, { provider: 'dt-p', model: 'dt-m' });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('runtime route: a malformed manifest falls through to the next one', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dpenh-rt3-'));
	try {
		await mkdir(join(root, '_dsh_src', 'dsh'), { recursive: true });
		await writeFile(join(root, '_dsh_src', 'dsh', 'desktop-runtime.json'), '{broken json', 'utf8');
		await writeFile(join(root, '_dsh_src', 'dsh', 'package.json'), JSON.stringify({ provider: 'pk-p', model: 'pk-m' }), 'utf8');
		const route = await readRuntimeRoute([root]);
		assert.deepEqual(route, { provider: 'pk-p', model: 'pk-m' });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('runtime route: no dsh manifests or no route fields skip the level', async () => {
	const empty = await mkdtemp(join(tmpdir(), 'dpenh-rt4-'));
	const fieldless = await mkdtemp(join(tmpdir(), 'dpenh-rt5-'));
	try {
		assert.equal(await readRuntimeRoute([empty]), undefined);
		await mkdir(join(fieldless, '_dsh_src', 'dsh'), { recursive: true });
		await writeFile(join(fieldless, '_dsh_src', 'dsh', 'package.json'), JSON.stringify({ name: 'x', version: '1' }), 'utf8');
		assert.equal(await readRuntimeRoute([fieldless]), undefined);
	} finally {
		await rm(empty, { recursive: true, force: true });
		await rm(fieldless, { recursive: true, force: true });
	}
});

test('runtime route: the base walk-up covers ancestors plus cwd', async () => {
	const root = await mkdtemp(join(tmpdir(), 'dpenh-rt6-'));
	try {
		const nested = join(root, 'a', 'b');
		const bases = runtimeRouteBases(nested);
		assert.ok(bases.includes(nested));
		assert.ok(bases.includes(join(root, 'a')));
		assert.ok(bases.includes(root));
		assert.ok(bases.includes(process.cwd()));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ── end-to-end: blank-session flows through the real apply() ───

test('flow: blank session without config enhances via the built-in default route', async () => {
	const h = makeHarness({ routeOf: () => undefined });
	setRuntimeRoute(undefined); // level 3 finds nothing in this deployment
	try {
		const result = await h.run('分析下当前项目');
		assert.equal(result.kind, 'success');
		assert.ok(result.text.includes('目录结构'));
		assert.equal(h.calls.length, 1);
		assert.equal(h.calls[0].provider, 'guomo');
		assert.equal(h.calls[0].model, 'deepseek-v4.1-flash');
		assert.ok(result.text.includes('内置默认'));
	} finally {
		resetRuntimeRoute();
	}
});

test('flow: blank session picks up the runtime default route when present', async () => {
	const h = makeHarness({ routeOf: () => undefined });
	setRuntimeRoute({ provider: 'rt-p', model: 'rt-m' });
	try {
		const result = await h.run('分析下当前项目');
		assert.equal(result.kind, 'success');
		assert.equal(h.calls.length, 1);
		assert.equal(h.calls[0].provider, 'rt-p');
		assert.equal(h.calls[0].model, 'rt-m');
		assert.ok(result.text.includes('运行时默认'));
	} finally {
		resetRuntimeRoute();
	}
});

test('flow: a runtime-route change misses the cache (key carries the resolved route)', async () => {
	const h = makeHarness({ routeOf: () => undefined });
	setRuntimeRoute({ provider: 'rt-a', model: 'm' });
	try {
		await h.run('分析下当前项目');
		setRuntimeRoute({ provider: 'rt-b', model: 'm' });
		await h.run('分析下当前项目');
		assert.equal(h.calls.length, 2);
		assert.equal(h.calls[1].provider, 'rt-b');
		// Back on the first route the cached entry is found again.
		setRuntimeRoute({ provider: 'rt-a', model: 'm' });
		const third = await h.run('分析下当前项目');
		assert.equal(h.calls.length, 2);
		assert.ok(third.text.includes('缓存命中'));
	} finally {
		resetRuntimeRoute();
	}
});

test('flow: an explicit config pair pins the route even with a session route present', async () => {
	const h = makeHarness({ config: { provider: 'pin-p', model: 'pin-m' } });
	const result = await h.run('分析下当前项目');
	assert.equal(result.kind, 'success');
	assert.equal(h.calls[0].provider, 'pin-p');
	assert.equal(h.calls[0].model, 'pin-m');
	assert.ok(result.text.includes('配置指定'));
});

test('flow: an incomplete config pair fails with the untouched-draft error format', async () => {
	const h = makeHarness({ config: { provider: 'pin-p' } });
	const result = await h.run('分析下当前项目');
	assert.equal(result.kind, 'error');
	assert.match(result.text, /增强失败：prompt-enhancer: provider 与 model 必须成对配置/);
	assert.match(result.text, /原始草稿未被修改，可直接发送。/);
	assert.equal(h.calls.length, 0); // the model is never called for a config error
});

// ── failure classification: timeout vs cancel vs upstream drop ─

test('flow: a mid-stream transport drop during the deadline surfaces the timeout, not "terminated"', async () => {
	const h = makeHarness({
		timeout: 60,
		gen: async function* dropsMidStream() {
			await sleep(150); // the deadline fires first; the stream then dies bare
			throw new TypeError('terminated');
		},
	});
	const first = await h.run('超时途中连接被掐断');
	assert.equal(first.kind, 'error');
	assert.match(first.text, /增强超时（60ms）/);
	assert.match(first.text, /原始草稿未被修改，可直接发送。/);
	assert.ok(!first.text.includes('terminated'), 'bare transport error must not leak');
});

test('flow: an upstream transport drop auto-retries once, then settles classified', async () => {
	const h = makeHarness({
		timeout: 5000,
		gen: async function* dropsImmediately() {
			yield { type: 'text-delta', text: '部分输出' };
			throw new TypeError('terminated');
		},
	});
	const first = await h.run('上游掐断测试');
	assert.equal(first.kind, 'error');
	assert.match(first.text, /上游连接中断（terminated）/);
	assert.match(first.text, /已自动重试仍失败/);
	assert.match(first.text, /原始草稿未被修改，可直接发送。/);
	assert.ok(!first.text.includes('增强超时'));
	assert.equal(h.calls.length, 2); // one automatic retry within the same budget
	const second = await h.run('上游掐断测试');
	assert.equal(h.calls.length, 4); // failures are never cached, so a retry run regenerates
});

test('flow: a single upstream drop recovers through the automatic retry', async () => {
	let attempts = 0;
	const h = makeHarness({
		timeout: 5000,
		gen: function* dropsOnce() {
			attempts += 1;
			if (attempts === 1) throw new TypeError('terminated');
			yield { type: 'text-delta', text: '恢复后的完整结果' };
			yield { type: 'finish', reason: { kind: 'stop' } };
		},
	});
	const result = await h.run('断流恢复测试');
	assert.equal(result.kind, 'success');
	assert.ok(result.text.includes('恢复后的完整结果'));
	assert.ok(result.text.includes('连接中断后自动重试'));
	assert.equal(h.calls.length, 2);
});

test('flow: a host-side abort (pi-ai) belongs to the cancel family, not 增强失败', async () => {
	const h = makeHarness({
		timeout: 5000,
		gen: async function* hostAborts() {
			throw new Error('pi-ai request aborted by caller');
		},
	});
	const result = await h.run('宿主中止测试');
	assert.equal(result.kind, 'error');
	assert.match(result.text, /被宿主中止/);
	assert.match(result.text, /原始草稿未被修改，可直接发送。/);
	assert.ok(!result.text.includes('增强失败：'));
});

test('flow: a caller cancel is distinguished from a timeout and keeps the draft safe', async () => {
	const h = makeHarness({ timeout: 5000 });
	const cancelled = new AbortController();
	cancelled.abort(); // no reason → the plain cancel note
	const plain = await h.run('取消测试', cancelled.signal);
	assert.equal(plain.kind, 'error');
	assert.match(plain.text, /已取消/);
	assert.ok(!plain.text.includes('增强超时'));
	assert.match(plain.text, /原始草稿未被修改，可直接发送。/);

	const withReason = new AbortController();
	const pending = h.run('取消测试二', withReason.signal);
	withReason.abort(new Error('user stopped'));
	const result = await pending;
	assert.equal(result.kind, 'error');
	assert.match(result.text, /user stopped/);
	assert.match(result.text, /原始草稿未被修改，可直接发送。/);
});

test('transport: bare "terminated" is classified as an upstream drop, other errors pass through', () => {
	const wrapped = classifyTransportError(new TypeError('terminated'));
	assert.equal(wrapped?.code, 'PROMPT_ENHANCE_UPSTREAM_DROPPED');
	assert.match(wrapped?.message, /上游连接中断/);
	assert.equal(wrapped?.detail, 'terminated');
	assert.equal(classifyTransportError(new Error('boom')), undefined);
	assert.equal(classifyTransportError(undefined), undefined);
});

// ── prose output (no fixed section template) ───────────────────

test('prompt: the system prompt mandates concise prose, never a fixed section template', async () => {
	const h = makeHarness({});
	const result = await h.run('分析下当前项目');
	const system = h.calls[0].system;
	// No mandatory section skeleton in any wording.
	assert.ok(!system.includes('目标 / 需求 / 边界与约束 / 验收标准'));
	assert.ok(!/Markdown sections/.test(system));
	assert.ok(!/exactly these/.test(system));
	// The conciseness mandate and the kept semantic rules.
	assert.ok(system.includes('Keep it short'), 'brevity rule present');
	assert.ok(system.includes('no Markdown headings'), 'no-headings rule present');
	assert.ok(system.includes('at most three concrete paths'), 'path citation cap present');
	assert.ok(system.includes('two to four sentences'), 'length guide present');
	assert.ok(system.includes('默认：'), 'inline fallback marker kept');
	assert.ok(system.includes('待确认'), 'no open-question rule kept');
	// Removed verbosity drivers stay removed; the fallback rule is stated once.
	assert.ok(!system.includes('as much grounding as possible'));
	assert.ok(!system.includes('first what the task is'));
	assert.ok(!system.includes('cite the real paths'), 'no mandatory path-listing instruction');
	assert.equal(system.split('默认：…').length - 1, 1);
	assert.equal(result.kind, 'success');
	assert.ok(!result.text.includes('## '), 'enhanced output stays prose');
});
