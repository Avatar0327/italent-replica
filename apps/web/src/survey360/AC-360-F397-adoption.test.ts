import { expect, it } from 'vitest';
import { isLocked, type Submission, type Values } from '../foundation/forms/store.js';
import { adoptSheet, answerState, fields, leaveGuarded, restored } from './portal-adoption.js';
import { sheetValues, type AnswerPage, type Sheet } from './portal-client.js';

// 第 5 轮“状态采用决策表”规则 ①～④ 的纯函数核对：除逐格场景外，按状态维度全组合枚举，断言规则作为不变式成立，
// 防止决策表之外的组合漏掉（DEC-385③ 第 ② 问）。
const pageOf = (sheet: Partial<Sheet>, activity = 'enabled'): AnswerPage => ({
  activity: { name: '合成活动', status: activity },
  object: { name: '合成对象' },
  questionnaire: { id: 'questionnaire', name: '合成套卷', type: 'key_behavior', guide: null, items: [] },
  sheet: { status: 'draft', revision: 3, answers: [], suggestion: null, ...sheet },
});
const live: Values = { answers: [{ itemId: 'item', optionId: 'mine', remark: '' }], suggestion: '合成本页建议' };
const serverAnswers = [{ itemId: 'item', optionId: 'theirs', remark: '' }];
const statuses = ['pending', 'draft', 'submitted'] as const;
const keeps = [[], ['answers'], ['suggestion'], fields];

it('AC-360-F397 规则①：历史回执 revision 更低时不降基线、不改页面答卷，只报告未推进', () => {
  const confirmed = pageOf({ revision: 2, suggestion: '合成他页建议' });
  const result = adoptSheet({ confirmed, next: pageOf({ revision: 1 }), live, keep: fields });
  expect(result).toEqual({ advanced: false, page: confirmed, live });
  expect(result.live).toBe(live);
});

it('AC-360-F397 规则①：已读到 submitted 后，同 revision 或更高的草稿回执都不退回草稿', () => {
  const confirmed = pageOf({ status: 'submitted', revision: 2 });
  for (const revision of [2, 3])
    expect(adoptSheet({ confirmed, next: pageOf({ revision }), live, keep: [] }).page).toBe(confirmed);
  expect(adoptSheet({ confirmed, next: pageOf({ status: 'submitted', revision: 2 }), live, keep: [] }).advanced).toBe(
    true,
  );
});

it('AC-360-F397 规则①：全组合枚举——基线 revision 单调、submitted 不退回，推进时 keep 字段取页面值、其余取服务端', () => {
  for (const from of statuses)
    for (const to of statuses)
      for (const revision of [2, 3, 4])
        for (const keep of keeps) {
          const confirmed = pageOf({ status: from, revision: 3 });
          const next = pageOf({ status: to, revision, answers: serverAnswers, suggestion: '合成服务端建议' });
          const result = adoptSheet({ confirmed, next, live, keep });
          const label = `${from}→${to} r3→r${revision} keep=${keep.join('+')}`;
          expect(result.advanced, label).toBe(revision >= 3 && (from !== 'submitted' || to === 'submitted'));
          expect(result.page.sheet.revision, label).toBeGreaterThanOrEqual(3);
          if (from === 'submitted') expect(result.page.sheet.status, label).toBe('submitted');
          if (!result.advanced) expect([result.page, result.live], label).toEqual([confirmed, live]);
          else
            for (const field of fields)
              expect(result.live[field], `${label} ${field}`).toEqual(
                keep.includes(field) ? live[field] : sheetValues(next.sheet)[field as 'answers' | 'suggestion'],
              );
        }
});

const slot = (status: Submission['status'], operation: 'save' | 'submit' = 'save'): Submission => ({
  status,
  values: live,
  baseline: {},
  editableFields: fields,
  editedFields: ['answers'],
  revision: 3,
  context: { operation },
});
const slotStatuses = ['idle', 'submitting', 'rejected', 'unknown', 'conflict', 'done'] as const;

it('AC-360-F397 规则④：只有未确认命令的槽恢复命令改过的字段，其余字段与已确认的槽都以 GET 为准', () => {
  const sheet = pageOf({ answers: serverAnswers, suggestion: '合成服务端建议' }).sheet;
  expect(restored(sheet, undefined)).toEqual(sheetValues(sheet));
  for (const status of slotStatuses) {
    const state = slot(status);
    const expected = isLocked(state) ? { ...sheetValues(sheet), answers: live.answers } : sheetValues(sheet);
    expect(restored(sheet, state), status).toEqual(expected);
  }
});

const views = [
  ['draft', 'enabled'],
  ['draft', 'disabled'],
  ['submitted', 'enabled'],
] as const;
const combos = [undefined, ...slotStatuses].flatMap((status) =>
  (['save', 'submit'] as const).flatMap((operation) =>
    [false, true].flatMap((edited) =>
      [false, true].flatMap((differ) =>
        [false, true].flatMap((held) =>
          views.map(([sheet, activity]) => ({ status, operation, edited, differ, held, sheet, activity })),
        ),
      ),
    ),
  ),
);
it('AC-360-F397 规则②③：全组合枚举——dirty 按编辑事件或值不同，离开守卫 = dirty 或未确认命令，自动保存只在可写时', () => {
  const same = sheetValues(pageOf({}).sheet);
  expect(combos).toHaveLength(7 * 2 * 2 * 2 * 2 * 3);
  for (const { status, operation, edited, differ, held, sheet, activity } of combos) {
    const state = status && slot(status, operation);
    const marks = { edits: new Set(edited ? ['suggestion'] : []), held };
    const result = answerState(state, pageOf({ status: sheet }, activity), differ ? live : same, marks);
    const label = JSON.stringify({ status, operation, edited, differ, held, sheet, activity });
    expect(result.dirty, label).toBe(edited || differ);
    expect(result.locked, label).toBe(isLocked(state));
    expect(leaveGuarded(result), label).toBe(result.dirty || result.locked);
    const writable = activity === 'enabled' && sheet !== 'submitted';
    const settled = !status || !['submitting', 'unknown', 'conflict'].includes(status);
    // 被拒的同一份草稿（槽里的命令值 = 页面值）不自动重发。
    const refused = status === 'rejected' && operation === 'save' && differ;
    expect(result.savable, label).toBe(result.dirty && !held && writable && settled && !refused);
    const saving = status === 'submitting' && operation === 'save';
    expect(result.readonly, label).toBe(!writable || (!settled && !saving));
  }
});
