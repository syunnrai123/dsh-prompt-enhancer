/**
 * node:test suite for the runtime machinery: cache behaviour, the shared
 * timeout deadline, and the cache-key composition (draft / route / pack).
 * Run with `node --test test/`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config, apply, __internals } from '../lib/index.js';

const { createCache, withDeadline, digest, normalizeTimeout, gatherSignals, normalizeDebounce } = __internals;

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
function* okGen() {
	yield { type: 'text-delta', text: '## 目标\n做一件事' };
	yield { type: 'finish', reason: { kind: 'stop' } };
}

/** Register the real plugin on a fake ctx with a scripted llm; count stream calls
 *  and gather invocations (readSurface) so prefetch short-circuiting is visible.
 *  The silent prefetch transport is captured through ctx.provide, mirroring how
 *  the api-gateway discovers the host's 'prompt-enhancer' SRC remote. */
function makeHarness({ routeOf, timeout = 5000, gen = okGen, surfaceDelay = 0 }) {
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
	apply(ctx, Config({ timeout }));
	return {
		calls,
		handlers,
		surfaceCalls: () => surfaceCalls,
		setRoute: (route) => { currentRoute = route; },
		run: (draft) => handlers.enhance({ agent, rawInput: draft }),
		prefetch: (draft) => services.promptEnhancer.prefetch('s1', draft),
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

test('timeout: defaults to 30000ms when unset', () => {
	assert.equal(normalizeTimeout(Config({})), 30_000);
});

test('timeout: a custom value is honored', () => {
	assert.equal(normalizeTimeout(Config({ timeout: 1500 })), 1500);
	assert.equal(normalizeTimeout(Config({ timeout: 2500.9 })), 2500); // floats floor
	assert.equal(normalizeTimeout(Config({ timeout: '2500' })), 2500); // numeric strings accepted
});

test('timeout: invalid values fall back to 30000ms without throwing', () => {
	assert.equal(normalizeTimeout(Config({ timeout: -5 })), 30_000);
	assert.equal(normalizeTimeout(Config({ timeout: 0 })), 30_000);
	assert.equal(normalizeTimeout(Config({ timeout: 'abc' })), 30_000);
	assert.equal(normalizeTimeout(Config({ timeout: null })), 30_000);
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

// ── pre-collection debounce configuration ──────────────────────

test('debounce: normalization', () => {
	assert.equal(normalizeDebounce(Config({})), 800);
	assert.equal(normalizeDebounce(Config({ precollectDebounce: 1500 })), 1500);
	assert.equal(normalizeDebounce(Config({ precollectDebounce: 0 })), 0);
	assert.equal(normalizeDebounce(Config({ precollectDebounce: -5 })), 0);
	assert.equal(normalizeDebounce(Config({ precollectDebounce: 'abc' })), 800);
});

// ── pre-collection flow through the real apply() ───────────────

test('prefetch: transported over the SRC remote, never as a slash command', () => {
	const h = makeHarness({});
	// No enhance-prefetch command is registered: the slash menu stays clean and
	// the durable command log never gains a row for pre-collection.
	assert.deepEqual(Object.keys(h.handlers), ['enhance']);
	assert.equal(typeof h.prefetch, 'function'); // the RPC service took its place
});

test('prefetch: an empty draft skips silently', async () => {
	const h = makeHarness({});
	assert.deepEqual(await h.prefetch('   '), { skipped: true });
	assert.equal(h.surfaceCalls(), 0);
});

test('prefetch: pre-collected context short-circuits the gather phase', async () => {
	const h = makeHarness({});
	const pre = await h.prefetch('分析下当前项目');
	assert.deepEqual(pre, { stored: true }); // silent transport: a plain reply object, no visible text
	const gathers = h.surfaceCalls();
	const result = await h.run('分析下当前项目');
	assert.equal(result.kind, 'success');
	assert.equal(h.surfaceCalls(), gathers); // no second gather: no new git/ripgrep work
	assert.ok(result.text.includes('预采集命中')); // the pre-collected pack was stored and consumed
	assert.equal(h.calls.length, 1); // exactly one model call, same cache key inputs
});

test('prefetch: a different draft falls back to a fresh gather', async () => {
	const h = makeHarness({});
	await h.prefetch('草稿甲');
	const gathers = h.surfaceCalls();
	const result = await h.run('草稿乙');
	assert.equal(result.kind, 'success');
	assert.equal(h.surfaceCalls(), gathers + 1);
	assert.equal(result.text.includes('预采集命中'), false);
});

test('prefetch: single-flight supersedes a slow earlier run', async () => {
	const h = makeHarness({ surfaceDelay: 150 });
	const first = h.prefetch('慢慢采集');
	await sleep(30);
	const second = await h.prefetch('新的草稿');
	assert.deepEqual(await first, { stored: false }); // cancelled: nothing stored
	assert.deepEqual(second, { stored: true }); // completed and stored
	const gathers = h.surfaceCalls();
	const result = await h.run('新的草稿');
	assert.equal(result.kind, 'success');
	assert.equal(h.surfaceCalls(), gathers); // the superseding run is the one consumed
});

test('prefetch: formal enhance aborts an in-flight pre-collection', async () => {
	const h = makeHarness({ surfaceDelay: 150 });
	const inFlight = h.prefetch('还在采集时用户就点了增强');
	await sleep(30);
	const result = await h.run('还在采集时用户就点了增强');
	assert.equal(result.kind, 'success');
	assert.equal(h.calls.length, 1); // its own gather ran (the prefetch had not stored)
	assert.deepEqual(await inFlight, { stored: false }); // aborted silently
});

// ── end-to-end cache behaviour through the real apply() ────────

test('flow: an identical draft hits the cache without a second call', async () => {
	const h = makeHarness({});
	const first = await h.run('分析下当前项目');
	const second = await h.run('分析下当前项目');
	assert.equal(h.calls.length, 1);
	assert.equal(first.kind, 'success');
	assert.ok(first.text.includes('## 目标'));
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
	assert.ok(result.text.includes('## 目标'));
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
