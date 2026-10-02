import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { jobSession, JOB_TODAY, type JobRecord, type JobSession } from './AC-JOB-support.js';

const testDb = useTestDb();

async function catalog(session: JobSession) {
  const layer = await session.create('layers', '专业职层', { layerLevel: 1 });
  const grades: JobRecord[] = [];
  for (let grade = 1; grade <= 8; grade++) {
    grades.push(await session.create('grades', `职等${grade}`, { grade, layerId: layer.id }));
  }
  const type = await session.create('level-types', '专业职级类别');
  const levels: JobRecord[] = [];
  for (const level of [2, 3, 4, 5, 7]) {
    levels.push(
      await session.create('levels', `P${level}`, {
        level,
        levelTypeId: type.id,
        minGradeId: grades[2]!.id,
        maxGradeId: grades[6]!.id,
      }),
    );
  }
  const postInput = {
    levelTypeId: type.id,
    minLevelId: levels[1]!.id,
    maxLevelId: levels[3]!.id,
    minGradeId: grades[3]!.id,
    maxGradeId: grades[5]!.id,
  };
  return { grades, levels, postInput };
}

describe('AC-JOB-01/02/04/06 职务体系候选、树与职位名称规则', () => {
  it('AC-JOB-01 按级别数值过滤 P3~P5，职等取职务与职级区间交集，服务器拒绝 P7', async () => {
    const session = await jobSession(testDb().db, 'job01');
    const { grades, levels, postInput } = await catalog(session);
    const post = await session.create('posts', '职务X', postInput);
    const candidates = await session.request('GET', `/candidates/levels?postId=${post.id}&asOf=${JOB_TODAY}`);
    expect(candidates.status).toBe(200);
    const { items } = (await candidates.json()) as { items: JobRecord[] };
    expect(items.map((item) => item.level)).toEqual([3, 4, 5]);
    expect(items.map((item) => item.id)).not.toContain(levels[4]!.id);
    const gradeCandidates = await session.request(
      'GET',
      `/candidates/grades?postId=${post.id}&levelId=${levels[2]!.id}&asOf=${JOB_TODAY}`,
    );
    expect(gradeCandidates.status).toBe(200);
    const gradeItems = ((await gradeCandidates.json()) as { items: JobRecord[] }).items;
    expect(gradeItems.map((item) => item.grade)).toEqual([4, 5, 6]);
    const rejected = await session.request('POST', '/validate-assignment', {
      body: { postId: post.id, levelId: levels[4]!.id, gradeId: grades[4]!.id, asOf: JOB_TODAY },
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    const invalidGrade = await session.request('POST', '/validate-assignment', {
      body: { postId: post.id, levelId: levels[2]!.id, gradeId: grades[1]!.id, asOf: JOB_TODAY },
    });
    expect(invalidGrade.status).toBe(400);
    const valid = await session.request('POST', '/validate-assignment', {
      body: { postId: post.id, levelId: levels[2]!.id, gradeId: grades[4]!.id, asOf: JOB_TODAY },
    });
    expect(valid.status).toBe(200);
  });

  it('AC-JOB-02 第三级职务序列自动保留一级、二级、三级祖先 ID', async () => {
    const session = await jobSession(testDb().db, 'job02');
    const first = await session.create('sequences', '一级研发序列');
    const second = await session.create('sequences', '二级软件序列', { parentId: first.id });
    const third = await session.create('sequences', '三级后端序列', { parentId: second.id });
    expect(third).toMatchObject({
      level: 3,
      firstSequenceId: first.id,
      secondSequenceId: second.id,
      thirdSequenceId: third.id,
    });
    expect(await session.detail('sequences', third.id)).toMatchObject({
      firstSequenceId: first.id,
      secondSequenceId: second.id,
      thirdSequenceId: third.id,
    });
  });

  it('AC-JOB-04 未来设立日期只作记录而可选，未来生效日期在生效前不可选', async () => {
    const session = await jobSession(testDb().db, 'job04');
    const { grades, levels, postInput } = await catalog(session);
    const establishedLater = await session.create('posts', '未来设立的职务', {
      ...postInput,
      establishedOn: '2026-10-15',
    });
    const effectiveLater = await session.create('posts', '未来生效的职务', {
      ...postInput,
      startDate: '2026-10-15',
    });
    const available = await session.list('posts');
    expect(available.map((post) => post.id)).toContain(establishedLater.id);
    expect(available.map((post) => post.id)).not.toContain(effectiveLater.id);
    const valid = await session.request('POST', '/validate-assignment', {
      body: { postId: establishedLater.id, levelId: levels[2]!.id, gradeId: grades[4]!.id, asOf: JOB_TODAY },
    });
    expect(valid.status).toBe(200);
    const future = await session.request('POST', '/validate-assignment', {
      body: { postId: effectiveLater.id, levelId: levels[2]!.id, gradeId: grades[4]!.id, asOf: JOB_TODAY },
    });
    expect([400, 404]).toContain(future.status);
    const asOfFuture = await session.list('posts', { asOf: '2026-10-15' });
    expect(asOfFuture.map((post) => post.id)).toContain(effectiveLater.id);
  });

  it('AC-JOB-06 出厂开关关闭时同部门启用职位禁止重名，跨部门允许；打开后同部门允许', async () => {
    const session = await jobSession(testDb().db, 'job06');
    const departmentA = await session.org('研发部门A');
    const departmentB = await session.org('研发部门B');
    const post = await session.create('posts', '研发职务');
    const settings = await session.request('GET', '/settings');
    expect(settings.status).toBe(200);
    expect(await settings.json()).toMatchObject({ allowDuplicatePositionNames: false, revision: 0 });
    await session.create('positions', '研发工程师', { orgId: departmentA.id, postId: post.id });
    const duplicate = await session.request('POST', '/positions', {
      ifMatch: 0,
      body: { name: '研发工程师', code: 'POS_DUPLICATE', orgId: departmentA.id, postId: post.id },
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    await session.create('positions', '研发工程师', { orgId: departmentB.id, postId: post.id });
    const enabled = await session.request('PUT', '/settings', {
      ifMatch: 0,
      body: { allowDuplicatePositionNames: true, adjustEmployeeDirectManager: false },
    });
    expect(enabled.status).toBe(200);
    await session.create('positions', '研发工程师', { orgId: departmentA.id, postId: post.id });
    expect((await session.list('positions')).filter((position) => position.orgId === departmentA.id)).toHaveLength(2);
  });
});
