#!/usr/bin/env node
// DEC-430①：把 origin/main 合进当前分支，并处理“生成物”与迁移编号，开发线程和合并队列共用。
// 用法：pnpm merge:main [--check] [--continue] [--no-regen] [--no-fetch] [--take-ours-for-counts]
//   （默认）fetch → merge origin/main → 只在生成物白名单内的冲突取 main 版本 → 本分支迁移改号接在 main 之后
//           → 授权版本定号（DEC-439④：合并结果的授权项编码与 main 不同则 main + 1 并重算指纹，否则取 main；
//             编码增删声明 standard-grant-changes.json 本分支改过就整份取本分支，F-097）
//           → 重算 F-039 证据登记与冻结基准 / 端点计数 → 提交“merge: 合入 main 并重算生成物”
//   --check     只预演：列出会冲突的文件（区分生成物 / 授权版本 / 业务文件）、迁移改号与授权版本定号计划，不改工作区；
//               定号按 git merge-tree 算出的合并结果预告（与实际同口径），算不出时给条件式提示；有业务冲突退出码 1
//   登记类冲突（F-133，DEC-491④）：两边都往同一清单加条目的文件自动取并集，不再人工逐个解——
//           F-039 登记 required/declared/<模块>.ts（结构化合并）、required/declared/index.ts、required/index.ts，
//           路由登记 apps/api/src/app.ts、packages/db/src/schema/index.ts；只处理“两边都是纯新增”，处理后核对两边新增项都在结果里
//   核对对象 = 提交对象（F-133 第 5 轮，DEC-501）：冲突处理后索引写出树 t0；重算与授权定号只在从 t0 逐字节写出的临时目录里跑，
//           产物按内容收集成 t1；登记核对 t0 / t1，用 commit-tree + update-ref 提交 t1（不跑 hook），提交后断言 HEAD^{tree} = t1；
//           assume-unchanged / skip-worktree / sparse / filter / 子模块 / 外部符号链接直接拒绝（scripts/merge-main-isolated.mjs）
//   同一基准（F-133 第 6 轮）：开头固定一次本分支 ref 与提交、main 提交、分叉点（fixBase），此后冲突处理、改号、定号、核对、
//           父提交与 update-ref 的 CAS 旧值都只用它；HEAD 中途被移动（另一个终端提交、切分支、reset）就非 0 退出，不重试、不并入
//   --continue  业务冲突手工解决并 git add 之后，从改号那一步继续（不再 fetch，MERGE_HEAD 须仍是 origin/main）
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
import {
  isRegistryPath,
  loadTools,
  REGISTRY_PATHS,
  registryProblems,
  resolveRegistryFile,
} from './merge-main-registry-lib.mjs';
import { createIsolation } from './merge-main-isolated.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAIN = 'origin/main';
const COMMIT_MESSAGE = 'merge: 合入 main 并重算生成物';
const args = new Set(process.argv.slice(2));
const isolation = createIsolation(ROOT);

const git = (...argv) => execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
const gitOk = (...argv) => spawnSync('git', argv, { cwd: ROOT, stdio: 'ignore' }).status === 0;
const show = (rev, file) => (gitOk('cat-file', '-e', `${rev}:${file}`) ? git('show', `${rev}:${file}`) : undefined);
const json = (rev, file) => {
  const text = show(rev, file);
  return text === undefined ? undefined : JSON.parse(text);
};
const readIn = (dir, file) => readFileSync(path.join(dir, file), 'utf8');
const writeIn = (dir, file, text) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};
const writeRepo = (file, text) => writeIn(ROOT, file, text);
/** 冲突处理的三方版本：[本分支, 分叉点, main]，取自基准（不读索引的 :2 / :1 / :3，也不再解析 HEAD / origin/main）。 */
const revsOf = (base) => [base.head, base.fork, base.main];
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
const short = (sha) => sha.slice(0, 12);

/** 此刻 HEAD 指向的分支（分离头时为 HEAD）与提交。只在 fixBase 与 baseMoves 里读，读到的不当内容来源用。 */
function currentHead() {
  const symbolic = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return {
    ref: symbolic.status === 0 ? symbolic.stdout.trim() : 'HEAD',
    head: git('rev-parse', '--verify', 'HEAD^{commit}').trim(),
  };
}

/**
 * 基准（F-133 第 6 轮，第 5 轮审查 P2-1）：流程开头固定一次。此后冲突处理的三方版本、迁移改号、授权定号、登记核对读的
 * “本分支 / 分叉点 / main”，以及提交的父提交与 update-ref 的 CAS 旧值，全部是这里的提交 id，不再解析 HEAD / origin/main。
 *   ref：HEAD 指向的分支（分离头为 HEAD），提交时 update-ref 它；head / main：开始时本分支与 main 的提交；fork：二者的分叉点；
 *   merging：提交是否以 main 为第二个父提交（本次开始合并，或 --continue 接着进行中的合并）。
 * --continue 接着进行中的合并时 main = MERGE_HEAD，且须仍等于 origin/main（否则说不清核对与提交的是哪个 main）；
 * 没有进行中的合并、本分支又不包含 main 时拒绝（核对按“合入 main”算，提交却不含 main）。
 */
function fixBase(continuing) {
  const { ref, head } = currentHead();
  if (ref === 'refs/heads/main') fail('不要在 main 上运行，请在自己的分支上运行');
  const main = git('rev-parse', '--verify', `${MAIN}^{commit}`).trim();
  const merging = continuing && mergeInProgress();
  if (merging) {
    const mergeHead = git('rev-parse', '--verify', 'MERGE_HEAD^{commit}').trim();
    if (mergeHead !== main)
      fail(
        `合并开始后 ${MAIN} 变了（MERGE_HEAD ${short(mergeHead)} ≠ ${MAIN} ${short(main)}），` +
          '无法确定核对与提交的是哪个 main：git merge --abort 后重新运行 pnpm merge:main',
      );
  }
  const contains = gitOk('merge-base', '--is-ancestor', main, head);
  if (continuing && !merging && !contains)
    fail(`--continue：没有进行中的合并，本分支也还没包含 ${MAIN}；请去掉 --continue 重新运行 pnpm merge:main`);
  const fork = git('merge-base', head, main).trim();
  return { ref, head, main, fork, merging: merging || (!continuing && !contains) };
}

/** HEAD 相对基准的移动：指向的分支、提交、合并状态（MERGE_HEAD）任一与基准不同都列出。 */
function baseMoves(base) {
  const now = currentHead();
  const mergeHead = mergeInProgress() ? git('rev-parse', 'MERGE_HEAD').trim() : undefined;
  const expected = base.merging ? base.main : undefined;
  return [
    now.ref === base.ref ? '' : `HEAD 指向 ${now.ref}（开始时 ${base.ref}）`,
    now.head === base.head ? '' : `HEAD 在 ${short(now.head)}（开始时 ${short(base.head)}）`,
    mergeHead === expected
      ? ''
      : `MERGE_HEAD 为 ${mergeHead ? short(mergeHead) : '无'}（应为 ${expected ? short(expected) : '无'}）`,
  ].filter(Boolean);
}

const MOVED_HINT =
  '不提交、不重试，也不并入期间的新提交；请用 git status / git log 确认仓库状态后重新运行 pnpm merge:main';

/** 基准没被移动才继续（开始合并后、写出待提交树后、提交前各查一次；提交本身另有 update-ref 的 CAS 兜底）。 */
function requireBaseUnmoved(base, when) {
  const moves = baseMoves(base);
  if (moves.length)
    fail(
      `${when}：HEAD 在脚本运行期间被移动（另一个终端提交、切换分支或 reset？）：\n  ${moves.join('\n  ')}\n${MOVED_HINT}`,
    );
}

function splitConflicts(files) {
  return { generated: files.filter(isGeneratedPath), other: files.filter((f) => !isGeneratedPath(f)) };
}

function printConflicts({ generated, other }) {
  if (generated.length) console.log(`生成物冲突（取 main 版本后重算）：\n  ${generated.join('\n  ')}`);
  if (other.length) console.log(`业务文件冲突（须人工处理）：\n  ${other.join('\n  ')}`);
}

/**
 * 冲突文件的 diff3 文本：revs = [本分支, 分叉点, main]，一律是基准里的提交 id（revsOf），预演与正式运行同一份。
 * 任一侧缺文件（新增 / 删除冲突、改名）返回 undefined，留给人工。
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
 * 登记类冲突（F-133）：两边都往同一清单加条目的文件取并集（纯新增才处理，见 merge-main-registry-lib.mjs）。
 * 返回 { resolved: [{ file, text }], manual: [{ file, reason }] }；manual 里的文件原样留给人工，reason 说明为什么没自动处理。
 */
async function registryConflicts(files, revs) {
  const candidates = files.filter(isRegistryPath);
  if (!candidates.length) return { resolved: [], manual: [] };
  const tools = await loadTools();
  const resolved = [];
  const manual = [];
  for (const file of candidates) {
    const [ours, base, theirs] = revs.map((rev) => show(rev, file));
    const result = await resolveRegistryFile(tools, file, {
      versions: { ours, base, theirs },
      diff3: diff3Text(file, revs),
    });
    if (result.error === undefined) resolved.push({ file, text: result.text });
    else manual.push({ file, reason: result.error });
  }
  return { resolved, manual };
}

function printRegistryManual(manual) {
  if (manual.length)
    console.log(
      `登记类文件的冲突不是“两边纯新增”，没有自动处理：\n  ${manual.map((m) => `${m.file}（${m.reason}）`).join('\n  ')}`,
    );
}

/** 工作区与索引的差异：已跟踪文件改了没暂存（含删除）、未跟踪且未被忽略的文件。 */
function worktreeDrift() {
  const list = (...argv) =>
    git(...argv, '-z')
      .split('\0')
      .filter(Boolean);
  return [
    ...list('diff', '--name-only').map((file) => `修改未暂存：${file}`),
    ...list('ls-files', '--others', '--exclude-standard').map((file) => `未跟踪：${file}`),
  ];
}

/**
 * 冲突处理后工作区必须与索引一致，否则停下（F-133 第 4 轮）。第 5 轮起重算与提交都绑定到树、不读工作区，
 * 这条不再是正确性的依据，留着是为了不让人以为工作区里没暂存的改动会被提交。不替人 git add：
 * 暂存版与工作区版哪份是想提交的只有人知道（第 3 轮反例就是“暂存了丢项版、工作区是完整版”）。
 */
function requireWorktreeIsIndex(when) {
  const drift = worktreeDrift();
  if (drift.length)
    fail(
      `${when}：工作区与索引不一致（提交的是索引，工作区里没暂存的改动不会进提交；不提交）：\n  ${drift.join('\n  ')}\n` +
        '请 git add 要提交的版本，或 git restore 丢掉工作区改动、移走未跟踪文件，然后运行 pnpm merge:main --continue',
    );
}

/** 无法证明“读到的 = 提交的”的配置直接拒绝（DEC-501④，见 merge-main-isolated.mjs）。 */
function refuseUnprovable(when) {
  const problems = isolation.unprovableProblems();
  if (problems.length)
    fail(
      `${when}：以下仓库配置让脚本无法证明“核对 / 重算读到的 = 提交的”，不处理（DEC-501④）：\n  ${problems.join('\n  ')}\n` +
        '请按括号里的办法解除后重新运行（合并已开始的，解除后运行 pnpm merge:main --continue）',
    );
}

/**
 * 登记类文件合并结果的最终不变式（F-133 第 3 轮起，DEC-431①）：**无条件**——不看哪一边改过、不因“两边一致”“已包含 main”提前通过。
 * 读的是待提交树 tree（不是工作区）；文件枚举 = 本分支 ∪ main ∪ 分叉点 ∪ 待提交树，任一侧没有的文件按“没有条目”算，
 * 所以待提交树里独有的登记文件也要核对（里面的条目都是多出的）。应有身份（分叉点保留项 ∪ 本分支新增 ∪ main 新增）
 * 每个必须存在且恰好一份，应有集合非空而文件缺失判失败，登记区有无法识别的形状判失败。
 * 含 Git 无冲突自动合并的、脚本自动取并集的、人工解决过的文件。三侧取自基准（第 6 轮），不读 HEAD / origin/main。有问题就停下，不提交。
 */
async function verifyRegistries(base, tree, when) {
  const listed = (rev) => git('ls-tree', '-r', '--name-only', '-z', rev).split('\0').filter(isRegistryPath);
  const files = [...new Set([tree, base.head, base.main, base.fork].flatMap(listed))].sort();
  const tools = await loadTools();
  const problems = files.flatMap((file) => {
    const versions = { ours: show(base.head, file), base: show(base.fork, file), theirs: show(base.main, file) };
    return registryProblems(tools, file, show(tree, file), versions).map((problem) => `${file}：${problem}`);
  });
  if (problems.length)
    fail(
      `${when}：登记类文件合并后核对失败（不提交，请人工补齐并 git add 后运行 pnpm merge:main --continue）：\n  ${problems.join('\n  ')}`,
    );
  if (files.length)
    console.log(`${when}登记核对通过（待提交树，${files.length} 个登记类文件，按条目身份，应有项都在且各一份）`);
}

/**
 * 授权项编码指纹：用 vite 的 runnerImport 直接加载 root 下的 TS 源码（不必先构建，不新增依赖）。
 * root 一律是 materializeTree 从树写出的临时目录（正式运行是 t0，--check 是本分支 / 合并结果的 packages/domain/src），不读工作区。
 */
async function grantDigest(root) {
  const { runnerImport } = await import('vite');
  const { module } = await runnerImport(path.join(root, GRANTS_PATH), {
    root,
    configFile: false,
    logLevel: 'silent',
  });
  return module.grantCodesDigest(module.STANDARD_GRANT_CODES);
}

const grantLabel = (base) => `${base.ref.replace(/^refs\/heads\//, '')}（merge:main 定号，DEC-439④）`;

/** 授权版本定号（DEC-439④）：以合并结果的指纹与 main 比较，写回常量与 HISTORY。dir 是从待提交树写出的隔离目录。 */
async function assignGrantVersion(base, dir) {
  syncGrantChanges(base, dir);
  const mainGrants = show(base.main, GRANTS_PATH);
  const mainTest = show(base.main, GRANT_HISTORY_PATH);
  if (mainGrants === undefined || mainTest === undefined) return console.log('授权版本：main 上没有授权版本文件，跳过');
  const branchGrants = show(base.head, GRANTS_PATH);
  const branchTest = show(base.head, GRANT_HISTORY_PATH);
  const plan = planGrantVersion({
    main: readGrantConstants(mainGrants),
    mainHistory: parseGrantHistory(mainTest),
    branch: branchGrants === undefined ? undefined : readGrantConstants(branchGrants),
    branchHistory: branchTest === undefined ? [] : parseGrantHistory(branchTest),
    mergedDigest: await grantDigest(dir),
    label: grantLabel(base),
  });
  const grantsNow = readIn(dir, GRANTS_PATH);
  const testNow = readIn(dir, GRANT_HISTORY_PATH);
  const grantsNext = writeGrantConstants(grantsNow, plan);
  const testNext = writeGrantHistory(testNow, plan.history);
  if (grantsNext !== grantsNow) writeIn(dir, GRANTS_PATH, grantsNext);
  if (testNext !== testNow) writeIn(dir, GRANT_HISTORY_PATH, testNext);
  console.log(
    plan.bumped
      ? `授权版本：本分支改了授权项编码，定为 main + 1 = ${plan.version}，指纹 ${plan.digest}（合并结果重算）`
      : `授权版本：编码集合与 main 相同，取 main 的 version ${plan.version} / 指纹 ${plan.digest}`,
  );
}

/**
 * 编码增删声明（F-097）：本分支相对分叉点改过就整份取本分支，否则取 main。git 自动合并成功（两边改了不同行）时也要改写，
 * 否则会拼出两个 PR 的混合声明。三侧取自基准。
 */
function syncGrantChanges(base, dir) {
  const text = pickGrantChanges({
    branch: show(base.head, GRANT_CHANGES_PATH),
    fork: show(base.fork, GRANT_CHANGES_PATH),
    main: show(base.main, GRANT_CHANGES_PATH),
  });
  if (text !== undefined) writeIn(dir, GRANT_CHANGES_PATH, text);
}

const CONFLICT_MARKER_RE = /^(?:<{7}|>{7}) /m;

const DOMAIN_SRC = 'packages/domain/src';

/**
 * 树里 packages/domain/src 的授权项编码指纹（--check 用）：经 materializeTree 写出（与正式运行同一条符号链接检查），
 * resolve 可在加载前改写冲突文件；写不出、改写不了或加载失败返回 undefined。
 */
async function treeGrantDigest(tree, resolve = () => true) {
  let iso;
  try {
    iso = await isolation.materializeTree(tree, DOMAIN_SRC);
    for (const file of iso.entries.keys()) if (!resolve(file, iso.dir)) return undefined;
    return await grantDigest(iso.dir);
  } catch {
    return undefined;
  } finally {
    iso?.cleanup();
  }
}

/**
 * 合并结果的授权项编码指纹（P3-2，与实际定号同口径）：git merge-tree 写出基准两侧的合并结果树，取 packages/domain/src 加载。
 * standard-grants.ts 只在两行常量冲突时按自动定号的规则处理；packages/domain/src 里还有其他冲突则算不出，返回 undefined。
 */
async function mergedGrantDigest(base) {
  const run = spawnSync('git', ['merge-tree', '--write-tree', '--no-messages', base.head, base.main], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (run.status !== 0 && run.status !== 1) return undefined;
  return treeGrantDigest(run.stdout.split('\n')[0].trim(), (file, dir) => {
    if (!CONFLICT_MARKER_RE.test(readIn(dir, file))) return true;
    const diff3 = file === GRANTS_PATH ? diff3Text(file, revsOf(base)) : undefined;
    const resolved = diff3 === undefined ? null : resolveGrantConflict(file, diff3);
    if (!resolved || resolved.remaining) return false;
    writeIn(dir, file, resolved.text);
    return true;
  });
}

/** --check：按合并结果的指纹预告定号（P3-2）；算不出时按本分支（基准的 head，不读工作区）相对分叉点的指纹给条件式提示。 */
async function printGrantPlan(base, upToDate) {
  const mainGrants = show(base.main, GRANTS_PATH);
  const forkGrants = show(base.fork, GRANTS_PATH);
  if (mainGrants === undefined || forkGrants === undefined) return;
  const branchDigest = await treeGrantDigest(base.head);
  if (branchDigest === undefined)
    return console.log(
      '授权版本：本分支的授权项编码指纹算不出（packages/domain/src 写不出或加载失败），以合并时的实际定号为准',
    );
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
function predictConflicts(base) {
  const run = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', base.head, base.main], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (run.status !== 0 && run.status !== 1) fail(`git merge-tree 失败（需要 git ≥ 2.38）：${run.stderr}`);
  return run.stdout.split('\n').slice(1).filter(Boolean);
}

/** 本分支迁移改号计划：本分支、main 都取自基准（开始时的提交）。 */
function migrationPlan(base) {
  const mainJournal = json(base.main, JOURNAL_PATH);
  const branchJournal = json(base.head, JOURNAL_PATH);
  if (!mainJournal || !branchJournal) fail(`读不到 ${JOURNAL_PATH}`);
  const sql = {
    main: (tag) => show(base.main, sqlPath(tag)),
    branch: (tag) => show(base.head, sqlPath(tag)),
  };
  try {
    const plan = planRenumber(mainJournal, branchJournal, sql);
    return { ...plan, identityProblems: identityProblems(base, plan, mainJournal, sql) };
  } catch (error) {
    return fail(`迁移改号计划失败：${error.message}`);
  }
}

/** 保留（改号）的迁移的快照 id 不能与 main 或彼此重复（见 checkSnapshotIdentity）；读 main 全部快照 id 只在有改号时做。 */
function identityProblems(base, plan, mainJournal, sql) {
  if (!plan.renames.length) return [];
  const idOf = (rev, idx) => json(rev, snapshotPath(idx))?.id;
  return checkSnapshotIdentity({
    main: mainJournal.entries.map((e) => ({ tag: e.tag, id: idOf(base.main, e.idx) })),
    kept: plan.renames.map(({ from }) => ({ tag: from.tag, id: idOf(base.head, from.idx) })),
    mainLastId: idOf(base.main, mainJournal.entries.at(-1).idx),
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

function rebasedSnapshots(base, plan) {
  const mainJournal = json(base.main, JOURNAL_PATH);
  const mainLast = json(base.main, snapshotPath(mainJournal.entries.at(-1).idx));
  // 每条新增迁移的增量基准 = 它在本分支 journal 里的前一条（可能是已合并的旧名迁移）
  const bases = plan.renames.map(({ baseIdx }) => baseIdx !== undefined && json(base.head, snapshotPath(baseIdx)));
  const own = plan.renames.map(({ from }) => json(base.head, snapshotPath(from.idx)));
  if (!mainLast || bases.some((s) => !s) || own.some((s) => !s)) fail('迁移快照缺失，无法自动改号，请人工处理');
  const { snapshots, conflicts } = rebaseSnapshots(bases[0], own, mainLast, bases);
  if (conflicts.length) fail(`迁移快照与 main 改了同一处，须人工处理：\n  ${conflicts.join('\n  ')}`);
  return snapshots;
}

/**
 * 写改号后的 SQL、快照与 journal；旧路径（改号前的、已合并的旧名迁移）若是 main 的文件就恢复成 main 版本，否则删掉。
 * 没有新增迁移（只有已合并的旧名迁移）时不需要重算快照。
 */
function applyRenumber(base, plan) {
  const snapshots = plan.renames.length ? rebasedSnapshots(base, plan) : [];
  const written = new Set();
  plan.renames.forEach(({ from, to }, i) => {
    writeRepo(sqlPath(to.tag), show(base.head, sqlPath(from.tag)) ?? fail(`缺少 ${sqlPath(from.tag)}`));
    writeRepo(snapshotPath(to.idx), drizzleJson(snapshots[i]));
    written.add(sqlPath(to.tag)).add(snapshotPath(to.idx));
  });
  for (const { from } of [...plan.renames, ...plan.stale]) {
    for (const old of [sqlPath(from.tag), snapshotPath(from.idx)]) {
      if (written.has(old)) continue;
      const onMain = show(base.main, old);
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

const PNPM = process.env.npm_execpath ? [process.execPath, process.env.npm_execpath] : ['pnpm'];
const pnpmIn = (dir, argv, env = process.env) =>
  spawnSync(PNPM[0], [...PNPM.slice(1), ...argv], { cwd: dir, stdio: 'inherit', env });

/** 重算（#197）：只在隔离目录 dir 里跑，产物由 collectTree 按内容收集，不 git add。 */
function regenerate(dir) {
  for (const step of REGEN_STEPS) {
    console.log(
      `重算：${Object.entries(step.env)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')} pnpm test ${step.files.join(' ')}`,
    );
    const run = pnpmIn(dir, ['test', ...step.files], { ...process.env, ...step.env, GENERATED_STRICT: '0' });
    if (run.status !== 0) throw new Error('重算命令有测试失败（不只是生成物）：修好后运行 pnpm merge:main --continue');
  }
}

/** 重算与授权定号允许改动的路径（隔离目录里别处有改动就判失败）。 */
const REGEN_DIRS = [
  'tests/acceptance/support/route-policy/required/digests/',
  'tests/acceptance/support/route-policy/baseline/',
];
const GRANT_FILES = [GRANTS_PATH, GRANT_HISTORY_PATH, GRANT_CHANGES_PATH];
const generatedByScript = (file) => GRANT_FILES.includes(file) || REGEN_DIRS.some((dir) => file.startsWith(dir));

/**
 * 隔离重算（DEC-501①②⑤）：从待提交树 t0 逐字节写出临时目录，有 lockfile 就在里面装依赖，授权定号与重算都只在里面跑；
 * 之后按内容比对收集产物、写出新树返回。用户工作区不参与：它的标记、filter、被忽略的本地文件都影响不到读到的内容。
 * 既不重算、也没有授权文件时没有要读的文件，直接返回 t0。
 */
async function isolatedRegen(base, t0) {
  const regen = !args.has('--no-regen');
  const grants = GRANT_FILES.some((file) => show(t0, file) !== undefined || show(base.main, file) !== undefined);
  if (!regen && !grants) return t0;
  const iso = await isolation.materializeTree(t0).catch((error) => fail(`写出待提交树失败：${error.message}`));
  console.log(`隔离重算：待提交树 ${t0.slice(0, 12)} 已逐字节写出到 ${iso.dir}`);
  try {
    if (existsSync(path.join(iso.dir, 'pnpm-lock.yaml'))) {
      const install = pnpmIn(iso.dir, ['install', '--frozen-lockfile', '--prefer-offline']);
      if (install.status !== 0) throw new Error('隔离目录里 pnpm install 失败');
    }
    if (grants)
      await assignGrantVersion(base, iso.dir).catch((error) => {
        throw new Error(`授权版本定号失败：${error.message}\n请人工处理后运行 pnpm merge:main --continue`);
      });
    if (regen) regenerate(iso.dir);
    const { tree, changed, problems } = isolation.collectTree(iso, t0, generatedByScript);
    if (problems.length) throw new Error(`隔离重算的产物不能提交（不提交）：\n  ${problems.join('\n  ')}`);
    if (changed.length) console.log(`隔离重算产物（写进待提交树 ${tree.slice(0, 12)}）：\n  ${changed.join('\n  ')}`);
    return tree;
  } catch (error) {
    iso.cleanup();
    return fail(error.message);
  } finally {
    iso.cleanup();
  }
}

/**
 * 提交（DEC-501③，第 6 轮）：用核对过的固定树 t1 直接 commit-tree，父提交是基准的 head（合并时再加基准的 main），
 * update-ref 更新基准的 ref、CAS 旧值是基准的 head——都不是此刻的 HEAD：期间有人提交、切分支或 reset，
 * 提交前的检查或 update-ref 的 CAS 会拦下，非 0 退出，不重试、不并入。hooksPath 指向空目录，任何 hook 都没有机会改树；
 * 提交后断言 HEAD^{tree} = t1。随后清掉合并状态，把用户的索引与工作区从 t0 同步到 t1（只动重算 / 定号改了的文件）。
 */
function commitTree(base, t0, t1) {
  requireBaseUnmoved(base, '提交前');
  if (!base.merging && t1 === git('rev-parse', `${base.head}^{tree}`).trim()) {
    console.log('已是最新，无需提交');
    return false;
  }
  const noHooks = mkdtempSync(path.join(tmpdir(), 'merge-main-nohooks-'));
  try {
    const quiet = (...argv) => git('-c', `core.hooksPath=${noHooks}`, ...argv);
    const parents = base.merging ? ['-p', base.head, '-p', base.main] : ['-p', base.head];
    const commit = quiet('commit-tree', t1, ...parents, '-m', COMMIT_MESSAGE).trim();
    const message = `merge:main: ${COMMIT_MESSAGE}`;
    const cas = spawnSync(
      'git',
      ['-c', `core.hooksPath=${noHooks}`, 'update-ref', '-m', message, base.ref, commit, base.head],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (cas.status !== 0)
      fail(
        `提交时 ${base.ref} 已不在 ${short(base.head)}（${cas.stderr.trim()}）：HEAD 在脚本运行期间被移动。\n${MOVED_HINT}`,
      );
    const committed = git('rev-parse', 'HEAD^{tree}').trim();
    if (committed !== t1)
      fail(`提交后的树 ${committed} 不是核对过的树 ${t1}（${base.ref} 已指向 ${commit}），请人工检查`);
    if (base.merging) quiet('merge', '--quit');
    const sync = spawnSync('git', ['-c', `core.hooksPath=${noHooks}`, 'read-tree', '-m', '-u', t0, t1], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (sync.status !== 0)
      console.warn(
        `提交已完成，但工作区没能同步到提交内容（${sync.stderr.trim()}）：请确认没有自己的改动后 git reset --hard HEAD`,
      );
    console.log(
      `已提交：${COMMIT_MESSAGE}（${commit.slice(0, 7)}，树 ${t1.slice(0, 12)} 即核对过的树）；推送后 CI 按严格模式校验生成物`,
    );
    return true;
  } finally {
    rmSync(noHooks, { recursive: true, force: true });
  }
}

function resolveGenerated(base, files) {
  if (files.length) console.log(`生成物冲突取 main 版本（随后重算）：\n  ${files.join('\n  ')}`);
  for (const file of files) {
    if (show(base.main, file) === undefined) git('rm', '-q', '--', file);
    else {
      git('checkout', base.main, '--', file);
      git('add', '--', file);
    }
  }
}

/** 提交之后汇总“证据登记差异说明”（#197）：只提示，不改退出码；待说明项要在 PR 描述里逐条说明。 */
function explainGraphDiff() {
  const run = spawnSync(process.execPath, ['scripts/explain-graph-diff.mjs'], { cwd: ROOT, encoding: 'utf8' });
  const lines = `${run.stdout}${run.stderr}`.split('\n');
  const summary = lines.findLast((line) => /^可解释 \d+ 项，待说明 \d+ 项/.test(line));
  const pending = lines.filter((line) => line.startsWith('待说明 '));
  if (!summary)
    return console.log(
      `证据登记差异说明没有给出汇总（退出码 ${run.status}），请手工运行 node scripts/explain-graph-diff.mjs`,
    );
  console.log(`证据登记差异说明（node scripts/explain-graph-diff.mjs）：${summary}`);
  if (pending.length) console.log(`  待说明项（须在 PR 描述里逐条说明）：\n    ${pending.join('\n    ')}`);
}

async function check(base) {
  const upToDate = !base.merging;
  console.log(upToDate ? `当前分支已包含 ${MAIN}。` : `需要合并 ${MAIN}。`);
  const conflicts = splitConflicts(upToDate ? [] : predictConflicts(base));
  const grants = grantConflicts(conflicts.other, revsOf(base)).map((g) => g.file);
  conflicts.other = conflicts.other.filter((f) => !grants.includes(f));
  const registry = await registryConflicts(conflicts.other, revsOf(base));
  const registryFiles = registry.resolved.map((r) => r.file);
  conflicts.other = conflicts.other.filter((f) => !registryFiles.includes(f));
  printConflicts(conflicts);
  if (grants.length) console.log(`授权版本冲突（合并时自动定号）：\n  ${grants.join('\n  ')}`);
  if (registryFiles.length) console.log(`登记类冲突（合并时自动取并集）：\n  ${registryFiles.join('\n  ')}`);
  printRegistryManual(registry.manual);
  if (conflicts.other.length) printCountHint(countOnlyConflicts(conflicts.other, revsOf(base)));
  const plan = migrationPlan(base);
  printPlan(plan);
  await printGrantPlan(base, upToDate);
  console.log(`生成物白名单：\n  ${GENERATED_PATHS.join('\n  ')}`);
  console.log(`登记类（两边纯新增时自动取并集）：\n  ${REGISTRY_PATHS.join('\n  ')}`);
  process.exit(conflicts.other.length || plan.identityProblems.length ? 1 : 0);
}

function startMerge(base) {
  // 未跟踪文件也算：重算会读到、提交不含（F-133 第 4 轮），在开始合并前拦下，免得停在合并中途
  const dirty = git('status', '--porcelain').trimEnd();
  if (dirty) fail(`工作区有未提交的改动或未跟踪的文件，先提交、暂存或移走：\n${dirty}`);
  if (!base.merging) return console.log(`已包含 ${MAIN}，只检查迁移编号与重算`);
  // 合并的是基准里的 main 提交（不是此刻的 origin/main），MERGE_HEAD 就是 base.main
  spawnSync('git', ['merge', '--no-ff', '--no-commit', base.main], { cwd: ROOT, stdio: 'inherit' });
  if (!mergeInProgress()) fail('git merge 失败');
}

/** 冲突处理：生成物取 main、授权版本、登记类取并集、（可选）只改计数；剩下业务冲突就停下。 */
async function resolveConflicts(base) {
  const conflicts = splitConflicts(unmerged());
  resolveGenerated(base, conflicts.generated);
  const grants = conflicts.other.length ? grantConflicts(conflicts.other, revsOf(base)) : [];
  for (const { file, text } of grants) {
    writeRepo(file, text);
    git('add', '--', file);
  }
  if (grants.length) console.log(`授权版本冲突取 main 一侧（随后定号）：\n  ${grants.map((g) => g.file).join('\n  ')}`);
  let other = conflicts.other.filter((f) => !grants.some((g) => g.file === f));
  const registry = await registryConflicts(other, revsOf(base));
  for (const { file, text } of registry.resolved) {
    writeRepo(file, text);
    git('add', '--', file);
  }
  if (registry.resolved.length)
    console.log(`登记类冲突取并集（两边新增项都保留）：\n  ${registry.resolved.map((r) => r.file).join('\n  ')}`);
  printRegistryManual(registry.manual);
  other = other.filter((f) => !registry.resolved.some((r) => r.file === f));
  const countOnly = other.length ? countOnlyConflicts(other, revsOf(base)) : [];
  if (args.has('--take-ours-for-counts') && countOnly.length) {
    const resolved = resolveCountOnly(countOnly);
    other = other.filter((f) => !resolved.has(f));
  }
  if (other.length) {
    printConflicts({ generated: [], other });
    printCountHint(countOnly.filter(({ file }) => other.includes(file)));
    fail('请手工解决上面的业务冲突并 git add，然后运行 pnpm merge:main --continue');
  }
}

async function main() {
  const continuing = args.has('--continue');
  // --continue 接着一次已开始的合并：不再 fetch，核对与提交都对准开始合并时的 main（fixBase 要求 MERGE_HEAD = origin/main）
  if (!args.has('--no-fetch') && !(continuing && mergeInProgress())) git('fetch', '-q', 'origin', 'main');
  if (args.has('--check')) return check(fixBase(false));
  refuseUnprovable('开始前');
  // 基准在这里固定一次（fetch 之后、动仓库之前），此后不再解析 HEAD / origin/main
  const base = fixBase(continuing);
  if (!continuing) startMerge(base);
  requireBaseUnmoved(base, '开始合并后');
  await resolveConflicts(base);
  requireWorktreeIsIndex('冲突处理后');
  refuseUnprovable('冲突处理后');
  const plan = migrationPlan(base);
  printPlan(plan);
  if (plan.identityProblems.length)
    fail('保留迁移的快照身份重复（见上），未改号；人工处理后运行 pnpm merge:main --continue');
  if (plan.changed) applyRenumber(base, plan);
  // 此后不再碰仓库索引：t0 = 索引写出的树，重算 / 定号在隔离目录里做并写出 t1，核对与提交都只认这两棵树
  const t0 = git('write-tree').trim();
  requireBaseUnmoved(base, '写出待提交树后');
  await verifyRegistries(base, t0, '重算前');
  const t1 = await isolatedRegen(base, t0);
  await verifyRegistries(base, t1, '提交前');
  if (commitTree(base, t0, t1) && !args.has('--no-regen')) explainGraphDiff();
}

await main();
