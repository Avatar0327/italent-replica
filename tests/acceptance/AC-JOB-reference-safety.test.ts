import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { jobSession, JOB_TODAY } from './AC-JOB-support.js';

const testDb = useTestDb();

describe('AC-JOB-01/04 约束引用的租户、时间与数值一致性', () => {
  it('职级不能引用他租户、已失效或尚未生效的职级类别', async () => {
    const { db } = testDb();
    const session = await jobSession(db, 'jobrefown');
    const foreign = await jobSession(db, 'jobrefforeign');
    const foreignType = await foreign.create('level-types', '外租户类别');
    const expired = await session.create('level-types', '已失效类别', {
      startDate: '2026-09-01',
      stopDate: '2026-09-30',
    });
    const future = await session.create('level-types', '未来类别', { startDate: '2026-11-01' });
    for (const type of [foreignType, expired, future]) {
      const response = await session.request('POST', '/levels', {
        ifMatch: 0,
        body: { name: '不得建立的职级', code: `L${randomUUID().replaceAll('-', '')}`, level: 3, levelTypeId: type.id },
      });
      expect([400, 404]).toContain(response.status);
    }
    expect(await session.list('levels')).toEqual([]);
  });

  it('职级区间不能使用外租户职等，职务区间不能混用不同职级类别', async () => {
    const { db } = testDb();
    const session = await jobSession(db, 'jobrangeref');
    const foreign = await jobSession(db, 'jobrangeforeign');
    const ownLayer = await session.create('layers', '本租户职层', { layerLevel: 1 });
    const foreignLayer = await foreign.create('layers', '外租户职层', { layerLevel: 1 });
    const ownGrade = await session.create('grades', '本租户职等', { grade: 5, layerId: ownLayer.id });
    const foreignGrade = await foreign.create('grades', '外租户职等', { grade: 3, layerId: foreignLayer.id });
    const firstType = await session.create('level-types', '专业类别');
    const secondType = await session.create('level-types', '管理类别');
    const badGrades = await session.request('POST', '/levels', {
      ifMatch: 0,
      body: {
        name: '混租户职等职级',
        code: 'INVALID_GRADE_REFERENCE',
        level: 3,
        levelTypeId: firstType.id,
        minGradeId: foreignGrade.id,
        maxGradeId: ownGrade.id,
      },
    });
    expect([400, 404]).toContain(badGrades.status);
    const firstLevel = await session.create('levels', '专业三级', { level: 3, levelTypeId: firstType.id });
    const secondLevel = await session.create('levels', '管理五级', { level: 5, levelTypeId: secondType.id });
    const badTypes = await session.request('POST', '/posts', {
      ifMatch: 0,
      body: {
        name: '混职级类别职务',
        code: 'INVALID_LEVEL_TYPE_REFERENCE',
        levelTypeId: firstType.id,
        minLevelId: firstLevel.id,
        maxLevelId: secondLevel.id,
      },
    });
    expect(badTypes.status).toBe(400);
    expect(await session.list('posts')).toEqual([]);
  });

  it('上下界按级别数值比较，倒置区间不能保存，跨租户候选查询不能泄露引用', async () => {
    const { db } = testDb();
    const session = await jobSession(db, 'jobrangeorder');
    const foreign = await jobSession(db, 'jobrangecandidates');
    const type = await session.create('level-types', '数值类别');
    const lower = await session.create('levels', '三级', { level: 3, levelTypeId: type.id });
    const upper = await session.create('levels', '七级', { level: 7, levelTypeId: type.id });
    const reversed = await session.request('POST', '/posts', {
      ifMatch: 0,
      body: {
        name: '倒置职务',
        code: 'REVERSED_RANGE',
        levelTypeId: type.id,
        minLevelId: upper.id,
        maxLevelId: lower.id,
      },
    });
    expect(reversed.status).toBe(400);
    const post = await session.create('posts', '合法区间职务', {
      levelTypeId: type.id,
      minLevelId: lower.id,
      maxLevelId: upper.id,
    });
    const foreignType = await foreign.create('level-types', '外部数值类别');
    const foreignLevel = await foreign.create('levels', '外部职级', { level: 5, levelTypeId: foreignType.id });
    const response = await session.request(
      'GET',
      `/candidates/grades?postId=${post.id}&levelId=${foreignLevel.id}&asOf=${JOB_TODAY}`,
    );
    expect([400, 404]).toContain(response.status);
    expect(JSON.stringify(await response.json())).not.toContain(foreignLevel.id);
  });
});
