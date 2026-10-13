#!/usr/bin/env node
// DEC-430①：把 origin/main 合进当前分支，并处理“生成物”与迁移编号，开发线程和合并队列共用。
// 用法：pnpm merge:main [--check] [--continue] [--no-regen] [--no-fetch] [--take-ours-for-counts]
//   （默认）fetch → merge origin/main → 只在生成物白名单内的冲突取 main 版本 → 本分支迁移改号接在 main 之后
//           → 授权版本定号（DEC-439④：合并结果的授权项编码与 main 不同则 main + 1 并重算指纹，否则取 main；
//             编码增删声明 standard-grant-changes.json 本分支改过就整份取本分支，F-097）
//           → 重算 F-039 证据登记与冻结基准 / 端点计数 → 提交“merge: 合入 main 并重算生成物”
//   --check     只预演：列出会冲突的文件（区分生成物 / 授权版本 / 业务文件）、迁移改号与授权版本定号计划，不改工作区；
//               定号按 git merge-tree 算出的合并结果预告（与实际同口径），算不出时给条件式提示；有业务冲突退出码 1
//   --continue  业务冲突手工解决并 git add 之后，从改号那一步继续
//   --no-regen  不跑重算命令（只合并、改号、提交）
//   --take-ours-for-counts  业务冲突里 main 一侧只改了数字字面量（如端点计数）的文件，冲突处取本分支一侧并 git add；
//               默认不自动处理，只提示（DEC-430① 补充）
// 白名单之外的冲突一律停下并列出，须人工处理。规则说明见 docs/08_设计/DEC-430_生成物合并后重算.md。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkSnapshotIdentity,
  classifyConflict,
  describeGrantPlan,
  drizzleJson,
  formatStale,
  GENERATED_PATHS,
  GRANT_CHANGES_PATH,
  GRANT_HISTORY_PATH,
  GRANTS_PATH,
  isGeneratedPath,
  JOURNAL_PATH,
  parseGrantHistory,
  pickGrantChanges,
  planGrantVersion,
  planRenumber,
  readGrantConstants,
  resolveGrantConflict,
  rebaseSnapshots,
  snapshotPath,
  sqlDigest,
  sqlPath,
  takeOursForCounts,
  writeGrantConstants,
  writeGrantHistory,
} from './merge-main-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAIN = 'origin/main';
const COMMIT_MESSAGE = 'merge: 合入 main 并重算生成物';
const args = new Set(process.argv.slice(2));

const git = (...argv) => execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
const gitOk = (...argv) => spawnSync('git', argv, { cwd: ROOT, stdio: 'ignore' }).status === 0;
const show = (rev, file) => (gitOk('cat-file', '-e', `${rev}:${file}`) ? git('show', `${rev}:${file}`) : undefined);
const json = (rev, file) => {
  const text = show(rev, file);
  return text === undefined ? undefined : JSON.parse(text);
};
const readRepo = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const writeRepo = (file, text) => {
  mkdirSync(path.dirname(path.join(ROOT, file)), { recursive: true });
  writeFileSync(path.join(ROOT, file), text);
};
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const TEST = 'tests/acceptance';
/** 重算命令：先冻结基准（recorded 读它），再其余基准与端点计数，最后证据登记。 */
const REGEN_STEPS = [
  { env: { ROUTE_POLICY_UPDATE_BASELINE: '1' }, files: [`${TEST}/AC-PRM-FW-02.test.ts`] },
  {
    env: { ROUTE_POLICY_UPDATE_BASELINE: '1' },
    files: [
      `${TEST}/AC-PRM-FW-01.test.ts`,
      `${TEST}/AC-PRM-FW-01-recorded.test.ts`,
      `${TEST}/AC-PRM-FW-08.discovery.test.ts`,
    ],
  },
  { env: { ROUTE_POLICY_UPDATE_DIGESTS: '1' }, files: [`${TEST}/AC-PRM-FW-02-required.test.ts`] },
];

const mergeInProgress = () => gitOk('rev-parse', '-q', '--verify', 'MERGE_HEAD');
const unmerged = () => git('diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean);

function splitConflicts(files) {
  return { generated: files.filter(isGeneratedPath), other: files.filter((f) => !isGeneratedPath(f)) };
}

function printConflicts({ generated, other }) {
  if (generated.length) console.log(`生成物冲突（取 main 版本后重算）：\n  ${generated.join('\n  ')}`);
  if (other.length) console.log(`业务文件冲突（须人工处理）：\n  ${other.join('\n  ')}`);
}

/**
 * 冲突文件的 diff3 文本：revs = [本分支, 分叉点, main]（合并进行中用索引的 :2 / :1 / :3）。
 * 任一侧缺文件（新增 / 删除冲突）返回 undefined。
 */
function diff3Text(file, revs) {
  const [ours, base, theirs] = revs.map((rev) => show(rev, file));
  if (ours === undefined || base === undefined || theirs === undefined) return undefined;
  const dir = mkdtempSync(path.join(tmpdir(), 'merge-main-'));
  try {
    const paths = Object.entries({ ours, base, theirs }).map(([name, text]) => {
      writeFileSync(path.join(dir, name), text);
      return path.join(dir, name);
    });
    const run = spawnSync(
      'git',
      ['merge-file', '-p', '--diff3', '-L', 'HEAD', '-L', 'merge-base', '-L', MAIN, ...paths],
      { encoding: 'utf8', maxBuffer: 1 << 28 },
    );
    return run.status === null || run.status < 0 ? undefined : run.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 业务冲突里“main 一侧只改了数字字面量”的文件（不自动处理，只用来提示或按 --take-ours-for-counts 处理）。 */
function countOnlyConflicts(files, revs) {
  return files.flatMap((file) => {
    const text = diff3Text(file, revs);
    if (text === undefined) return [];
    const { hunks, countOnly } = classifyConflict(text);
    return countOnly ? [{ file, hunks, text }] : [];
  });
}

function printCountHint(items) {
  if (!items.length) return;
  console.log(
    [
      '其中以下文件 main 一侧相对分叉点只改了数字字面量（如端点计数 592→593）：',
      ...items.map(({ file, hunks }) => `  ${file}（${hunks} 处冲突）`),
      '  建议：若本分支已改为读生成物（如 baseline/endpoint-counts.json）或计数会随重算更新，冲突处保留本分支一侧，',
      '  git add 后运行 pnpm merge:main --continue 重算生成物；也可运行 pnpm merge:main --continue --take-ours-for-counts，',
      '  只把这些冲突处取本分支一侧（文件里不冲突的 main 改动保留）。',
    ].join('\n'),
  );
}

/** --take-ours-for-counts：整份文件的冲突都“只改计数”时取本分支一侧并 git add，返回已处理的文件。 */
function resolveCountOnly(items) {
  const done = items.filter(({ text }) => takeOursForCounts(text).remaining === 0);
  for (const { file, text } of done) {
    writeRepo(file, takeOursForCounts(text).text);
    git('add', '--', file);
  }
  if (done.length)
    console.log(`只改计数的冲突取本分支一侧（--take-ours-for-counts）：\n  ${done.map((d) => d.file).join('\n  ')}`);
  return new Set(done.map((d) => d.file));
}

/**
 * 授权版本冲突（DEC-439④）：standard-grants.ts 只在两行常量、F061 测试只在 HISTORY 内冲突的文件，可自动处理；
 * 编码增删声明（F-097）整份取一边（pickGrantChanges），冲突总能自动处理。
 */
function grantConflicts(files, revs) {
  return files.flatMap((file) => {
    if (file === GRANT_CHANGES_PATH) {
      const [branch, fork, main] = revs.map((rev) => show(rev, file));
      const text = pickGrantChanges({ branch, fork, main });
      return text === undefined ? [] : [{ file, text }];
    }
    const text = [GRANTS_PATH, GRANT_HISTORY_PATH].includes(file) ? diff3Text(file, revs) : undefined;
    const resolved = text === undefined ? null : resolveGrantConflict(file, text);
    return resolved && resolved.remaining === 0 ? [{ file, text: resolved.text }] : [];
  });
}

/**
 * 授权项编码指纹：用 vite 的 runnerImport 直接加载 root 下的 TS 源码（不必先构建，不新增依赖）。
 * root 默认是工作区；--check 传入从合并结果树里导出的临时目录（packages/domain/src 不依赖 npm 包）。
 */
async function grantDigest(root = ROOT) {
  const { runnerImport } = await import('vite');
  const { module } = await runnerImport(path.join(root, GRANTS_PATH), {
    root,
    configFile: false,
    logLevel: 'silent',
  });
  return module.grantCodesDigest(module.STANDARD_GRANT_CODES);
}

const grantLabel = () => `${git('rev-parse', '--abbrev-ref', 'HEAD').trim()}（merge:main 定号，DEC-439④）`;

/** 授权版本定号（DEC-439④）：以合并结果的指纹与 main 比较，写回常量与 HISTORY 并 git add。 */
async function assignGrantVersion() {
  syncGrantChanges();
  const mainGrants = show(MAIN, GRANTS_PATH);
  const mainTest = show(MAIN, GRANT_HISTORY_PATH);
  if (mainGrants === undefined || mainTest === undefined) return console.log('授权版本：main 上没有授权版本文件，跳过');
  const branchGrants = show('HEAD', GRANTS_PATH);
  const branchTest = show('HEAD', GRANT_HISTORY_PATH);
  const plan = planGrantVersion({
    main: readGrantConstants(mainGrants),
    mainHistory: parseGrantHistory(mainTest),
    branch: branchGrants === undefined ? undefined : readGrantConstants(branchGrants),
    branchHistory: branchTest === undefined ? [] : parseGrantHistory(branchTest),
    mergedDigest: await grantDigest(),
    label: grantLabel(),
  });
  const grantsNow = readRepo(GRANTS_PATH);
  const testNow = readRepo(GRANT_HISTORY_PATH);
  const grantsNext = writeGrantConstants(grantsNow, plan);
  const testNext = writeGrantHistory(testNow, plan.history);
  if (grantsNext !== grantsNow) writeRepo(GRANTS_PATH, grantsNext);
  if (testNext !== testNow) writeRepo(GRANT_HISTORY_PATH, testNext);
  git('add', '--', GRANTS_PATH, GRANT_HISTORY_PATH);
  console.log(
    plan.bumped
      ? `授权版本：本分支改了授权项编码，定为 main + 1 = ${plan.version}，指纹 ${plan.digest}（合并结果重算）`
      : `授权版本：编码集合与 main 相同，取 main 的 version ${plan.version} / 指纹 ${plan.digest}`,
  );
}

/**
 * 编码增删声明（F-097）：本分支相对分叉点改过就整份取本分支，否则取 main。git 自动合并成功（两边改了不同行）时也要改写，
 * 否则会拼出两个 PR 的混合声明。合并进行中 HEAD 仍是合并前的提交。
 */
function syncGrantChanges() {
  const fork = git('merge-base', 'HEAD', MAIN).trim();
  const text = pickGrantChanges({
    branch: show('HEAD', GRANT_CHANGES_PATH),
    fork: show(fork, GRANT_CHANGES_PATH),
    main: show(MAIN, GRANT_CHANGES_PATH),
  });
  if (text === undefined) return;
  if (!existsSync(path.join(ROOT, GRANT_CHANGES_PATH)) || readRepo(GRANT_CHANGES_PATH) !== text)
    writeRepo(GRANT_CHANGES_PATH, text);
  git('add', '--', GRANT_CHANGES_PATH);
}

const CONFLICT_MARKER_RE = /^(?:<{7}|>{7}) /m;

/**
 * 合并结果的授权项编码指纹（P3-2，与实际定号同口径）：git merge-tree 写出合并结果树，导出 packages/domain/src 到临时目录加载。
 * standard-grants.ts 只在两行常量冲突时按自动定号的规则处理；packages/domain/src 里还有其他冲突则算不出，返回 undefined。
 */
async function mergedGrantDigest(base) {
  const run = spawnSync('git', ['merge-tree', '--write-tree', '--no-messages', 'HEAD', MAIN], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (run.status !== 0 && run.status !== 1) return undefined;
  const tree = run.stdout.split('\n')[0].trim();
  const dir = mkdtempSync(path.join(tmpdir(), 'merge-main-grants-'));
  try {
    const tar = spawnSync(
      'sh',
      ['-c', `git archive --format=tar "$1" packages/domain/src | tar -x -C "$2"`, 'sh', tree, dir],
      {
        cwd: ROOT,
        stdio: 'ignore',
      },
    );
    if (tar.status !== 0) return undefined;
    const files = git('ls-tree', '-r', '--name-only', tree, '--', 'packages/domain/src').split('\n').filter(Boolean);
    for (const file of files) {
      const text = readFileSync(path.join(dir, file), 'utf8');
      if (!CONFLICT_MARKER_RE.test(text)) continue;
      const diff3 = file === GRANTS_PATH ? diff3Text(file, ['HEAD', base, MAIN]) : undefined;
      const resolved = diff3 === undefined ? null : resolveGrantConflict(file, diff3);
      if (!resolved || resolved.remaining) return undefined;
      writeFileSync(path.join(dir, file), resolved.text);
    }
    return await grantDigest(dir);
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** --check：按合并结果的指纹预告定号（P3-2）；算不出时按本分支相对分叉点的指纹给条件式提示。 */
async function printGrantPlan(base, upToDate) {
  const mainGrants = show(MAIN, GRANTS_PATH);
  const forkGrants = show(base, GRANTS_PATH);
  if (mainGrants === undefined || forkGrants === undefined) return;
  const branchDigest = await grantDigest();
  const mergedDigest = upToDate ? branchDigest : await mergedGrantDigest(base);
  console.log(
    describeGrantPlan({
      main: readGrantConstants(mainGrants),
      mergedDigest,
      branchDigest,
      forkDigest: readGrantConstants(forkGrants).digest,
    }),
  );
}

/** 预演合并冲突：git merge-tree --write-tree 不碰工作区，冲突时退出码 1，第一行后是冲突文件。 */
function predictConflicts() {
  const run = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', MAIN], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (run.status !== 0 && run.status !== 1) fail(`git merge-tree 失败（需要 git ≥ 2.38）：${run.stderr}`);
  return run.stdout.split('\n').slice(1).filter(Boolean);
}

/** 本分支迁移改号计划：以合并前的 HEAD 为本分支、origin/main 为基准（合并进行中 HEAD 仍是合并前的提交）。 */
function migrationPlan() {
  const mainJournal = json(MAIN, JOURNAL_PATH);
  const branchJournal = json('HEAD', JOURNAL_PATH);
  if (!mainJournal || !branchJournal) fail(`读不到 ${JOURNAL_PATH}`);
  const sql = {
    main: (tag) => show(MAIN, sqlPath(tag)),
    branch: (tag) => show('HEAD', sqlPath(tag)),
  };
  try {
    const plan = planRenumber(mainJournal, branchJournal, sql);
    return { ...plan, identityProblems: identityProblems(plan, mainJournal, sql) };
  } catch (error) {
    return fail(`迁移改号计划失败：${error.message}`);
  }
}

/** 保留（改号）的迁移的快照 id 不能与 main 或彼此重复（见 checkSnapshotIdentity）；读 main 全部快照 id 只在有改号时做。 */
function identityProblems(plan, mainJournal, sql) {
  if (!plan.renames.length) return [];
  const idOf = (rev, idx) => json(rev, snapshotPath(idx))?.id;
  return checkSnapshotIdentity({
    main: mainJournal.entries.map((e) => ({ tag: e.tag, id: idOf(MAIN, e.idx) })),
    kept: plan.renames.map(({ from }) => ({ tag: from.tag, id: idOf('HEAD', from.idx) })),
    mainLastId: idOf(MAIN, mainJournal.entries.at(-1).idx),
    digestOf: (side, tag) => sqlDigest(sql[side](tag)),
  });
}

function printPlan(plan) {
  if (plan.identityProblems.length)
    console.log(
      `迁移：以下保留项的快照身份与 main 或彼此重复（可能是格式漂移使 SQL 摘要不同的旧名迁移），须人工处理：\n${plan.identityProblems
        .map((line) => `  ${line}`)
        .join('\n')}`,
    );
  if (plan.stale.length)
    console.log(
      `迁移：以下旧名迁移的 SQL 与 main 上已改号的迁移相同（上游已合并），清理、不改号（旧名 → main 名 sha256=SQL 原始内容摘要）：\n${formatStale(
        plan.stale,
      )
        .map((line) => `  ${line}`)
        .join('\n')}`,
    );
  if (!plan.renames.length) return console.log('迁移：本分支没有自己新增的迁移。');
  const lines = plan.renames.map(({ from, to }) => `  ${from.tag} → ${to.tag}（when ${from.when} → ${to.when}）`);
  console.log(`迁移：本分支 ${plan.renames.length} 条${plan.changed ? '，改号如下' : '，编号已接在 main 之后'}：`);
  console.log(lines.join('\n'));
}

function rebasedSnapshots(plan) {
  const mainJournal = json(MAIN, JOURNAL_PATH);
  const mainLast = json(MAIN, snapshotPath(mainJournal.entries.at(-1).idx));
  // 每条新增迁移的增量基准 = 它在本分支 journal 里的前一条（可能是已合并的旧名迁移）
  const bases = plan.renames.map(({ baseIdx }) => baseIdx !== undefined && json('HEAD', snapshotPath(baseIdx)));
  const own = plan.renames.map(({ from }) => json('HEAD', snapshotPath(from.idx)));
  if (!mainLast || bases.some((s) => !s) || own.some((s) => !s)) fail('迁移快照缺失，无法自动改号，请人工处理');
  const { snapshots, conflicts } = rebaseSnapshots(bases[0], own, mainLast, bases);
  if (conflicts.length) fail(`迁移快照与 main 改了同一处，须人工处理：\n  ${conflicts.join('\n  ')}`);
  return snapshots;
}

/**
 * 写改号后的 SQL、快照与 journal；旧路径（改号前的、已合并的旧名迁移）若是 main 的文件就恢复成 main 版本，否则删掉。
 * 没有新增迁移（只有已合并的旧名迁移）时不需要重算快照。
 */
function applyRenumber(plan) {
  const snapshots = plan.renames.length ? rebasedSnapshots(plan) : [];
  const written = new Set();
  plan.renames.forEach(({ from, to }, i) => {
    writeRepo(sqlPath(to.tag), show('HEAD', sqlPath(from.tag)) ?? fail(`缺少 ${sqlPath(from.tag)}`));
    writeRepo(snapshotPath(to.idx), drizzleJson(snapshots[i]));
    written.add(sqlPath(to.tag)).add(snapshotPath(to.idx));
  });
  for (const { from } of [...plan.renames, ...plan.stale]) {
    for (const old of [sqlPath(from.tag), snapshotPath(from.idx)]) {
      if (written.has(old)) continue;
      const onMain = show(MAIN, old);
      if (onMain !== undefined) writeRepo(old, onMain);
      else if (existsSync(path.join(ROOT, old))) rmSync(path.join(ROOT, old));
    }
  }
  writeRepo(JOURNAL_PATH, drizzleJson(plan.journal));
  git('add', '-A', 'packages/db/migrations');
  warnTagReferences(plan);
}

function warnTagReferences(plan) {
  const moved = [...plan.renames, ...plan.stale.map(({ from, mainEntry }) => ({ from, to: mainEntry }))];
  for (const { from, to } of moved) {
    if (from.tag === to.tag) continue;
    const hits = spawnSync('git', ['grep', '-l', '-F', from.tag, '--', '.', ':!packages/db/migrations'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).stdout.trim();
    if (hits)
      console.warn(`注意：以下文件仍引用旧迁移名 ${from.tag}，请改成 ${to.tag}：\n  ${hits.split('\n').join('\n  ')}`);
  }
}

function regenerate() {
  const pnpm = process.env.npm_execpath ? [process.execPath, process.env.npm_execpath] : ['pnpm'];
  for (const step of REGEN_STEPS) {
    console.log(
      `重算：${Object.entries(step.env)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')} pnpm test ${step.files.join(' ')}`,
    );
    const run = spawnSync(pnpm[0], [...pnpm.slice(1), 'test', ...step.files], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...step.env, GENERATED_STRICT: '0' },
    });
    if (run.status !== 0) fail('重算命令有测试失败（不只是生成物）：修好后运行 pnpm merge:main --continue');
  }
  git(
    'add',
    '-A',
    'tests/acceptance/support/route-policy/required/digests',
    'tests/acceptance/support/route-policy/baseline',
  );
}

function resolveGenerated(files) {
  if (files.length) console.log(`生成物冲突取 main 版本（随后重算）：\n  ${files.join('\n  ')}`);
  for (const file of files) {
    if (show(MAIN, file) === undefined) git('rm', '-q', '--', file);
    else {
      git('checkout', MAIN, '--', file);
      git('add', '--', file);
    }
  }
}

async function check() {
  const upToDate = gitOk('merge-base', '--is-ancestor', MAIN, 'HEAD');
  console.log(upToDate ? `当前分支已包含 ${MAIN}。` : `需要合并 ${MAIN}。`);
  const base = git('merge-base', 'HEAD', MAIN).trim();
  const conflicts = splitConflicts(upToDate ? [] : predictConflicts());
  const grants = grantConflicts(conflicts.other, ['HEAD', base, MAIN]).map((g) => g.file);
  conflicts.other = conflicts.other.filter((f) => !grants.includes(f));
  printConflicts(conflicts);
  if (grants.length) console.log(`授权版本冲突（合并时自动定号）：\n  ${grants.join('\n  ')}`);
  if (conflicts.other.length) printCountHint(countOnlyConflicts(conflicts.other, ['HEAD', base, MAIN]));
  const plan = migrationPlan();
  printPlan(plan);
  await printGrantPlan(base, upToDate);
  console.log(`生成物白名单：\n  ${GENERATED_PATHS.join('\n  ')}`);
  process.exit(conflicts.other.length || plan.identityProblems.length ? 1 : 0);
}

function startMerge() {
  if (git('status', '--porcelain', '--untracked-files=no').trim()) fail('工作区有未提交的改动，先提交或暂存');
  if (gitOk('merge-base', '--is-ancestor', MAIN, 'HEAD')) return console.log(`已包含 ${MAIN}，只检查迁移编号与重算`);
  spawnSync('git', ['merge', '--no-ff', '--no-commit', MAIN], { cwd: ROOT, stdio: 'inherit' });
  if (!mergeInProgress() && !gitOk('merge-base', '--is-ancestor', MAIN, 'HEAD')) fail('git merge 失败');
}

async function main() {
  if (git('rev-parse', '--abbrev-ref', 'HEAD').trim() === 'main') fail('不要在 main 上运行，请在自己的分支上运行');
  if (!args.has('--no-fetch')) git('fetch', '-q', 'origin', 'main');
  if (args.has('--check')) return check();
  if (!args.has('--continue')) startMerge();
  const conflicts = splitConflicts(unmerged());
  resolveGenerated(conflicts.generated);
  const grants = conflicts.other.length ? grantConflicts(conflicts.other, [':2', ':1', ':3']) : [];
  for (const { file, text } of grants) {
    writeRepo(file, text);
    git('add', '--', file);
  }
  if (grants.length) console.log(`授权版本冲突取 main 一侧（随后定号）：\n  ${grants.map((g) => g.file).join('\n  ')}`);
  let other = conflicts.other.filter((f) => !grants.some((g) => g.file === f));
  const countOnly = other.length ? countOnlyConflicts(other, [':2', ':1', ':3']) : [];
  if (args.has('--take-ours-for-counts') && countOnly.length) {
    const resolved = resolveCountOnly(countOnly);
    other = other.filter((f) => !resolved.has(f));
  }
  if (other.length) {
    printConflicts({ generated: [], other });
    printCountHint(countOnly.filter(({ file }) => other.includes(file)));
    fail('请手工解决上面的业务冲突并 git add，然后运行 pnpm merge:main --continue');
  }
  const plan = migrationPlan();
  printPlan(plan);
  if (plan.identityProblems.length)
    fail('保留迁移的快照身份重复（见上），未改号；人工处理后运行 pnpm merge:main --continue');
  if (plan.changed) applyRenumber(plan);
  await assignGrantVersion().catch((error) =>
    fail(`授权版本定号失败：${error.message}\n请人工处理后运行 pnpm merge:main --continue`),
  );
  if (!args.has('--no-regen')) regenerate();
  const staged = !gitOk('diff', '--cached', '--quiet');
  if (!mergeInProgress() && !staged) return console.log('已是最新，无需提交');
  git('commit', '-q', '-m', COMMIT_MESSAGE);
  console.log(
    `已提交：${COMMIT_MESSAGE}（${git('rev-parse', '--short', 'HEAD').trim()}）；推送后 CI 按严格模式校验生成物`,
  );
}

await main();
