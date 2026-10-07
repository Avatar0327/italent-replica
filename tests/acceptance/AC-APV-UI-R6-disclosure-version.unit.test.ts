/** DEC-288 ④：字段集合版本与日志字段名收缩判定（纯函数）。 */
import { describe, expect, it } from 'vitest';
import { disclosureVersion, knownLogFields, logFieldsShrank } from '../../apps/web/src/approval/disclosure.js';
import type { ApprovalDetail, ApprovalLog } from '../../apps/web/src/approval/types.js';

function detail(overrides: Partial<ApprovalDetail> = {}): ApprovalDetail {
  return {
    id: 'instance',
    title: '合成',
    status: 'running',
    revision: 7,
    currentNodeKey: 'manager',
    taskId: null,
    retrieveTaskId: null,
    tasks: [],
    logs: [{ id: 'edit-1', event: 'edit', detail: { fields: ['place', 'reason'] } }],
    recordsHidden: false,
    commentNotice: '',
    form: { values: { place: '合成', reason: '合成', nested: { number: '1' } }, editMode: 'none', editableFields: [] },
    actions: [],
    ...overrides,
  };
}
const log = (id: string, fields: readonly string[] | undefined): ApprovalLog => ({
  id,
  event: 'edit',
  detail: fields ? { fields } : {},
});

describe('disclosureVersion', () => {
  it('revision、状态、动作变化不改变版本；字段、编辑元数据、日志字段名、隐藏标志变化即改变', () => {
    const base = disclosureVersion(detail());
    expect(disclosureVersion(detail({ revision: 8, status: 'approved', actions: ['approve'] }))).toBe(base);
    expect(
      disclosureVersion(detail({ form: { values: { reason: '合成' }, editMode: 'none', editableFields: [] } })),
    ).not.toBe(base);
    expect(disclosureVersion(detail({ form: { ...detail().form, editableFields: ['place'] } }))).not.toBe(base);
    expect(disclosureVersion(detail({ logs: [log('edit-1', ['place'])] }))).not.toBe(base);
    expect(disclosureVersion(detail({ recordsHidden: true }))).not.toBe(base);
    expect(
      disclosureVersion(
        detail({
          form: {
            values: { place: '合成', reason: '合成', nested: { number: '2' } },
            editMode: 'none',
            editableFields: [],
          },
        }),
      ),
    ).toBe(base);
  });
});

describe('logFieldsShrank', () => {
  it('同一日志字段名减少才算收紧；新增、无字段或未知日志不算', () => {
    const known = knownLogFields(detail(), [log('edit-2', ['place'])]);
    expect(logFieldsShrank(known, [log('edit-1', ['place'])])).toBe(true);
    expect(logFieldsShrank(known, [log('edit-2', [])])).toBe(true);
    expect(logFieldsShrank(known, [log('edit-1', ['reason', 'place', 'extra'])])).toBe(false);
    expect(logFieldsShrank(known, [log('edit-9', [])])).toBe(false);
    expect(logFieldsShrank(known, [log('edit-1', undefined)])).toBe(false);
    expect(logFieldsShrank(known, [{ seq: 3, event: 'approve', detail: {} }])).toBe(false);
  });
});
