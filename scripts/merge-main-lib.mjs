// DEC-430①：pnpm merge:main 的纯函数部分（不碰 git、不碰文件系统），单测见 tests/merge-main.test.ts。
// - 哪些路径算“生成物”（合并冲突时直接取 main 的版本，之后重算）；
// - 迁移编号在合并时分配：本分支自己的迁移接在 main 最后一条之后，journal 的 when 严格递增；
// - 快照三方合并：本分支快照相对“分叉前快照”的改动叠到 main 最新快照上，并接上 prevId 链；
// - “只改计数”的业务冲突识别：main 一侧相对分叉点只改了数字字面量（如端点计数 592→593）；
// - 授权版本合并时定号（DEC-439④）：STANDARD_GRANT_VERSION / DIGEST 与版本历史 HISTORY 由合并结果决定，
//   本分支改了授权项编码就定为 main + 1 并用合并后的指纹，没改就取 main 的值。

import { createHash } from 'node:crypto';

const MIGRATIONS = 'packages/db/migrations';
const ROUTE_POLICY = 'tests/acceptance/support/route-policy';

export const JOURNAL_PATH = `${MIGRATIONS}/meta/_journal.json`;

/** 生成物白名单：只有这些路径的冲突会自动取 main 版本。账本（probe-known-gaps / probe-redundant）是人工维护，不在内。 */
export const GENERATED_PATHS = Object.freeze([
  `${ROUTE_POLICY}/required/digests/**`,
  `${ROUTE_POLICY}/baseline/observed-contract.json`,
  `${ROUTE_POLICY}/baseline/recorded.json`,
  `${ROUTE_POLICY}/baseline/endpoint-counts.json`,
  `${ROUTE_POLICY}/baseline/probe/*.json`,
  JOURNAL_PATH,
  `${MIGRATIONS}/meta/NNNN_snapshot.json`,
]);

const GENERATED_RE = [
  new RegExp(`^${ROUTE_POLICY}/required/digests/.+`),
  new RegExp(`^${ROUTE_POLICY}/baseline/(observed-contract|recorded|endpoint-counts)\\.json$`),
  new RegExp(`^${ROUTE_POLICY}/baseline/probe/[^/]+\\.json$`),
  new RegExp(`^${MIGRATIONS}/meta/(_journal|\\d{4}_snapshot)\\.json$`),
];

export const isGeneratedPath = (file) => GENERATED_RE.some((re) => re.test(file));

export const pad4 = (idx) => String(idx).padStart(4, '0');
export const snapshotPath = (idx) => `${MIGRATIONS}/meta/${pad4(idx)}_snapshot.json`;
export const sqlPath = (tag) => `${MIGRATIONS}/${tag}.sql`;
const retag = (tag, idx) => `${pad4(idx)}${tag.replace(/^\d+/, '')}`;

/**
 * SQL 是不是“空迁移”：只有空白、分号、行注释（`--` 到行尾）和块注释（斜杠星号开头、星号斜杠结尾，PostgreSQL 允许嵌套）。
 * 词法扫描，不用正则剥注释：双横线之后的内容属行注释，其中的斜杠星号不会开启块注释，所以被“-- 斜杠星号”和“-- 星号斜杠”两行包住的语句仍是语句；
 * 块注释按嵌套深度配对。遇到任何其他字符（语句、引号、dollar quote、单个 `/` 等）立即判定有内容，不需要解析引号内部。
 * drizzle 的 `--> statement-breakpoint` 以 `--` 开头，按行注释处理（是语句分隔标记，不是语句）。
 * 没有结尾的块注释按空处理（保守：不参与去重，不会被误删）。
 */
export function isBlankSql(text) {
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (/\s/.test(text[i]) || text[i] === ';') i += 1;
    else if (two === '--') {
      const end = text.slice(i).search(/[\r\n]/);
      if (end < 0) return true;
      i += end + 1;
    } else if (two === '/*') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        const pair = text.slice(i, i + 2);
        if (pair === '/*') depth += 1;
        else if (pair === '*/') depth -= 1;
        i += pair === '/*' || pair === '*/' ? 2 : 1;
      }
    } else return false;
  }
  return true;
}

/**
 * SQL 内容摘要：原始内容（不做规范化）的 sha256 十六进制。引号、dollar quote 内部的空白与换行是内容，
 * 任何规范化都可能把不同的迁移抹成相同；改号只改文件名，内容逐字节不变，所以直接比原始内容。
 * 读不到或是空迁移（isBlankSql）返回 undefined：不能拿“没内容”当“相同”。
 */
export function sqlDigest(text) {
  if (text === undefined || isBlankSql(text)) return undefined;
  return createHash('sha256').update(text).digest('hex');
}

/** 清理清单的输出行：旧名 → main 名 + sha256，便于在 PR 评论留证（--check 与正式运行都输出）。 */
export const formatStale = (stale) =>
  stale.map(({ from, mainEntry, digest }) => `${from.tag} → ${mainEntry.tag}  sha256=${digest}`);

/**
 * 保留（改号）的迁移与 main 之间的快照身份检查：快照 id 是迁移的身份，改号不改 id。保留项的快照 id 若与 main 上某条、
 * 或与其他保留项重复，说明它其实是同一条迁移（例如叠放分支带着的上游旧名迁移，SQL 摘要因已提交的格式漂移与 main 不同而没被识别），
 * 保留会让同一条迁移执行两遍，并让快照链出现重复 id（与 main 最新一条重复时是 id = prevId 自环）。
 * 返回问题清单（空 = 通过）：每条列出文件对与 SQL 摘要，脚本据此停下交人工；不放宽摘要口径。
 * digestOf(side, tag) 读对应 SQL 的摘要（可不传）。
 */
export function checkSnapshotIdentity({ main, kept, mainLastId, digestOf = () => undefined }) {
  const show = (side, tag) => `${tag}.sql（sha256=${digestOf(side, tag) ?? '无：空迁移或读不到'}）`;
  const problems = [];
  const mainById = new Map(main.filter((e) => e.id !== undefined).map((e) => [e.id, e]));
  const seen = new Map();
  for (const entry of kept) {
    if (entry.id === undefined) continue;
    const other = mainById.get(entry.id);
    const earlier = seen.get(entry.id);
    if (other) {
      const loop = entry.id === mainLastId ? '；保留它会让新快照 id = prevId 形成自环' : '';
      problems.push(
        `快照 id ${entry.id} 重复：本分支 ${show('branch', entry.tag)} 与 main 的 ${show('main', other.tag)}，` +
          `SQL 摘要${digestOf('branch', entry.tag) === digestOf('main', other.tag) ? '相同' : '不同'}${loop}`,
      );
    } else if (earlier) {
      problems.push(`快照 id ${entry.id} 重复：本分支 ${show('branch', earlier.tag)} 与 ${show('branch', entry.tag)}`);
    }
    if (!earlier) seen.set(entry.id, entry);
  }
  return problems;
}

/**
 * 迁移重新编号：branchJournal 里 tag 不在 mainJournal 的条目是本分支自己的迁移，按原顺序接在 main 之后。
 * 叠放 PR（base 是另一个未合并的 PR 分支）会带着上游合并前的旧名迁移：它们与 main 上改号后的迁移 SQL 逐字节相同，
 * 这类条目记入 stale（清理旧名 SQL / 快照 / journal 条目，不改号），只有真正新增的才进 renames。
 * sql.main / sql.branch 按 tag 读迁移 SQL 文本；不传或读不到则该条目只按名字比对。
 * 必须一一对应：同一份内容在旧名一侧或 main 一侧出现多次（一对多 / 多对一）时抛错，不清理；
 * 本分支已带着的 main 同名迁移不参与匹配；空迁移 / 只有注释的迁移不参与去重（见 sqlDigest）。
 * 返回新 journal（main 全部条目 + 改号后的本分支条目）、改号清单 renames 和已合并清单 stale（带 sha256）。
 */
export function planRenumber(mainJournal, branchJournal, sql = {}) {
  const mainTags = new Set(mainJournal.entries.map((e) => e.tag));
  const branchTags = new Set(branchJournal.entries.map((e) => e.tag));
  const added = branchJournal.entries.filter((e) => !mainTags.has(e.tag));
  const byDigest = (entries, read) => {
    const groups = new Map();
    for (const entry of entries) {
      const digest = sqlDigest(read(entry.tag));
      if (digest !== undefined) groups.set(digest, [...(groups.get(digest) ?? []), entry]);
    }
    return groups;
  };
  const addedGroups = added.length && sql.main && sql.branch ? byDigest(added, sql.branch) : new Map();
  const mainGroups = addedGroups.size
    ? byDigest(
        mainJournal.entries.filter((e) => !branchTags.has(e.tag)),
        sql.main,
      )
    : new Map();
  const stale = [];
  for (const [digest, olds] of addedGroups) {
    const mains = mainGroups.get(digest);
    if (!mains) continue;
    if (olds.length > 1 || mains.length > 1)
      throw new Error(
        `旧名迁移 ${olds.map((e) => e.tag).join('、')} 与 main 上的 ${mains.map((e) => e.tag).join('、')} ` +
          `的 SQL 内容相同（sha256=${digest}），但不是一一对应（一对多或多对一），不自动清理，须人工处理`,
      );
    stale.push({ from: olds[0], mainEntry: mains[0], digest });
  }
  const staleTags = new Set(stale.map((s) => s.from.tag));
  stale.sort((a, b) => a.from.idx - b.from.idx);
  const own = added.filter((e) => !staleTags.has(e.tag));
  const last = mainJournal.entries.at(-1);
  let idx = last ? last.idx : -1;
  let when = last ? last.when : 0;
  const renames = own.map((entry) => {
    idx += 1;
    when = Math.max(entry.when, when + 1);
    // baseIdx：本分支 journal 里它的前一条（已合并的旧名条目也算），快照增量以它为基准
    const at = branchJournal.entries.indexOf(entry);
    const baseIdx = at > 0 ? branchJournal.entries[at - 1].idx : undefined;
    return { from: entry, to: { ...entry, idx, when, tag: retag(entry.tag, idx) }, baseIdx };
  });
  const journal = { ...mainJournal, entries: [...mainJournal.entries, ...renames.map((r) => r.to)] };
  const changed = stale.length > 0 || renames.some((r) => r.from.idx !== r.to.idx || r.from.when !== r.to.when);
  // 分叉点：本分支第一条自己的迁移之前那一条（它的快照是本分支快照改动的基准；可能是已合并的旧名条目，快照含上游改动）
  const firstOwn = own.length ? branchJournal.entries.indexOf(own[0]) : -1;
  const forkIdx = firstOwn > 0 ? branchJournal.entries[firstOwn - 1].idx : undefined;
  return { journal, renames, stale, changed, forkIdx };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** JSON 三方合并：本分支改过的键取本分支，没改的取 main；两边都改且结果不同记冲突（取本分支）。 */
export function merge3(base, ours, theirs, at = '') {
  if (same(ours, theirs) || same(base, ours)) return { value: theirs, conflicts: [] };
  if (same(base, theirs)) return { value: ours, conflicts: [] };
  if (!isObject(ours) || !isObject(theirs)) return { value: ours, conflicts: [at || '(根)'] };
  const b = isObject(base) ? base : {};
  const value = {};
  const conflicts = [];
  const keys = new Set([...Object.keys(theirs), ...Object.keys(ours)]);
  for (const key of keys) {
    const merged = merge3(b[key], ours[key], theirs[key], at ? `${at}.${key}` : key);
    conflicts.push(...merged.conflicts);
    if (merged.value !== undefined) value[key] = merged.value;
  }
  return { value, conflicts };
}

/**
 * 本分支快照改接到 main 最新快照：逐条把“该迁移相对本分支 journal 里前一条的增量”叠到当前结果上，
 * 第一条叠在 main 最新快照上，之后每条叠在上一条的结果上：结构 = merge3(前一条快照, 本分支快照, 当前结果)。
 * bases[i] 是第 i 条新增迁移在本分支 journal 里的前一条的快照；不传则认为新增迁移连续（bases = [分叉前快照, own[0], own[1], …]）。
 * 新增迁移之间夹着已合并的旧名迁移（U1→N1→U2→N2）时必须传，否则已合并的上游变化会被当成本分支的改动重算。
 * id 保留本分支的，prevId 第一个指向 main 最新快照，其余沿本分支链。
 */
export function rebaseSnapshots(forkSnapshot, ownSnapshots, mainLast, bases = [forkSnapshot, ...ownSnapshots]) {
  const strip = ({ id: _id, prevId: _prev, ...rest }) => rest;
  const conflicts = [];
  let prevId = mainLast.id;
  let current = strip(mainLast);
  const snapshots = ownSnapshots.map((snapshot, i) => {
    const merged = merge3(strip(bases[i]), strip(snapshot), current);
    conflicts.push(...merged.conflicts.map((c) => `${snapshot.id}: ${c}`));
    current = merged.value;
    const out = { id: snapshot.id, prevId, ...merged.value };
    prevId = snapshot.id;
    return out;
  });
  return { snapshots, conflicts };
}

/**
 * 解析 diff3 风格的冲突文本（git merge-file --diff3 的输出）：返回片段数组，
 * 字符串是无冲突的部分，对象 { ours, base, theirs } 是一处冲突；没有 ||||||| 段时 base 为 null。
 */
export function parseDiff3(text) {
  const segments = [];
  let clean = '';
  let hunk = null;
  let part = '';
  for (const line of text.split(/(?<=\n)/)) {
    const head = line.replace(/\r?\n$/, '');
    if (!hunk) {
      if (/^<{7}(?: |$)/.test(head)) {
        if (clean) segments.push(clean);
        clean = '';
        hunk = { ours: '', base: null, theirs: '' };
        part = 'ours';
      } else clean += line;
      continue;
    }
    if (part === 'ours' && /^\|{7}(?: |$)/.test(head)) {
      hunk.base = '';
      part = 'base';
    } else if (part !== 'theirs' && /^={7}$/.test(head)) part = 'theirs';
    else if (part === 'theirs' && /^>{7}(?: |$)/.test(head)) {
      segments.push(hunk);
      hunk = null;
    } else hunk[part] += line;
  }
  if (hunk) throw new Error('冲突标记不完整');
  if (clean) segments.push(clean);
  return segments;
}

/** 独立的数字字面量（592、1_000、0.5）；标识符里的数字（FW-01、v2、x1）不算。 */
const NUMBER_RE = /(?<![\w$.-])\d[\d_]*(?:\.\d+)?(?![\w$])/g;
export const maskNumbers = (text) => text.replace(NUMBER_RE, '#');

/** 一处冲突“只改计数”：有分叉点内容，且 main 一侧相对分叉点只有数字字面量不同。 */
export const isCountOnlyHunk = ({ base, theirs }) =>
  base !== null && base !== theirs && maskNumbers(base) === maskNumbers(theirs);

/** 冲突文件分类：hunks 为冲突处数，countOnly 表示每一处都是“main 只改计数”。 */
export function classifyConflict(diff3Text) {
  const hunks = parseDiff3(diff3Text).filter((s) => typeof s !== 'string');
  return { hunks: hunks.length, countOnly: hunks.length > 0 && hunks.every(isCountOnlyHunk) };
}

/**
 * 逐处处理冲突：decide(hunk, prefix) 返回替换文本则解决该处，返回 null 则原样保留冲突标记。
 * prefix 是这一处之前的文本（之前未解决的冲突按 main 一侧计），用来判断冲突处在文件里的位置。
 */
export function resolveHunks(diff3Text, decide) {
  let remaining = 0;
  let prefix = '';
  const text = parseDiff3(diff3Text)
    .map((s) => {
      if (typeof s === 'string') {
        prefix += s;
        return s;
      }
      const resolved = decide(s, prefix);
      prefix += resolved ?? s.theirs;
      if (resolved !== null) return resolved;
      remaining += 1;
      const base = s.base === null ? '' : `||||||| merge-base\n${s.base}`;
      return `<<<<<<< HEAD\n${s.ours}${base}=======\n${s.theirs}>>>>>>> origin/main\n`;
    })
    .join('');
  return { text, remaining };
}

/** 把“只改计数”的冲突处取本分支一侧，其余冲突原样保留（含标记）；返回新文本与剩余冲突处数。 */
export const takeOursForCounts = (diff3Text) => resolveHunks(diff3Text, (h) => (isCountOnlyHunk(h) ? h.ours : null));

/** drizzle 的写法：两空格缩进、末尾无换行。 */
export const drizzleJson = (value) => JSON.stringify(value, null, 2);

// ---------------------------------------------------------------------------------------------
// DEC-439④ 授权版本合并时定号（同迁移号，DEC-385① / DEC-404）

export const GRANTS_PATH = 'packages/domain/src/platform/standard-grants.ts';
export const GRANT_HISTORY_PATH = 'tests/acceptance/AC-PLAT-F061-grants.test.ts';

const VERSION_RE = /^export const STANDARD_GRANT_VERSION = (\d+);$/m;
const DIGEST_RE = /^export const STANDARD_GRANT_DIGEST = '([0-9a-f]{16})';$/m;
const CONSTANT_LINE_RE = /^export const STANDARD_GRANT_(?:VERSION = \d+|DIGEST = '[0-9a-f]{16}');$/;
const HISTORY_OPEN_RE = /^([ \t]*)const HISTORY: Record<number, string> = \{$/m;
const HISTORY_ENTRY_RE = /^\s*(\d+): '([0-9a-f]{16})',$/;
const HISTORY_COMMENT_RE = /^\s*\/\/ ?(.*)$/;
const HISTORY_CLOSE_RE = /^\s*\};$/;

/** standard-grants.ts 里的 version 与指纹常量。 */
export function readGrantConstants(text) {
  const version = VERSION_RE.exec(text);
  const digest = DIGEST_RE.exec(text);
  if (!version || !digest) throw new Error(`${GRANTS_PATH} 里找不到 STANDARD_GRANT_VERSION / STANDARD_GRANT_DIGEST`);
  return { version: Number(version[1]), digest: digest[1] };
}

export function writeGrantConstants(text, { version, digest }) {
  readGrantConstants(text);
  return text
    .replace(VERSION_RE, `export const STANDARD_GRANT_VERSION = ${version};`)
    .replace(DIGEST_RE, `export const STANDARD_GRANT_DIGEST = '${digest}';`);
}

/** 版本历史 HISTORY 的位置与条目：每条 { version, digest, comments }，comments 是条目上方的注释行（不含 //）。 */
function locateHistory(text) {
  const open = HISTORY_OPEN_RE.exec(text);
  if (!open) throw new Error(`${GRANT_HISTORY_PATH} 里找不到 const HISTORY`);
  const start = open.index + open[0].length + 1;
  const entries = [];
  let comments = [];
  let at = start;
  for (;;) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) throw new Error('HISTORY 没有闭合');
    const line = text.slice(at, nl);
    if (HISTORY_CLOSE_RE.test(line)) {
      if (comments.length) throw new Error('HISTORY 末尾有不属于任何条目的注释');
      return { start, end: at, indent: `${open[1]}  `, entries };
    }
    const entry = HISTORY_ENTRY_RE.exec(line);
    const comment = HISTORY_COMMENT_RE.exec(line);
    if (entry) {
      entries.push({ version: Number(entry[1]), digest: entry[2], comments });
      comments = [];
    } else if (comment) comments.push(comment[1]);
    else throw new Error(`HISTORY 里有无法识别的行：${line.trim()}`);
    at = nl + 1;
  }
}

export const parseGrantHistory = (text) => locateHistory(text).entries;

export function writeGrantHistory(text, entries) {
  const { start, end, indent } = locateHistory(text);
  const body = entries
    .map(({ version, digest, comments }) =>
      [...comments.map((c) => `${indent}// ${c}`), `${indent}${version}: '${digest}',`].join('\n'),
    )
    .join('\n');
  return `${text.slice(0, start)}${body}\n${text.slice(end)}`;
}

/**
 * 合并时定号：mergedDigest 是合并结果的 grantCodesDigest(STANDARD_GRANT_CODES)。
 * - 与 main 的指纹相同（本分支没改授权项编码，或改动与 main 相同）：version / 指纹 / 历史全部取 main；
 * - 不同：version = main + 1、指纹 = mergedDigest，历史 = main 的历史 + 一行；这一行的注释取本分支历史里 main 没有的条目的注释
 *   （本分支自己递增过几次都并成一行），本分支没写就用 label。
 * changed 表示结果与本分支合并前（branch）的常量或历史不同。
 */
export function planGrantVersion({ main, mainHistory, branch, branchHistory, mergedDigest, label }) {
  const last = mainHistory.at(-1);
  if (!last || last.version !== main.version || last.digest !== main.digest)
    throw new Error(`main 的授权版本历史最后一行与 STANDARD_GRANT_VERSION ${main.version} / 指纹对不上，先修 main`);
  let result;
  if (mergedDigest === main.digest) result = { bumped: false, ...main, history: mainHistory };
  else {
    const onMain = new Set(mainHistory.map((e) => `${e.version}:${e.digest}`));
    const own = branchHistory.filter((e) => !onMain.has(`${e.version}:${e.digest}`));
    const comments = [...new Set(own.flatMap((e) => e.comments))];
    const version = main.version + 1;
    result = {
      bumped: true,
      version,
      digest: mergedDigest,
      history: [...mainHistory, { version, digest: mergedDigest, comments: comments.length ? comments : [label] }],
    };
  }
  const changed =
    !branch ||
    branch.version !== result.version ||
    branch.digest !== result.digest ||
    JSON.stringify(branchHistory) !== JSON.stringify(result.history);
  return { ...result, changed };
}

const nonBlankLines = (text) => (text ?? '').split('\n').filter((l) => l.trim());

/** 冲突处只涉及 version / 指纹两行常量。 */
export const isGrantConstantHunk = (h) => {
  const lines = [h.ours, h.base, h.theirs].flatMap(nonBlankLines);
  return lines.length > 0 && lines.every((l) => CONSTANT_LINE_RE.test(l));
};

/** 冲突处在 HISTORY 内部，且只有“version: 指纹”条目与注释行。 */
export const isGrantHistoryHunk = (h, prefix) => {
  const open = prefix.lastIndexOf('const HISTORY: Record<number, string> = {');
  if (
    open < 0 ||
    prefix
      .slice(open)
      .split('\n')
      .slice(1)
      .some((l) => HISTORY_CLOSE_RE.test(l))
  )
    return false;
  const lines = [h.ours, h.base, h.theirs].flatMap(nonBlankLines);
  return lines.length > 0 && lines.every((l) => HISTORY_ENTRY_RE.test(l) || HISTORY_COMMENT_RE.test(l));
};

/**
 * 授权版本冲突自动处理：standard-grants.ts 里只涉及两行常量、AC-PLAT-F061-grants.test.ts 里只在 HISTORY 内的冲突处取 main 一侧
 * （随后由 planGrantVersion 统一改写），其余冲突原样保留；不是这两个文件返回 null。
 */
export function resolveGrantConflict(file, diff3Text) {
  if (file === GRANTS_PATH) return resolveHunks(diff3Text, (h) => (isGrantConstantHunk(h) ? h.theirs : null));
  if (file === GRANT_HISTORY_PATH)
    return resolveHunks(diff3Text, (h, prefix) => (isGrantHistoryHunk(h, prefix) ? h.theirs : null));
  return null;
}

// ---------------------------------------------------------------------------------------------
// F-097：授权项编码增删声明（动态基线）与 --check 定号预告

/**
 * 本 PR 声明的授权项编码增删：{ reason, add: [...], remove: [...] }。条目是完整编码，或以 * 结尾的前缀（前缀里至少有一个 /，
 * 不允许裸 *）。守卫测试以分叉点（CI 上是测试合并提交的 base）的编码为基线，实际增删必须与声明一致。
 */
export const GRANT_CHANGES_PATH = 'packages/domain/src/platform/standard-grant-changes.json';

export const EMPTY_GRANT_CHANGES = Object.freeze({ reason: '', add: Object.freeze([]), remove: Object.freeze([]) });

export function parseGrantChanges(text) {
  const value = JSON.parse(text);
  const list = (key) => {
    const items = value?.[key];
    if (!Array.isArray(items) || items.some((i) => typeof i !== 'string' || !i))
      throw new Error(`${GRANT_CHANGES_PATH} 的 ${key} 必须是非空字符串数组`);
    for (const item of items)
      if (item.endsWith('*') && !item.slice(0, -1).includes('/'))
        throw new Error(`${GRANT_CHANGES_PATH} 的前缀条目至少要写到身份编码加 /：${item}`);
    return items;
  };
  if (typeof value?.reason !== 'string') throw new Error(`${GRANT_CHANGES_PATH} 缺少 reason（写 PR / 任务与原因）`);
  return { reason: value.reason, add: list('add'), remove: list('remove') };
}

/**
 * 本 PR 生效的声明：声明文件与基线上的内容相同（从 main 继承来的上一个 PR 的声明）视为本 PR 没有声明；
 * 本 PR 改写过（含新建）才生效。这样旧声明不必清空，也不会放过后来的 PR。
 */
export function activeGrantChanges(baseText, headText) {
  if (headText === undefined || headText === baseText) return EMPTY_GRANT_CHANGES;
  return parseGrantChanges(headText);
}

const matchesGrantEntry = (entry, code) => (entry.endsWith('*') ? code.startsWith(entry.slice(0, -1)) : code === entry);

/**
 * 动态基线比较：baseCodes 是基线（分叉点 / 测试合并提交的 base）的编码，headCodes 是当前编码。
 * 失败项：实际新增 / 删除的编码不被任一声明条目覆盖；声明新增的条目在当前编码里一个都没有；声明删除的条目当前仍有。
 * 声明新增的编码若基线已有（别的 PR 先加了同一编码）不算失败——当前编码里有即可。
 */
export function checkGrantChanges({ baseCodes, headCodes, declared }) {
  const base = new Set(baseCodes);
  const head = new Set(headCodes);
  const added = [...head].filter((c) => !base.has(c)).sort();
  const removed = [...base].filter((c) => !head.has(c)).sort();
  const problems = [
    ...added.filter((c) => !declared.add.some((e) => matchesGrantEntry(e, c))).map((c) => `未声明的新增编码：${c}`),
    ...removed
      .filter((c) => !declared.remove.some((e) => matchesGrantEntry(e, c)))
      .map((c) => `未声明的删除编码：${c}`),
    ...declared.add
      .filter((e) => ![...head].some((c) => matchesGrantEntry(e, c)))
      .map((e) => `声明新增但当前编码里没有：${e}`),
    ...declared.remove.flatMap((e) => {
      const left = [...head].filter((c) => matchesGrantEntry(e, c));
      return left.length ? [`声明删除但当前编码里仍有：${e}（如 ${left[0]}）`] : [];
    }),
  ];
  return { added, removed, problems };
}

/**
 * 合并时声明文件取哪一边：本分支相对分叉点改过就整份取本分支（main 上那份是别的 PR 的旧声明），否则取 main。
 * 不做逐行合并——两份声明拼在一起没有意义。返回 undefined 表示两边都没有这个文件。
 */
export function pickGrantChanges({ branch, fork, main }) {
  return branch !== undefined && branch !== fork ? branch : main;
}

/**
 * --check 的授权版本预告（P3-2）：mergedDigest 是“合并结果”的指纹（git merge-tree 算出的树），与实际定号同口径；
 * 算不出（packages/domain/src 里有业务冲突等）时为 undefined，按本分支相对分叉点是否改了编码给出条件式提示。
 */
export function describeGrantPlan({ main, mergedDigest, branchDigest, forkDigest }) {
  if (mergedDigest !== undefined)
    return mergedDigest === main.digest
      ? `授权版本：合并结果的编码与 main 相同（指纹 ${main.digest}），合并时取 main 的 version ${main.version}` +
          (branchDigest !== forkDigest ? '（本分支的编码改动 main 上已有，如别的 PR 加了同一编码）' : '')
      : `授权版本：合并结果的编码与 main 不同，合并时定为 main + 1 = ${main.version + 1}，指纹 ${mergedDigest}`;
  if (branchDigest === forkDigest)
    return `授权版本：本分支没改授权项编码（指纹同分叉点），合并时预计取 main 的 version ${main.version}（合并结果暂算不出，以实际合并为准）`;
  return (
    `授权版本：本分支改了授权项编码（指纹 ${branchDigest}，分叉点 ${forkDigest}）；合并结果暂算不出（有业务冲突），` +
    `合并后若编码与 main 相同（如别的 PR 已加了同一编码）则取 main 的 version ${main.version}，否则定为 main + 1 = ${main.version + 1}`
  );
}
