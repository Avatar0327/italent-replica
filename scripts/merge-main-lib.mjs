// DEC-430①：pnpm merge:main 的纯函数部分（不碰 git、不碰文件系统），单测见 tests/merge-main.test.ts。
// - 哪些路径算“生成物”（合并冲突时直接取 main 的版本，之后重算）；
// - 迁移编号在合并时分配：本分支自己的迁移接在 main 最后一条之后，journal 的 when 严格递增；
// - 快照三方合并：本分支快照相对“分叉前快照”的改动叠到 main 最新快照上，并接上 prevId 链；
// - “只改计数”的业务冲突识别：main 一侧相对分叉点只改了数字字面量（如端点计数 592→593）。

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
 * 迁移重新编号：branchJournal 里 tag 不在 mainJournal 的条目是本分支自己的迁移，按原顺序接在 main 之后。
 * 返回新 journal（main 全部条目 + 改号后的本分支条目）和改号清单 renames。
 */
export function planRenumber(mainJournal, branchJournal) {
  const mainTags = new Set(mainJournal.entries.map((e) => e.tag));
  const own = branchJournal.entries.filter((e) => !mainTags.has(e.tag));
  const last = mainJournal.entries.at(-1);
  let idx = last ? last.idx : -1;
  let when = last ? last.when : 0;
  const renames = own.map((entry) => {
    idx += 1;
    when = Math.max(entry.when, when + 1);
    return { from: entry, to: { ...entry, idx, when, tag: retag(entry.tag, idx) } };
  });
  const journal = { ...mainJournal, entries: [...mainJournal.entries, ...renames.map((r) => r.to)] };
  const changed = renames.some((r) => r.from.idx !== r.to.idx || r.from.when !== r.to.when);
  // 分叉点：本分支第一条自己的迁移之前那一条（它的快照是本分支快照改动的基准）
  const firstOwn = own.length ? branchJournal.entries.indexOf(own[0]) : -1;
  const forkIdx = firstOwn > 0 ? branchJournal.entries[firstOwn - 1].idx : undefined;
  return { journal, renames, changed, forkIdx };
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
 * 本分支快照改接到 main 最新快照：每个快照的结构 = merge3(分叉前快照, 本分支快照, main 最新快照)；
 * id 保留本分支的，prevId 第一个指向 main 最新快照，其余沿本分支链。
 */
export function rebaseSnapshots(forkSnapshot, ownSnapshots, mainLast) {
  const strip = ({ id: _id, prevId: _prev, ...rest }) => rest;
  const conflicts = [];
  let prevId = mainLast.id;
  const snapshots = ownSnapshots.map((snapshot) => {
    const merged = merge3(strip(forkSnapshot), strip(snapshot), strip(mainLast));
    conflicts.push(...merged.conflicts.map((c) => `${snapshot.id}: ${c}`));
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

/** 把“只改计数”的冲突处取本分支一侧，其余冲突原样保留（含标记）；返回新文本与剩余冲突处数。 */
export function takeOursForCounts(diff3Text) {
  let remaining = 0;
  const text = parseDiff3(diff3Text)
    .map((s) => {
      if (typeof s === 'string') return s;
      if (isCountOnlyHunk(s)) return s.ours;
      remaining += 1;
      const base = s.base === null ? '' : `||||||| merge-base\n${s.base}`;
      return `<<<<<<< HEAD\n${s.ours}${base}=======\n${s.theirs}>>>>>>> origin/main\n`;
    })
    .join('');
  return { text, remaining };
}

/** drizzle 的写法：两空格缩进、末尾无换行。 */
export const drizzleJson = (value) => JSON.stringify(value, null, 2);
