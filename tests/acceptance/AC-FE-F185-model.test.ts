import { describe, expect, it } from 'vitest';
import { INFO, projectInfo } from '../../apps/web/src/idp/info-model.js';
import { changedFields, refillDraft } from '../../apps/web/src/foundation/forms/values.js';

const targets = { targetProfessionalLineId: 'line', targetLevelId: 'level', targetPostId: 'post' };
describe('AC-FE-F185 职业发展字段投影', () => {
  it('AC-FE-F185-01 三目标进入提交投影，系统快照永不进入', () => {
    const projected = projectInfo('careers', {
      ...targets,
      currentLevelId: 'old-level',
      currentPositionId: 'old-position',
      currentPostId: 'old-post',
      currentPostName: '合成快照职务',
    });
    expect(projected).toMatchObject(targets);
    expect(Object.keys(projected).filter((key) => key.startsWith('current'))).toEqual([]);
    expect(INFO.careers.fields.filter((f) => Object.hasOwn(targets, f.name)).every((f) => !f.required)).toBe(true);
  });
  it('AC-FE-F185-02 清空与冲突回填沿用内核，未改 / 不可提交项取最新', () => {
    const baseline = projectInfo('careers', targets);
    const draft = { ...baseline, targetProfessionalLineId: null, targetLevelId: 'mine' };
    const latest = projectInfo('careers', { ...targets, targetLevelId: 'server', targetPostId: 'new-post' });
    const fields = INFO.careers.fields.map((f) => f.name);
    const result = refillDraft({
      values: draft,
      latest,
      edited: changedFields(draft, baseline, fields),
      submittable: ['targetProfessionalLineId', 'targetPostId'],
    });
    expect(result).toMatchObject({ targetProfessionalLineId: null, targetLevelId: 'server', targetPostId: 'new-post' });
  });
});
