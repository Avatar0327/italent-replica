import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { jobSession, JOB_TODAY, type JobRecord } from './AC-JOB-support.js';

const testDb = useTestDb();

describe('AC-JOB-01 任职服务端校验与候选条件一致', () => {
  it('职务未设置级别边界时，无数值职级仍不可在任职接口中绕过候选限制', async () => {
    const session = await jobSession(testDb().db, 'jobassignmentnulllevel');
    const type = await session.create('level-types', '无数值测试类别');
    const level = await session.create('levels', '无数值职级', { level: null, levelTypeId: type.id });
    const post = await session.create('posts', '无界职级职务', { levelTypeId: type.id });
    const candidates = await session.request('GET', `/candidates/levels?postId=${post.id}&asOf=${JOB_TODAY}`);
    expect(candidates.status).toBe(200);
    expect(((await candidates.json()) as { items: JobRecord[] }).items.map((item) => item.id)).not.toContain(level.id);
    const validation = await session.request('POST', '/validate-assignment', {
      body: { postId: post.id, levelId: level.id, asOf: JOB_TODAY },
    });
    expect(validation.status).toBe(400);
    expect(await validation.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('职务未设置职等边界时，无数值职等仍不可在任职接口中绕过候选限制', async () => {
    const session = await jobSession(testDb().db, 'jobassignmentnullgrade');
    const grade = await session.create('grades', '无数值职等', { grade: null });
    const post = await session.create('posts', '无界职等职务');
    const candidates = await session.request('GET', `/candidates/grades?postId=${post.id}&asOf=${JOB_TODAY}`);
    expect(candidates.status).toBe(200);
    expect(((await candidates.json()) as { items: JobRecord[] }).items.map((item) => item.id)).not.toContain(grade.id);
    const validation = await session.request('POST', '/validate-assignment', {
      body: { postId: post.id, gradeId: grade.id, asOf: JOB_TODAY },
    });
    expect(validation.status).toBe(400);
    expect(await validation.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('职务引用的职级类别已停用时，候选与任职接口都拒绝该时点的选择', async () => {
    const session = await jobSession(testDb().db, 'jobassignmentdisabledtype');
    const type = await session.create('level-types', '停用类别');
    const level = await session.create('levels', '类别下三级', { level: 3, levelTypeId: type.id });
    const post = await session.create('posts', '类别约束职务', { levelTypeId: type.id });
    const disabled = await session.request('PATCH', `/level-types/${type.id}`, {
      ifMatch: type.revision,
      body: { enabled: false, effectiveDate: '2026-10-02' },
    });
    expect(disabled.status).toBe(200);
    const candidates = await session.request('GET', `/candidates/levels?postId=${post.id}&asOf=2026-10-02`);
    expect(candidates.status).toBe(400);
    const validation = await session.request('POST', '/validate-assignment', {
      body: { postId: post.id, levelId: level.id, asOf: '2026-10-02' },
    });
    expect(validation.status).toBe(400);
    expect(await validation.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });
});
