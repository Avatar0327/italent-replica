// F-133 第 5 轮（DEC-501）：pnpm merge:main 的“隔离重算”，用例见 tests/merge-main-conflicts.test.ts。
// 第 1～4 轮的同类问题都是“核对的对象 ≠ 提交的对象”：核对读工作区而提交读索引，或者靠“工作区 = 索引”的检查
// 去证明重算读到的就是要提交的，而 assume-unchanged、skip-worktree、filter、sparse、子模块、外部符号链接都能让这个检查失效。
// 本模块把读写都绑到明确的树上，不再经过用户工作区：
//   ① materializeTree：从待提交树 T0 用 git cat-file --batch 逐字节写出临时目录（不走 checkout，filter / eol / sparse / 标记都不生效）；
//   ② 重算与授权定号只在这个目录里跑（由 merge-main.mjs 调用）；
//   ③ collectTree：重算后逐个文件按内容（hash-object --no-filters）与 T0 比对，改动只许落在给定的生成物路径里，
//      被忽略的新文件一律报出；用临时索引写出新树 T1，由调用方对 T1 做最终核对，再用 commit-tree 提交 T1；
//   ④ unprovableProblems：无法证明一致的配置（上面那几种）在开始前与冲突处理后直接拒绝（DEC-402，不尝试兼容）。
// 第 6 轮（第 5 轮审查 P2-2）：符号链接是否走出隔离根，不再按文本判断，改为写出后用 realpath(3) 按链接链实际解析
// （linksOutside）；④ 里的文本判断只是开始前的快速预检。
// ctx = { root, gitDir, git }：git 调用都在仓库根执行，或用 --git-dir 显式指向本仓库。
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SYMLINK = '120000';
const GITLINK = '160000';
/** 依赖目录：在临时目录里由 pnpm install 生成，不属于任何树，比对时跳过。 */
const DEPENDENCY_DIR = 'node_modules';

const split0 = (text) => text.split('\0').filter(Boolean);

/**
 * 符号链接目标按文本看是否走出仓库（绝对路径，或相对路径走出仓库根）。不跟随链接，链接链（a/up → ../..，
 * 再经 a/up/../.. 出去）看不出来，所以只用作开始前的快速预检；是否在隔离根内以写出后的 linksOutside 为准。
 */
export function symlinkEscapes(file, target) {
  if (path.posix.isAbsolute(target) || path.win32.isAbsolute(target)) return true;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
  return resolved === '..' || resolved.startsWith('../');
}

/** `git ls-files -s -z`（模式 对象 阶段）与 `git ls-tree -r -z`（模式 类型 对象）的一行。 */
function parseEntry(line) {
  const tab = line.indexOf('\t');
  const fields = line.slice(0, tab).split(' ');
  const sha = /^\d$/.test(fields[2]) ? fields[1] : fields[2];
  return { mode: fields[0], sha, file: line.slice(tab + 1) };
}

export function createIsolation(root) {
  const git = (args, options = {}) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, ...options });
  const ctx = { root, git, gitDir: git(['rev-parse', '--absolute-git-dir']).trim() };
  return {
    unprovableProblems: () => unprovableProblems(ctx),
    materializeTree: (tree, prefix) => materializeTree(ctx, tree, prefix),
    collectTree: (iso, tree, allowed) => collectTree(ctx, iso, tree, allowed),
  };
}

// ---------------------------------------------------------------------------------------------
// ④ 无法证明一致的配置

const configTrue = (root, key) =>
  spawnSync('git', ['config', '--bool', '--get', key], { cwd: root, encoding: 'utf8' }).stdout.trim() === 'true';

/**
 * 无法证明“读到的 = 提交的”的配置（DEC-501④）：每一种都能让工作区内容与索引 / 树不同而 Git 不报差异，
 * 或让写出 / 暂存的内容被改写。遇到就拒绝并说明处理办法，不做兼容。
 */
function unprovableProblems({ root, git }) {
  const problems = [];
  const tags = split0(git(['ls-files', '-v', '-z']));
  const flagged = (pick) => tags.filter((t) => pick(t[0])).map((t) => t.slice(2));
  const assumed = flagged((tag) => tag !== tag.toUpperCase());
  const skipped = flagged((tag) => tag === 'S' || tag === 's');
  if (assumed.length)
    problems.push(`assume-unchanged 标记（git update-index --no-assume-unchanged <文件>）：${assumed.join('、')}`);
  if (skipped.length)
    problems.push(`skip-worktree 标记（git update-index --no-skip-worktree <文件>）：${skipped.join('、')}`);
  const sparse = ['core.sparseCheckout', 'index.sparse'].filter((key) => configTrue(root, key));
  if (sparse.length) problems.push(`sparse-checkout 已开启（${sparse.join('、')}；git sparse-checkout disable）`);
  const staged = split0(git(['ls-files', '-s', '-z'])).map(parseEntry);
  const gitlinks = staged.filter((e) => e.mode === GITLINK).map((e) => e.file);
  if (gitlinks.length) problems.push(`子模块（gitlink，内容不在本仓库的树里，无法核对）：${gitlinks.join('、')}`);
  const escaping = staged
    .filter((e) => e.mode === SYMLINK && symlinkEscapes(e.file, git(['cat-file', 'blob', e.sha])))
    .map((e) => e.file);
  if (escaping.length) problems.push(`指向仓库外的符号链接：${escaping.join('、')}`);
  const filtered = filterAttributes(
    git,
    staged.map((e) => e.file),
  );
  if (filtered.length)
    problems.push(`设置了 filter 属性的文件（clean / smudge 会改写暂存与检出的内容）：${filtered.join('、')}`);
  return problems;
}

/** 设置了 filter 属性的路径（来源含 .gitattributes、.git/info/attributes、core.attributesFile；.gitattributes 取索引里的）。 */
function filterAttributes(git, files) {
  if (!files.length) return [];
  const out = split0(git(['check-attr', '--cached', '-z', '--stdin', 'filter'], { input: files.join('\0') }));
  const hits = [];
  for (let i = 0; i + 2 < out.length; i += 3) if (!['unspecified', 'unset'].includes(out[i + 2])) hits.push(out[i]);
  return hits;
}

// ---------------------------------------------------------------------------------------------
// ① 从树逐字节写出临时目录

/** git cat-file --batch 逐个读出对象原始字节（流式解析：只有凑够一个对象时才拼接缓冲）。 */
async function catBlobs(gitDir, shas, onBlob) {
  if (!shas.length) return;
  const child = spawn('git', ['--git-dir', gitDir, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.end(shas.map((sha) => `${sha}\n`).join(''));
  let parts = [];
  let have = 0;
  let need = 0;
  let index = 0;
  for await (const chunk of child.stdout) {
    parts.push(chunk);
    have += chunk.length;
    if (have < need) continue;
    let buf = Buffer.concat(parts);
    for (;;) {
      const nl = buf.indexOf(10);
      const header = nl < 0 ? [] : buf.subarray(0, nl).toString().split(' ');
      const end = nl + 1 + Number(header[2]);
      if (nl < 0 || buf.length < end + 1) {
        need = nl < 0 ? buf.length + 1 : end + 1;
        break;
      }
      if (header[1] !== 'blob') throw new Error(`读不到对象 ${header[0]}（${header[1]}）`);
      onBlob(index++, buf.subarray(nl + 1, end));
      buf = buf.subarray(end + 1);
      need = 0;
    }
    parts = [buf];
    have = buf.length;
  }
  if (index !== shas.length) throw new Error(`git cat-file 只读出 ${index} / ${shas.length} 个对象`);
}

/** 写出一个条目：普通文件按对象原样写、可执行位照模式；符号链接按目标文本原样建（是否在根内由 linksOutside 判断）。 */
function writeEntry(dir, { mode, file }, bytes) {
  const target = path.join(dir, file);
  mkdirSync(path.dirname(target), { recursive: true });
  if (mode !== SYMLINK) return writeFileSync(target, bytes, { mode: mode === '100755' ? 0o755 : 0o644 });
  symlinkSync(bytes.toString(), target);
}

/**
 * 按链接链的实际解析判断（第 5 轮审查 P2-2，DEC-402）：每个符号链接用 realpath(3) 解析到底，结果必须在隔离根内；
 * 解析不了（目标不存在、成环、无权限）同样无法证明，一律列出。
 * 必须用 realpathSync.native：Node 默认的 realpathSync 先按文本消掉链接目标里的“..”再逐级解析（up/.. 被当成原地），
 * 与内核不一致——正是 up → ../../..、leak → ../d/e/f/up/../../outside.txt 这类链接链的漏洞。
 * 每个链接都解析在根内时，树里不含“..”的路径逐级下降、每经过一个链接都落回根内，读到的都是根内（= 树里）的内容。
 */
function linksOutside(dir, links) {
  const root = realpathSync.native(dir);
  return links.filter((file) => {
    try {
      const real = realpathSync.native(path.join(dir, file));
      return real !== root && !real.startsWith(`${root}${path.sep}`);
    } catch {
      return true;
    }
  });
}

/**
 * 把树 tree（给了 prefix 就只取这个目录）逐字节写进新建的临时目录（DEC-501①）；子模块抛错（unprovableProblems 已先拦下，
 * 这里是同一条件的兜底）。先写普通文件、最后建符号链接：写普通文件时目录里还没有任何链接，每次写入都落在临时目录里；
 * 全部写完后按链接链实际解析，有链接不在隔离根内就抛错（在任何读取之前）。
 * 返回 { base, dir, entries: 路径 → { mode, sha }, cleanup }；base 下还放临时索引，dir 是写出的目录。
 */
async function materializeTree({ git, gitDir }, tree, prefix) {
  const base = mkdtempSync(path.join(tmpdir(), 'merge-main-isolated-'));
  const dir = path.join(base, 'tree');
  mkdirSync(dir);
  const cleanup = () => rmSync(base, { recursive: true, force: true });
  try {
    const list = split0(git(['ls-tree', '-r', '-z', tree, ...(prefix ? ['--', prefix] : [])])).map(parseEntry);
    const gitlinks = list.filter((e) => e.mode === GITLINK).map((e) => e.file);
    if (gitlinks.length) throw new Error(`树里有子模块，无法写出：${gitlinks.join('、')}`);
    const links = list.filter((e) => e.mode === SYMLINK);
    const ordered = [...list.filter((e) => e.mode !== SYMLINK), ...links];
    await catBlobs(
      gitDir,
      ordered.map((e) => e.sha),
      (i, bytes) => writeEntry(dir, ordered[i], bytes),
    );
    const outside = linksOutside(
      dir,
      links.map((e) => e.file),
    );
    if (outside.length)
      throw new Error(
        `符号链接按实际解析不在隔离根内（或解析不了），无法证明重算读到的都来自待提交树（DEC-402）：${outside.join('、')}` +
          '（改成直接指向仓库内已有文件的链接，或改为普通文件）',
      );
    return { base, dir, entries: new Map(list.map((e) => [e.file, { mode: e.mode, sha: e.sha }])), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// ③ 重算后按内容比对、写出新树

/** 目录里现有的条目（跳过依赖目录）：路径 → { kind: 'file' | 'link' | 'other', mode }。 */
function walk(dir) {
  const found = new Map();
  const visit = (rel) => {
    for (const item of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const file = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        if (item.name !== DEPENDENCY_DIR) visit(file);
      } else if (item.isSymbolicLink()) found.set(file, { kind: 'link', mode: SYMLINK });
      else if (!item.isFile()) found.set(file, { kind: 'other', mode: '' });
      else found.set(file, { kind: 'file', mode: lstatSync(path.join(dir, file)).mode & 0o111 ? '100755' : '100644' });
    }
  };
  visit('');
  return found;
}

/** 按内容算对象 id（--no-filters：不经任何 filter / eol 转换；write 为真时同时写入对象库）。 */
function hashFiles({ git, gitDir }, dir, files, write) {
  if (!files.length) return [];
  const args = ['--git-dir', gitDir, 'hash-object', '--no-filters', '--stdin-paths', ...(write ? ['-w'] : [])];
  return git(args, { cwd: dir, input: files.map((f) => `${f}\n`).join('') })
    .trim()
    .split('\n');
}

/** 符号链接的对象 = 链接目标文本。 */
const hashLink = ({ git, gitDir }, dir, file, write) =>
  git(['--git-dir', gitDir, 'hash-object', '--no-filters', '--stdin', ...(write ? ['-w'] : [])], {
    cwd: dir,
    input: readlinkSync(path.join(dir, file)),
  }).trim();

/** 新增文件里被忽略的（按临时目录里的 .gitignore 与仓库的 info/exclude、core.excludesFile）。 */
function ignoredOf({ gitDir }, dir, files) {
  if (!files.length) return [];
  const run = spawnSync(
    'git',
    ['--git-dir', gitDir, '--work-tree', dir, 'check-ignore', '--no-index', '-z', '--stdin'],
    {
      cwd: dir,
      input: files.join('\0'),
      encoding: 'utf8',
    },
  );
  if (run.status !== 0 && run.status !== 1) throw new Error(`git check-ignore 失败：${run.stderr}`);
  return split0(run.stdout);
}

/** 目录相对写出时的树的改动：changed（新增 / 修改，带 added）、deleted、others（既不是文件也不是链接）。 */
function diffAgainstTree(ctx, iso) {
  const found = walk(iso.dir);
  const files = [...found].filter(([, f]) => f.kind === 'file').map(([file]) => file);
  const shas = new Map(hashFiles(ctx, iso.dir, files, false).map((sha, i) => [files[i], sha]));
  const changed = [];
  const others = [];
  for (const [file, f] of found) {
    if (f.kind === 'other') {
      others.push(file);
      continue;
    }
    const before = iso.entries.get(file);
    const sha = f.kind === 'file' ? shas.get(file) : hashLink(ctx, iso.dir, file, false);
    if (!before || before.mode !== f.mode || before.sha !== sha)
      changed.push({ file, kind: f.kind, mode: f.mode, added: !before });
  }
  const deleted = [...iso.entries.keys()].filter((file) => !found.has(file));
  return { changed, deleted, others };
}

/** 在 tree 上写入改动（临时索引，不碰仓库索引），返回新树。 */
function writeChanges(ctx, iso, tree, changed, deleted) {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(iso.base, 'index') };
  ctx.git(['read-tree', tree], { env });
  const regular = changed.filter((c) => c.kind === 'file');
  const written = hashFiles(
    ctx,
    iso.dir,
    regular.map((c) => c.file),
    true,
  );
  const links = changed.filter((c) => c.kind === 'link');
  const lines = [
    ...regular.map((c, i) => `${c.mode} ${written[i]}\t${c.file}`),
    ...links.map((c) => `${SYMLINK} ${hashLink(ctx, iso.dir, c.file, true)}\t${c.file}`),
    // 模式 0 = 从索引删除该路径（对象 id 不读，按树 id 的长度补零）
    ...deleted.map((file) => `0 ${'0'.repeat(tree.length)}\t${file}`),
  ];
  ctx.git(['update-index', '-z', '--index-info'], { env, input: lines.map((line) => `${line}\0`).join('') });
  return ctx.git(['write-tree'], { env }).trim();
}

/**
 * 重算之后：逐个文件按内容与写出时的树 tree 比对（DEC-501②⑤）。改动（新增 / 修改 / 删除）只许落在 allowed(路径) 为真的
 * 路径里；新增文件被 .gitignore 忽略的一律列为问题（不静默丢下，也不悄悄纳入）。
 * 返回 { tree, changed, problems }：没有问题时 tree 为写入改动后的新树、changed 为改动的路径；有问题时 tree 原样返回。
 */
function collectTree(ctx, iso, tree, allowed) {
  const { changed, deleted, others } = diffAgainstTree(ctx, iso);
  const problems = [];
  if (others.length) problems.push(`重算留下了既不是文件也不是符号链接的条目：${others.join('、')}`);
  const added = changed.filter((c) => c.added).map((c) => c.file);
  const ignored = ignoredOf(ctx, iso.dir, added);
  if (ignored.length)
    problems.push(
      `重算生成了被忽略的新文件（命中 .gitignore 等忽略规则，不会进提交；须调整忽略规则或生成位置）：${ignored.join('、')}`,
    );
  const touched = [...changed.map((c) => c.file), ...deleted];
  const outside = touched.filter((file) => !ignored.includes(file) && !allowed(file));
  if (outside.length) problems.push(`重算 / 授权定号改动了生成物以外的文件：${outside.join('、')}`);
  if (problems.length || !touched.length) return { tree, changed: [], problems };
  return { tree: writeChanges(ctx, iso, tree, changed, deleted), changed: touched.sort(), problems };
}
