/** Pure-function unit tests for dsh-prompt-enhancer internals. */
import { __internals } from '../lib/index.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { extractAtRefs, extractPathMentions, pathsFromToolDoc, routeTier, buildPack, digest, gatherRefFiles, signalSummary, nextAttempt } = __internals;
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

// ── digest ────────────────────────────────────────────────────
eq('digest: stable', digest('abc') === digest('abc'), true);
eq('digest: differs', digest('abc') !== digest('abd'), true);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
