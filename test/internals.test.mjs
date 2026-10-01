/** Pure-function unit tests for dsh-prompt-enhancer internals. */
import { Config, __internals } from '../lib/index.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  extractAtRefs, extractPathMentions, pathsFromToolDoc, routeTier, buildPack, digest, gatherRefFiles, signalSummary, nextAttempt, finishError,
  extractEntityTerms, manifestFacts, renderSkeleton, rankEntityHits, summarizeTests, walkWorkspace, gatherEntityHits, gatherSignals,
  cjkBigrams, rankCounted, manifestCandidates, readmeCandidates, emptySignals: emptySignalsOf,
} = __internals;
let failures = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`ok   ${name}`);
  else { failures++; console.error(`FAIL ${name}\n  actual:   ${a}\n  expected: ${e}`); }
}

// ── extractAtRefs ─────────────────────────────────────────────
eq('at: bare path', extractAtRefs('看下 @src/app.js 的逻辑'), ['src/app.js']);
eq('at: quoted with space', extractAtRefs('检查 @"my file.txt" 内容'), ['my file.txt']);
eq('at: absolute windows path', extractAtRefs('对比 @E:/x/y.py'), ['E:/x/y.py']);
eq('at: email not a ref', extractAtRefs('发邮件给 a@b.com'), []);
eq('at: multiple dedupe', extractAtRefs('@a.ts 和 @a.ts 与 @b.ts'), ['a.ts', 'b.ts']);

// ── extractPathMentions ───────────────────────────────────────
const m1 = extractPathMentions('修复 `lib/util.ts` 里的 bug，顺便看 src/index.ts');
eq('mention: backtick', m1.includes('lib/util.ts'), true);
eq('mention: slashed path', m1.includes('src/index.ts'), true);
eq('mention: bare word no path', extractPathMentions('hello world'), []);

// ── pathsFromToolDoc ──────────────────────────────────────────
eq('tool: read file_path', pathsFromToolDoc('read\n{"file_path":"D:/a/b.ts"}'), ['D:/a/b.ts']);
eq('tool: edit path', pathsFromToolDoc('str-replace-editor\n{"path":"src/x.md"}'), ['src/x.md']);
eq('tool: bash no path', pathsFromToolDoc('bash\n{"command":"ls -la"}'), []);
eq('tool: bad json', pathsFromToolDoc('read\nnot-json'), []);

// ── routeTier ─────────────────────────────────────────────────
const emptySignals = { cwd: undefined, refs: [], refFiles: [], refMisses: [], recent: { files: [], toolCount: 0 }, git: { changed: [], diffStat: '', changedCount: 0 }, project: { labels: [], entryCount: -1 } };
const emptyWs = { cwd: 'D:/w', refs: [], refFiles: [], refMisses: [], recent: { files: [], toolCount: 0 }, git: { changed: [], diffStat: '', changedCount: 0 }, project: { labels: [], entryCount: 0 } };
// Windows-style paths as the host actually reports them.
const busyNoHit = { cwd: 'D:\\w', refs: [], refFiles: [], refMisses: [], recent: { files: ['D:\\w\\src\\a.ts'], toolCount: 9 }, git: { changed: [' M src\\b.ts'], diffStat: '', changedCount: 1 }, project: { labels: ['Node.js / npm'], entryCount: 12 } };
const withRef = { ...busyNoHit, refFiles: [{ path: 'src/a.ts', content: 'x' }] };
eq('tier: no context -> T0', routeTier(undefined, []), 'T0');
eq('tier: no cwd -> T3', routeTier(emptySignals, []), 'T3');
eq('tier: empty workspace -> T3', routeTier(emptyWs, []), 'T3');
eq('tier: refFiles -> T1', routeTier(withRef, []), 'T1');
eq('tier: forward-slash entity hits backslash recent -> T1', routeTier(busyNoHit, ['src/a.ts']), 'T1');
eq('tier: forward-slash entity hits backslash git -> T1', routeTier(busyNoHit, ['src/b.ts']), 'T1');
eq('tier: bare basename entity hits -> T1', routeTier(busyNoHit, ['a.ts']), 'T1');
eq('tier: busy no hit -> T2', routeTier(busyNoHit, ['zzz.cs']), 'T2');

// ── buildPack ─────────────────────────────────────────────────
eq('pack: T2 project facts only', buildPack(busyNoHit, 'T2', 6000).startsWith('[项目类型]'), true);
eq('pack: T2 excludes recent files', buildPack(busyNoHit, 'T2', 6000).includes('最近操作'), false);
const packT1 = buildPack(busyNoHit, 'T1', 6000);
eq('pack: T1 includes recent', packT1.includes('本会话最近操作的文件'), true);
eq('pack: T1 includes git', packT1.includes('Git 未提交改动'), true);
eq('pack: T1 includes project', packT1.includes('项目类型'), true);
eq('pack: budget truncates', buildPack(withRef, 'T1', 40).length <= 60, true);
eq('pack: T1 ref file first', buildPack(withRef, 'T1', 6000).startsWith('[引用文件'), true);

// ── signalSummary ─────────────────────────────────────────────
eq('meta: shows ref misses', signalSummary({ ...withRef, refMisses: ['lib/client.js'] }, 'T1').includes('引用未命中 1（lib/client.js）'), true);
eq('meta: no miss section when clean', signalSummary(withRef, 'T1').includes('引用未命中'), false);
eq('meta: T3 text', signalSummary(emptyWs, 'T3'), '绿地规格模式（无工作区信号）');
eq('meta: T0 text', signalSummary(undefined, 'T0'), '纯改写（上下文关闭）');

// ── gatherRefFiles (real filesystem) ──────────────────────────
const root = await mkdtemp(join(tmpdir(), 'dpenh-'));
try {
  await mkdir(join(root, 'dsh-prompt-enhancer', 'lib'), { recursive: true });
  await writeFile(join(root, 'dsh-prompt-enhancer', 'lib', 'client.js'), 'export const x = 1;', 'utf8');
  await writeFile(join(root, 'top.ts'), 'const y = 2;', 'utf8');
  const nested = join(root, 'dsh-prompt-enhancer', 'lib', 'client.js');

  const exact = await gatherRefFiles(root, ['top.ts'], []);
  eq('ref: exact relative resolves', exact.files.length, 1);
  eq('ref: no miss on exact', exact.misses, []);

  const missing = await gatherRefFiles(root, ['lib/client.js'], []);
  eq('ref: subdir-relative misses without index', missing.files.length, 0);
  eq('ref: miss reported', missing.misses, ['lib/client.js']);

  const fallback = await gatherRefFiles(root, ['lib/client.js'], [nested]);
  eq('ref: suffix fallback hits known path', fallback.files.length, 1);
  eq('ref: fallback reads content', fallback.files[0].content.includes('export const x'), true);
  eq('ref: fallback clears miss', fallback.misses, []);

  const backslash = await gatherRefFiles(root, ['dsh-prompt-enhancer\\lib\\client.js'], [nested]);
  eq('ref: backslash ref resolves', backslash.files.length, 1);

  const unreadable = await gatherRefFiles(root, ['nope/missing.ts'], ['D:\\other\\nope\\missing.ts']);
  eq('ref: unresolved stays a miss', unreadable.misses, ['nope/missing.ts']);
} finally {
  await rm(root, { recursive: true, force: true });
}

// ── nextAttempt (recoverable-failure policy) ──────────────────
eq('retry: truncation doubles cap', nextAttempt({ code: 'ENHANCE_TRUNCATED' }, { maxTokens: 2000, effortDropped: false }), { maxTokens: 4000, effortDropped: false });
eq('retry: truncation respects ceiling', nextAttempt({ code: 'ENHANCE_TRUNCATED' }, { maxTokens: 6000, effortDropped: false }), { maxTokens: 8000, effortDropped: false });
eq('retry: at ceiling settles', nextAttempt({ code: 'ENHANCE_TRUNCATED' }, { maxTokens: 8000, effortDropped: false }), undefined);
eq('retry: unsupported effort drops field', nextAttempt({ code: 'ENHANCE_EFFORT_UNSUPPORTED' }, { maxTokens: 2000, effortDropped: false }), { maxTokens: 2000, effortDropped: true });
eq('retry: effort dropped only once', nextAttempt({ code: 'ENHANCE_EFFORT_UNSUPPORTED' }, { maxTokens: 2000, effortDropped: true }), undefined);
eq('retry: unrelated failure settles', nextAttempt({ code: 'OTHER' }, { maxTokens: 2000, effortDropped: false }), undefined);

// ── effort-field rejection via the finish channel (zai/glm report, not throw) ──
const effortMessage = 'provider "zai-coding-cn" model "glm-5.3" does not support reasoning effort "off"';
const viaFinish = finishError({ kind: 'error', failure: { message: effortMessage } });
eq('finish: effort rejection tagged', viaFinish.code, 'ENHANCE_EFFORT_UNSUPPORTED');
eq('finish: message preserved', viaFinish.message, effortMessage);
eq('finish: other failures keep their code', finishError({ kind: 'error', failure: { message: 'boom', code: 'X' } }).code, 'X');
eq('finish: plain abort has no code', finishError({ kind: 'aborted', failure: { message: 'cancelled' } }).code, undefined);

// ── flow: the provider rejects the effort field, the retry drops it ──
// Driven through the real apply(): register /enhance on a fake ctx, invoke the
// handler, and script the model so the first call is rejected through the
// finish channel exactly as zai-coding-cn/glm-5.3 does.
const okReply = () => [{ type: 'text-delta', text: '## 目标\n做一件事' }, { type: 'finish', reason: { kind: 'stop' } }];
const effortRejection = () => [{ type: 'finish', reason: { kind: 'error', failure: { message: effortMessage } } }];
const flowAgent = { session: { id: 's1', requestHeader: () => ({ config: { provider: 'zai-coding-cn', model: 'glm-5.3' } }) } };
const effortCfg = Config({ reasoningEffort: 'off' });
const cache8 = () => {
  const map = new Map();
  return {
    get: (key) => { if (!map.has(key)) return undefined; const value = map.get(key); map.delete(key); map.set(key, value); return value; },
    set: (key, value) => { map.set(key, value); if (map.size > 8) map.delete(map.keys().next().value); },
  };
};
const effortHarness = (script) => {
  const calls = [];
  let handler;
  const ctx = {
    get: () => undefined,
    commands: { register: (definition) => { handler = definition.handler; } },
    llm: {
      *stream(options) {
        calls.push(options);
        for (const chunk of script.shift()()) yield chunk;
      },
    },
    sessionQuery: {
      filterEvents: async () => [],
      readSurface: async () => ({ session: { cwd: undefined } }),
    },
  };
  return {
    calls,
    ctx,
    run: async () => handler({ agent: flowAgent, rawInput: '分析下当前项目' }),
  };
};
const plugin = await import('../lib/index.js');
const firstRun = effortHarness([effortRejection, okReply]);
plugin.apply(firstRun.ctx, effortCfg);
const flowResult = await firstRun.run();
eq('effort: first call requested effort off', firstRun.calls[0].reasoningEffort, 'off');
eq('effort: retried once', firstRun.calls.length, 2);
eq('effort: retry omits the field', firstRun.calls[1].reasoningEffort, undefined);
eq('effort: settles successfully', flowResult.kind === 'success' && flowResult.text.includes('## 目标'), true);
eq('effort: meta notes the omission', flowResult.text.includes('已自动省略 reasoningEffort'), true);
const secondRun = effortHarness([okReply]);
plugin.apply(secondRun.ctx, effortCfg);
const againResult = await secondRun.run();
eq('effort: remembered for the route', secondRun.calls[0].reasoningEffort, undefined);
eq('effort: no retry needed on the next run', secondRun.calls.length, 1);
eq('effort: second run succeeds', againResult.kind, 'success');


// ── digest ────────────────────────────────────────────────────
eq('digest: stable', digest('abc') === digest('abc'), true);
eq('digest: differs', digest('abc') !== digest('abd'), true);

// ── workspace inspection (context first, asking last) ─────────
eq('terms: ascii identifier outranks prose', extractEntityTerms('fix the SparkIcon color')[0], 'SparkIcon');
eq('terms: short prose words dropped', extractEntityTerms('fix the bug'), []);
eq('terms: path-ish words dropped', extractEntityTerms('lib src index the'), []);
eq('terms: chinese phrase splits on function words', extractEntityTerms('优化提示词增强插件的火花按钮颜色'), ['提示词增强插件', '火花按钮颜色']);
eq('terms: instruction sentence yields nothing', extractEntityTerms('分析下当前项目'), []);
eq('terms: short chinese dropped', extractEntityTerms('改一下面板'), []);
eq('terms: capped at three', extractEntityTerms('Alpha Beta Gamma Delta').length, 3);

const pkgFacts = manifestFacts('package.json', JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'vitest run', build: 'tsc' }, dependencies: { react: '^19' }, devDependencies: { vitest: '^3' } }));
eq('manifest: name', pkgFacts.includes('- name: demo'), true);
eq('manifest: scripts listed', pkgFacts.includes('- scripts: test, build'), true);
eq('manifest: dependency count', pkgFacts.includes('- dependencies(1): react'), true);
eq('manifest: broken json tolerated', manifestFacts('package.json', '{oops'), '');
eq('manifest: pom artifact', manifestFacts('pom.xml', '<project><artifactId>demo-svc</artifactId><dependencies><dependency><artifactId>guava</artifactId></dependency></dependencies></project>').includes('- artifactId: demo-svc'), true);
eq('manifest: generic keeps head lines', manifestFacts('Makefile', '# comment\nbuild:\n\tgo build').includes('- build:'), true);

const skeleton = [
  { rel: 'src', dir: true, level: 1 },
  { rel: 'src/lib', dir: true, level: 2 },
  { rel: 'package.json', dir: false, level: 1 },
];
eq('skeleton: relative paths, dirs marked', renderSkeleton(skeleton).split('\n')[0], 'src/');
eq('skeleton: nested file names inline', renderSkeleton(skeleton, new Map([['src/lib', { names: ['a.ts', 'b.ts'], count: 5 }]])).includes('src/lib/  → a.ts, b.ts +3'), true);

eq('tests: vitest marker', summarizeTests(['vitest.config.ts'], ['src/a.test.ts'], '- scripts: test, build'), '框架线索 vitest.config.ts · 配置 vitest.config.ts · 测试文件 1 个 · 脚本 test');
eq('tests: python layout', summarizeTests([], ['tests/test_api.py'], ''), '框架线索 pytest / go test · 目录 tests/ · 测试文件 1 个');
eq('tests: nothing to say', summarizeTests([], ['src/app.ts'], ''), '');
eq('tests: conftest counts as a pytest marker', summarizeTests(['conftest.py'], ['tests/test_x.py'], '').includes('conftest.py'), true);

eq('manifest: csproj head lines kept', manifestFacts('Foo.csproj', '<Project Sdk="Microsoft.NET.Sdk">\n  <TargetFramework>net8.0</TargetFramework>\n</Project>').includes('TargetFramework'), true);
eq('manifest: pubspec falls to generic lines', manifestFacts('pubspec.yaml', 'name: demo_app\ndependencies:\n  flutter:').includes('name: demo_app'), true);

const ranked = rankEntityHits([
  { file: 'src/deep/nested/a.ts', line: 1, text: 'x' },
  { file: 'README.md', line: 1, text: 'x' },
  { file: 'src/lib/b.test.ts', line: 1, text: 'x' },
]);
eq('rank: shallow source first', ranked.map((hit) => hit.file), ['README.md', 'src/lib/b.test.ts', 'src/deep/nested/a.ts']);

eq('candidates: csproj pattern matched', manifestCandidates(['Foo.csproj', 'x.ts'], []).includes('Foo.csproj'), true);
eq('candidates: plain files excluded', manifestCandidates(['a.ts', 'b.md'], []), []);

// ── walkWorkspace + gatherEntityHits against a real workspace ──
const tree = await mkdtemp(join(tmpdir(), 'dpenh-ws-'));
try {
  await mkdir(join(tree, 'src', 'lib'), { recursive: true });
  await mkdir(join(tree, 'test'), { recursive: true });
  await mkdir(join(tree, 'node_modules', 'junk'), { recursive: true });
  await mkdir(join(tree, '.dart_tool'), { recursive: true });
  await writeFile(join(tree, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }), 'utf8');
  await writeFile(join(tree, 'Foo.csproj'), '<Project Sdk="Microsoft.NET.Sdk">\n  <TargetFramework>net8.0</TargetFramework>\n</Project>\n', 'utf8');
  await writeFile(join(tree, '.dart_tool', 'generated.js'), 'junk', 'utf8');
  await writeFile(join(tree, 'src', 'lib', 'spark.ts'), 'export const SparkGlow = "#0E6FEA";\nconst 火花 = 1;\n', 'utf8');
  await writeFile(join(tree, 'src', 'lib', 'panel.ts'), '// 火花按钮配色：随草稿状态变化\nexport const panel = 1;\n', 'utf8');
  await writeFile(join(tree, 'test', 'spark.test.ts'), 'import { SparkGlow } from "../src/lib/spark";\n', 'utf8');
  await writeFile(join(tree, 'node_modules', 'junk', 'index.js'), 'SparkGlow SparkGlow SparkGlow', 'utf8');

  const walked = await walkWorkspace(tree, 2, 60, 4);
  eq('walk: skips node_modules', walked.files.some((file) => file.includes('node_modules')), false);
  eq('walk: skips .dart_tool', walked.files.some((file) => file.includes('.dart_tool')), false);
  eq('walk: reaches depth-3 files', walked.files.includes('src/lib/spark.ts'), true);
  eq('walk: csproj indexed as a top-level file', walked.files.includes('Foo.csproj'), true);
  eq('walk: dir file names recorded', walked.dirFiles.get('src/lib').names, ['panel.ts', 'spark.ts']);
  eq('walk: skeleton carries dirs', walked.skeleton.filter((entry) => entry.dir).map((entry) => entry.rel), ['src', 'test', 'src/lib']);

  const located = await gatherEntityHits(tree, ['SparkGlow'], walked.files, 6);
  eq('locate: ascii identifier hits source and test', located.hits.map((hit) => hit.file).sort(), ['src/lib/spark.ts', 'test/spark.test.ts']);
  eq('locate: snippet carries the matching line', located.hits.some((hit) => hit.text.includes('#0E6FEA')), true);

  const phrase = await gatherEntityHits(tree, ['火花按钮颜色'], walked.files, 6);
  eq('locate: phrase falls back to bigrams', phrase.hits.some((hit) => hit.file === 'src/lib/panel.ts'), true);
  eq('locate: bigram hit labelled partial', phrase.hits.find((hit) => hit.file === 'src/lib/panel.ts').partialTerms, ['火花按钮颜色']);

  const missed = await gatherEntityHits(tree, ['NothingMatchesThis'], walked.files, 6);
  eq('locate: no hits is not an error', missed.hits, []);
  const byName = await gatherEntityHits(tree, ['panel.ts'], walked.files, 6);
  eq('locate: name-shaped term matches the path', byName.hits.map((hit) => hit.file), ['src/lib/panel.ts']);
  eq('locate: name match labelled', byName.hits[0].text, '（路径/文件名匹配）');
  const both = await gatherEntityHits(tree, ['panel'], walked.files, 6);
  eq('locate: content hit wins over the name hit', both.hits[0].text.includes('export const panel'), true);

  // End-to-end: the same tree through gatherSignals + buildPack.
  await writeFile(join(tree, 'README.md'), '# demo\n\n![badge](x.png)\nA demo project.\n', 'utf8');
  const gathered = await gatherSignals(
    { sessionQuery: { readSurface: async () => ({ session: { cwd: tree } }), filterEvents: async () => [] } },
    Config({ provider: 'p', model: 'm' }),
    { session: { id: 'probe' } },
    '优化 SparkGlow 的颜色',
  );
  const integrationTier = routeTier(gathered, extractPathMentions('优化 SparkGlow 的颜色'));
  const integrationPack = buildPack(gathered, integrationTier, 10_000);
  eq('gather: tier from signals', integrationTier, 'T2');
  eq('gather: manifest facts read', gathered.manifests.includes('- name: demo'), true);
  eq('gather: csproj adds a .NET label', gathered.project.labels.includes('C# / .NET'), true);
  eq('gather: csproj manifest surfaced', gathered.manifests.includes('Foo.csproj'), true);
  eq('gather: package scripts surfaced', gathered.manifests.includes('- scripts: test'), true);
  eq('gather: readme excerpt drops badges', gathered.readme.text.includes('A demo project.') && !gathered.readme.text.includes('badge'), true);
  eq('gather: test clues found', gathered.tests.includes('测试文件 1 个'), true);
  eq('gather: entity hit located', gathered.entities.hits.some((hit) => hit.file === 'src/lib/spark.ts'), true);
  eq('gather: pack carries skeleton and hits', integrationPack.includes('src/lib/  → panel.ts, spark.ts') && integrationPack.includes('src/lib/spark.ts'), true);
  eq('gather: empty workspace degrades to T3', routeTier(emptySignalsOf(undefined), []), 'T3');
} finally {
  await rm(tree, { recursive: true, force: true });
}

// ── gatherSignals + pack composition ─────────────────────────
const fullSignals = emptySignalsOf('D:/w');
fullSignals.workspace = { skeleton: [{ rel: 'src', dir: true, level: 1 }, { rel: 'package.json', dir: false, level: 1 }], dirFiles: new Map(), files: ['src/a.ts'], dirs: ['src'], truncated: false };
fullSignals.manifests = 'package.json\n- name: demo';
fullSignals.project = { labels: ['Node.js / npm'], entryCount: 2, names: ['src', 'package.json'] };
fullSignals.readme = { file: 'README.md', text: '# demo' };
fullSignals.tests = '框架线索 vitest';
fullSignals.gitLog = { branch: 'main', commits: ['abc123 init'] };
fullSignals.entities = { hits: [{ file: 'src/a.ts', line: 3, text: 'const a = 1;', terms: ['demo'] }], searched: ['demo'] };
const t2Pack = buildPack(fullSignals, 'T2', 10_000);
eq('pack: T2 carries the skeleton', t2Pack.includes('[工作区骨架'), true);
eq('pack: T2 carries manifest facts', t2Pack.includes('- name: demo'), true);
eq('pack: T2 carries the README excerpt', t2Pack.includes('[README 摘要'), true);
eq('pack: T2 carries the located files', t2Pack.includes('src/a.ts:3（命中 demo）'), true);
eq('pack: T2 carries the git log', t2Pack.includes('Git 最近提交（分支 main）'), true);
eq('pack: T2 withholds session-local signals', t2Pack.includes('本会话最近操作的文件'), false);
eq('pack: entities are labelled partial when bigram-only', buildPack({ ...fullSignals, entities: { hits: [{ file: 'src/b.ts', line: 1, text: 'x', partialTerms: ['火花按钮颜色'] }], searched: ['火花按钮颜色'] } }, 'T2', 10_000).includes('（部分命中 火花按钮颜色）'), true);
eq('pack: meta names the new sections', signalSummary(fullSignals, 'T2').includes('骨架 2 项') && signalSummary(fullSignals, 'T2').includes('README'), true);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
