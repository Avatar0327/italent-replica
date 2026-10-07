// 覆盖统计：只用运行时收集到的用例（标题层级 + 各档状态），不读测试源码。
// - 一个用例覆盖的编号 = 各级 describe 标题与自身标题逐段提取后的并集（R1 报告 §3 口径）。
// - 运行时状态：已覆盖（某一档为 run）、仅 skip / todo、未覆盖、未定义（定义来源里找不到）。
// - 人工层（阶段配置 notes）：status 改判为部分覆盖 / 未覆盖（须写分类与原因）；evidence 按完整标题指认用例，
//   找不到或未运行即列为问题。最终状态与运行时状态并列输出。
// - 缺口：范围内最终状态为未覆盖 / 仅 skip / todo 且没有人工改判的编号，以及范围内未定义的编号。
import { basename } from 'node:path';
import { compareIds, expandScopeToken, extractIds } from './ids.mjs';

export const STATUSES = ['已覆盖', '部分覆盖', '未覆盖', '仅 skip / todo', '未定义'];
const GAP_STATUSES = new Set(['未覆盖', '仅 skip / todo', '未定义']);
const MANUAL_STATUSES = new Set(['部分覆盖', '未覆盖']);

const runsIn = (test) => Object.keys(test.modes).filter((p) => test.modes[p] === 'run');
const titleOf = (test) => test.names.join(' > ');

function withIds(tests) {
  return tests.map((test) => ({ ...test, ids: [...new Set(test.names.flatMap(extractIds))].sort(compareIds) }));
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
        else problems.push({ kind: 'config', message: `${stage}：范围写法无法识别「${token}」` });
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

function matchEvidence(id, evidence, tests, problems) {
  const matched = [];
  for (const item of evidence ?? []) {
    const hits = tests.filter(
      (t) => basename(t.file) === item.file && (t.names.at(-1) === item.title || titleOf(t) === item.title),
    );
    const running = hits.filter((t) => runsIn(t).length > 0);
    if (running.length) matched.push(...running);
    else
      problems.push({ kind: 'evidence', message: `${id}：人工映射找不到运行的用例「${item.file} / ${item.title}」` });
  }
  return matched;
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

// .only 会让同文件其他用例被标为 skip；收集按 allowOnly: false 进行，Vitest 把它记为该用例的收集失败。
function runtimeProblems(collected) {
  return collected.errors.map((e) => ({
    kind: e.message.includes('.only') ? 'only' : 'collect',
    message: `收集失败${e.file ? `（${e.file}）` : ''}：${e.message}（档：${e.profiles.join(' / ')}）`,
  }));
}

export function summarize(entries) {
  const summary = { total: entries.length, ...Object.fromEntries(STATUSES.map((s) => [s, 0])) };
  for (const entry of entries) summary[entry.status] += 1;
  return summary;
}

export function computeReport({ config, stageNames, collected, definitions, duplicates }) {
  const problems = runtimeProblems(collected);
  const tests = withIds(collected.tests);
  const { groups, notes } = buildScope(config, stageNames, [...definitions.keys()], problems);
  const scopeIds = [...new Set(groups.flatMap((g) => g.ids))];
  validateNotes(notes, new Set(scopeIds), problems);
  const context = { tests, notes, definitions, profiles: collected.profiles, problems };
  const entries = Object.fromEntries(scopeIds.map((id) => [id, buildEntry(id, context)]));
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
    problems,
    gaps,
    ok: problems.length === 0 && refs.unknownReferences.length === 0 && gaps.length === 0,
  };
}
