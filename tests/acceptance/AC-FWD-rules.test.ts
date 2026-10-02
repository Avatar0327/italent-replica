import { describe, expect, it } from 'vitest';
import { applyForwardChanges, matchingForwardChanges } from '../../apps/api/src/modules/employment/forward-rules.js';
import { emptyPresetFields } from '../../apps/api/src/modules/employment/types.js';

describe('AC-FWD-05/06 值匹配核心组合', () => {
  it.each([
    { departmentMatches: true, positionMatches: true },
    { departmentMatches: true, positionMatches: false },
    { departmentMatches: false, positionMatches: true },
    { departmentMatches: false, positionMatches: false },
  ])('DEC-078 部门匹配=$departmentMatches 职位匹配=$positionMatches 按记录级联合判定', (combination) => {
    const before = {
      fields: {
        ...emptyPresetFields(),
        departmentId: 'old-department',
        positionId: 'old-position',
        place: 'old-place',
      },
      customFields: {},
    };
    const after = {
      fields: { ...before.fields, departmentId: 'new-department', positionId: 'new-position', place: 'new-place' },
      customFields: {},
    };
    const target = {
      fields: {
        ...before.fields,
        departmentId: combination.departmentMatches ? 'old-department' : 'independent-department',
        positionId: combination.positionMatches ? 'old-position' : 'independent-position',
      },
      customFields: {},
    };
    const changes = matchingForwardChanges(before, after, target, []);
    const bothMatch = combination.departmentMatches && combination.positionMatches;
    expect(changes.map((change) => change.field)).toEqual(bothMatch ? ['departmentId', 'positionId', 'place'] : []);
    expect(applyForwardChanges(target, changes).fields).toMatchObject({
      departmentId: bothMatch ? 'new-department' : target.fields.departmentId,
      positionId: bothMatch ? 'new-position' : target.fields.positionId,
      place: bothMatch ? 'new-place' : 'old-place',
    });
    expect(target.fields.place).toBe('old-place');
  });

  it('AC-FWD-06 显式序列变更匹配替换，后续独立序列不被同一职务变更覆盖', () => {
    const before = {
      fields: { ...emptyPresetFields(), postId: 'old-post', sequenceId: 'old-sequence' },
      customFields: {},
    };
    const after = { fields: { ...before.fields, postId: 'new-post', sequenceId: 'new-sequence' }, customFields: {} };
    expect(matchingForwardChanges(before, after, before, [])).toEqual([
      { field: 'postId', before: 'old-post', after: 'new-post' },
      { field: 'sequenceId', before: 'old-sequence', after: 'new-sequence' },
    ]);
    const independent = { fields: { ...before.fields, sequenceId: 'independent-sequence' }, customFields: {} };
    expect(matchingForwardChanges(before, after, independent, [])).toEqual([
      { field: 'postId', before: 'old-post', after: 'new-post' },
    ]);
  });
});
