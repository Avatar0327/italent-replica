// 覆盖统计：只用运行时收集到的用例（标题层级 + 各档状态），不读测试源码。
// - 一个用例覆盖的编号 = 各级 describe 标题与自身标题逐段提取后的并集（R1 报告 §3 口径）。
// - 运行时状态：已覆盖（某一档为 run）、仅 skip / todo、未覆盖、未定义（定义来源里找不到）。
// - 人工层（阶段配置 notes）：status 改判为部分覆盖 / 未覆盖（须写分类与原因）；evidence 按完整标题指认用例，
//   找不到或未运行即列为问题。最终状态与运行时状态并列输出。
// - 缺口：范围内最终状态为未覆盖 / 仅 skip / todo 且没有人工改判的编号，以及范围内未定义的编号。
import { basename } from 'node:path';
import { compareIds, expandScopeToken, parseIds } from './ids.mjs';

export const STATUSES = ['已覆盖', '部分覆盖', '未覆盖', '仅 skip / todo', '未定义'];
const GAP_STATUSES = new Set(['未覆盖', '仅 skip / todo', '未定义']);
const MANUAL_STATUSES = new Set(['部分覆盖', '未覆盖']);

const runsIn = (test) => Object.keys(test.modes).filter((p) => test.modes[p] === 'run');
const titleOf = (test) => test.names.join(' > ');

function withIds(tests, problems) {
  return tests.map((test) => {
    const parsed = test.names.map(parseIds);
    for (const text of parsed.flatMap((p) => p.reversed)) {
      problems.push({ kind: 'title', message: `${test.file}：${titleOf(test)} 的编号区间逆序「${text}」` });
    }
    for (const text of parsed.flatMap((p) => p.malformed)) {
      problems.push({ kind: 'title', message: `${test.file}：${titleOf(test)} 的编号写法无法识别「${text}」` });
    }
    return { ...test, ids: [...new Set(parsed.flatMap((p) => p.ids))].sort(compareIds) };
  });
}

function buildScope(config, stageNames, definedIds, problems) {
  const groups = [];
  const notes = {};
  for (const stage of stageNames) {
    const stageConfig = config.stages.get(stage);
    for (const group of stageConfig.groups ?? []) {
      const ids = new Set();
      for (const token of group.include ?? []) {
        const expanded = expandScopeToken(token, definedIds);
        if (expanded) expanded.forEach((id) => ids.add(id));
        else
          problems.push({ kind: 'config', message: `${stage}：范围写法无法识别、区间逆序或匹配不到定义「${token}」` });
      }
      const name = stageNames.length > 1 ? `${stage} · ${group.name}` : group.name;
      groups.push({ name, ids: [...ids].sort(compareIds) });
    }
    for (const [id, note] of Object.entries(stageConfig.notes ?? {})) {
      if (notes[id] && JSON.stringify(notes[id]) !== JSON.stringify(note)) {
        problems.push({ kind: 'note', message: `${id}：多个阶段的人工备注不一致` });
      }
      notes[id] = note;
    }
  }
  return { groups, notes };
}

function validateNotes(notes, scopeIds, problems) {
  for (const [id, note] of Object.entries(notes)) {
    if (!scopeIds.has(id)) problems.push({ kind: 'note', message: `${id}：人工备注的编号不在统计范围内` });
    if (note.status === undefined) continue;
    if (!MANUAL_STATUSES.has(note.status) || !note.category || !note.note) {
      problems.push({ kind: 'note', message: `${id}：人工改判须为部分覆盖 / 未覆盖，并写分类与原因` });
    }
  }
}

/**
 * 人工映射：names 为完整标题层级（数组逐级精确相等）；只写 title 时按末级标题匹配。
 * 必须恰好命中一个注册用例且该用例在某一档运行；找不到、命中多个、指向未运行的用例都列为问题，不任选替代。
 */
function matchEvidence(id, evidence, tests, problems) {
  const matched = [];
  for (const item of evidence ?? []) {
    const label = `${item.file} / ${item.names ? JSON.stringify(item.names) : item.title}`;
    const hits = tests.filter((t) => basename(t.file) === item.file && evidenceMatches(item, t));
    let reason = null;
    if (hits.length === 0) reason = '找不到用例';
    else if (hits.length > 1) reason = `命中 ${hits.length} 个注册用例，映射有歧义，请写完整标题层级 names`;
    else if (runsIn(hits[0]).length === 0) reason = '指向的用例未运行（skip / todo）';
    if (reason) problems.push({ kind: 'evidence', message: `${id}：人工映射「${label}」${reason}` });
    else matched.push(hits[0]);
  }
  return matched;
}

function evidenceMatches(item, test) {
  if (Array.isArray(item.names)) {
    return item.names.length === test.names.length && item.names.every((name, i) => name === test.names[i]);
  }
  return typeof item.title === 'string' && test.names.at(-1) === item.title;
}

function conditionalProfiles(tests, profiles) {
  if (tests.length === 0 || tests.some((t) => runsIn(t).length === profiles.length)) return [];
  const used = new Set(tests.flatMap(runsIn));
  return profiles.filter((p) => used.has(p));
}

function runtimeStatusOf(defined, covering, running) {
  if (!defined) return '未定义';
  if (running.length) return '已覆盖';
  return covering.length ? '仅 skip / todo' : '未覆盖';
}

function buildEntry(id, context) {
  const { tests, notes, definitions, profiles, problems } = context;
  const note = notes[id] ?? {};
  const covering = tests.filter((t) => t.ids.includes(id));
  const running = covering.filter((t) => runsIn(t).length > 0);
  const mapped = matchEvidence(id, note.evidence, tests, problems);
  const runtimeStatus = runtimeStatusOf(definitions.has(id), covering, running);
  const byMapping = mapped.length > 0 && (runtimeStatus === '未覆盖' || runtimeStatus === '仅 skip / todo');
  const status = runtimeStatus === '未定义' ? runtimeStatus : (note.status ?? (byMapping ? '已覆盖' : runtimeStatus));
  return {
    id,
    runtimeStatus,
    status,
    category: note.category,
    note: note.note,
    conditional: conditionalProfiles([...running, ...mapped], profiles),
    conditionalTests: running.filter((t) => runsIn(t).length < profiles.length).length,
    tests: running.length,
    skippedOrTodo: covering.length - running.length,
    mapped: mapped.length,
    files: [...new Set([...covering, ...mapped].map((t) => basename(t.file)))].sort(),
    definition: definitions.get(id) ?? null,
    gap: runtimeStatus === '未定义' || (GAP_STATUSES.has(status) && note.status === undefined),
  };
}

function references(tests, definitions, ignore) {
  const unknown = new Map();
  const ignored = new Map();
  for (const test of tests) {
    for (const id of test.ids.filter((x) => !definitions.has(x))) {
      const target = id in ignore ? ignored : unknown;
      if (!target.has(id)) target.set(id, { id, reason: ignore[id], tests: [] });
      target.get(id).tests.push({ file: test.file, title: titleOf(test) });
    }
  }
  const list = (map) => [...map.values()].sort((a, b) => compareIds(a.id, b.id));
  return { unknownReferences: list(unknown), ignoredReferences: list(ignored) };
}

/**
 * 收集阶段的问题：收集错误；只要注册了 .only 一律报 only（含挂在 skip / todo 祖先下、Vitest 不再检查的，
 * only 还会把同文件其他用例压成 skip）；认不出同一个用例的跨档身份报 identity（DEC-282）。
 */
function runtimeProblems(collected) {
  const where = (item) => `（档：${item.profiles.join(' / ')}）`;
  const problems = collected.errors.map((e) => ({
    kind: 'collect',
    message: `收集失败${e.file ? `（${e.file}）` : ''}：${e.message}${where(e)}`,
  }));
  for (const node of collected.onlyNodes ?? []) {
    const title = `${node.names.join(' > ')}（${node.location ?? '未知位置'}）`;
    problems.push({ kind: 'only', message: `${node.file}：${title} 注册了 .only${where(node)}` });
  }
  for (const item of collected.identity ?? []) problems.push({ kind: 'identity', message: item.message });
  return problems;
}

/** DEC-282 ③：人工改判只放行覆盖缺口，不放行 .only。 */
function onlyUnderNotes(entries, notes, tests, problems) {
  for (const [id, note] of Object.entries(notes)) {
    if (note.status === undefined || !entries[id]) continue;
    for (const test of tests.filter((t) => t.only && t.ids.includes(id))) {
      problems.push({ kind: 'only', message: `${id}：人工改判不能放行 .only（${test.file}：${titleOf(test)}）` });
    }
  }
}

// 同一 each 行重复注册等情况会产生内容相同的问题，只保留一条
function uniqueProblems(problems) {
  const seen = new Set();
  return problems.filter((p) => !seen.has(`${p.kind}\u0000${p.message}`) && seen.add(`${p.kind}\u0000${p.message}`));
}

export function summarize(entries) {
  const summary = { total: entries.length, ...Object.fromEntries(STATUSES.map((s) => [s, 0])) };
  for (const entry of entries) summary[entry.status] += 1;
  return summary;
}

export function computeReport({ config, stageNames, collected, definitions, duplicates }) {
  const problems = runtimeProblems(collected);
  const tests = withIds(collected.tests, problems);
  const { groups, notes } = buildScope(config, stageNames, [...definitions.keys()], problems);
  const scopeIds = [...new Set(groups.flatMap((g) => g.ids))];
  validateNotes(notes, new Set(scopeIds), problems);
  const context = { tests, notes, definitions, profiles: collected.profiles, problems };
  const entries = Object.fromEntries(scopeIds.map((id) => [id, buildEntry(id, context)]));
  onlyUnderNotes(entries, notes, tests, problems);
  const gaps = scopeIds.filter((id) => entries[id].gap);
  const refs = references(tests, definitions, config.ignore);
  return {
    stages: stageNames,
    titles: stageNames.map((s) => config.stages.get(s).title ?? s),
    profiles: collected.stats,
    tests,
    groups: groups.map((g) => ({ ...g, summary: summarize(g.ids.map((id) => entries[id])) })),
    entries,
    summary: summarize(Object.values(entries)),
    ...refs,
    duplicateDefinitions: duplicates,
    problems: uniqueProblems(problems),
    gaps,
    ok: problems.length === 0 && refs.unknownReferences.length === 0 && gaps.length === 0,
  };
}
