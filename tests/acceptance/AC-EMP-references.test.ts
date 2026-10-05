import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession, type EmploymentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

interface JobReference {
  readonly id: string;
  readonly revision: number;
}

function jobApi(db: Db, session: EmploymentSession) {
  const api = tenantApi(db, { clock: () => new Date('2026-10-01T01:00:00.000Z') });
  const request = (method: string, path: string, body: unknown, revision: number) =>
    api.request(method, `/api/tenant/job${path}`, {
      user: session.user.id,
      tenant: session.tenant.id,
      ifMatch: revision,
      body,
    });
  return {
    request,
    async create(kind: string, name: string, extra: Record<string, unknown> = {}): Promise<JobReference> {
      const response = await request(
        'POST',
        `/${kind}`,
        { name, code: `REF_${randomUUID().replaceAll('-', '')}`, startDate: '2026-01-01', ...extra },
        0,
      );
      expect(response.status).toBe(201);
      return (await response.json()) as JobReference;
    },
  };
}

async function expectRejectedHire(
  session: EmploymentSession,
  employeeId: string,
  revision: number,
  fields: Record<string, unknown>,
  effectiveDate = '2026-09-01',
) {
  const response = await session.request('POST', `/employees/${employeeId}/businesses`, {
    ifMatch: revision,
    body: { kind: 'hire', mode: 'direct', effectiveDate, fields: { employType: 'internal', ...fields } },
  });
  expect([400, 404]).toContain(response.status);
  expect(await session.records(employeeId)).toEqual([]);
  expect((await session.getEmployee(employeeId)).revision).toBe(revision);
  return response;
}

describe('任职在生效日期验证组织、职务与职位引用', () => {
  it('当前已启用而任职当日尚未生效的组织或职务不可引用，历史生效对象可引用', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'emprefnotyet');
    const jobs = jobApi(db, session);
    const futureOrg = await session.org('当日尚未生效部门');
    const futurePost = await jobs.create('posts', '当日尚未生效职务', { startDate: '2026-10-01' });
    const historicalOrg = await session.org('历史有效部门', { establishedOn: '2026-01-01' });
    const historicalPost = await jobs.create('posts', '历史有效职务');
    const employee = await session.employee('生效日期引用合成员工');
    await expectRejectedHire(session, employee.id, employee.revision, { departmentId: futureOrg.id });
    await expectRejectedHire(session, employee.id, employee.revision, { postId: futurePost.id });
    const hired = await session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { employType: 'internal', departmentId: historicalOrg.id, postId: historicalPost.id },
      },
      employee.revision,
    );
    expect(hired.record!.fields).toMatchObject({ departmentId: historicalOrg.id, postId: historicalPost.id });
  });

  it('DEC-139/150 部门后来停用阻止新增任职；职务仍可引用生效日启用中的历史版本', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'emprefhistorical');
    const jobs = jobApi(db, session);
    const org = await session.org('后来停用部门', { establishedOn: '2026-01-01' });
    const post = await jobs.create('posts', '后来停用职务');
    const rawApi = tenantApi(db);
    const disabledOrg = await rawApi.request('PATCH', `/api/tenant/org/organizations/${org.id}`, {
      user: session.user.id,
      tenant: session.tenant.id,
      ifMatch: org.revision,
      body: { enabled: false, effectiveDate: '2026-10-01' },
    });
    expect(disabledOrg.status).toBe(200);
    const disabledPost = await jobs.request(
      'PATCH',
      `/posts/${post.id}`,
      { enabled: false, effectiveDate: '2026-10-01' },
      post.revision,
    );
    expect(disabledPost.status).toBe(200);
    const employee = await session.employee('历史版本引用合成员工');
    await expectRejectedHire(session, employee.id, employee.revision, { departmentId: org.id, postId: post.id });
    const hired = await session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { employType: 'internal', postId: post.id },
      },
      employee.revision,
    );
    expect(hired.record!.fields).toMatchObject({ departmentId: null, postId: post.id });
  });

  it('不能引用其他租户的组织或职务，失败不创建任职且不泄露引用 ID', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'emprefown');
    const foreign = await employmentSession(db, 'emprefforeign');
    const org = await foreign.org('外租户部门', { establishedOn: '2026-01-01' });
    const post = await jobApi(db, foreign).create('posts', '外租户职务');
    const employee = await session.employee('跨租户引用合成员工');
    for (const fields of [{ departmentId: org.id }, { postId: post.id }]) {
      const response = await expectRejectedHire(session, employee.id, employee.revision, fields);
      const error = await response.json();
      expect(JSON.stringify(error)).not.toContain(org.id);
      expect(JSON.stringify(error)).not.toContain(post.id);
    }
  });

  it('职位必须属于任职部门且对应所选职务，错配被拒绝，正确组合才写入', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'emprefposition');
    const jobs = jobApi(db, session);
    const firstOrg = await session.org('职位归属部门A', { establishedOn: '2026-01-01' });
    const secondOrg = await session.org('职位归属部门B', { establishedOn: '2026-01-01' });
    const firstPost = await jobs.create('posts', '职位对应职务A');
    const secondPost = await jobs.create('posts', '职位对应职务B');
    const position = await jobs.create('positions', '部门A职务A职位', { orgId: firstOrg.id, postId: firstPost.id });
    const employee = await session.employee('职位一致性合成员工');
    await expectRejectedHire(session, employee.id, employee.revision, {
      departmentId: secondOrg.id,
      positionId: position.id,
      postId: firstPost.id,
    });
    await expectRejectedHire(session, employee.id, employee.revision, {
      departmentId: firstOrg.id,
      positionId: position.id,
      postId: secondPost.id,
    });
    const hired = await session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { employType: 'internal', departmentId: firstOrg.id, positionId: position.id, postId: firstPost.id },
      },
      employee.revision,
    );
    expect(hired.record!.fields).toMatchObject({
      departmentId: firstOrg.id,
      positionId: position.id,
      postId: firstPost.id,
    });
  });

  it('服务端任职校验同时满足职务、职位、职级的数值区间交集，不能经接口绕过', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'emprefintersection');
    const jobs = jobApi(db, session);
    const org = await session.org('数值约束部门', { establishedOn: '2026-01-01' });
    const layer = await jobs.create('layers', '数值约束职层', { layerLevel: 1 });
    const grades: JobReference[] = [];
    for (let grade = 1; grade <= 7; grade++)
      grades.push(await jobs.create('grades', `职等${grade}`, { grade, layerId: layer.id }));
    const type = await jobs.create('level-types', '数值约束类别');
    const levels = new Map<number, JobReference>();
    for (const level of [3, 4, 5, 7]) {
      levels.set(
        level,
        await jobs.create('levels', `职级${level}`, {
          level,
          levelTypeId: type.id,
          minGradeId: grades[2]!.id,
          maxGradeId: grades[4]!.id,
        }),
      );
    }
    const post = await jobs.create('posts', '广区间职务', {
      levelTypeId: type.id,
      minLevelId: levels.get(3)!.id,
      maxLevelId: levels.get(7)!.id,
      minGradeId: grades[0]!.id,
      maxGradeId: grades[6]!.id,
    });
    const position = await jobs.create('positions', '窄区间职位', {
      orgId: org.id,
      postId: post.id,
      levelTypeId: type.id,
      minLevelId: levels.get(3)!.id,
      maxLevelId: levels.get(5)!.id,
      minGradeId: grades[3]!.id,
      maxGradeId: grades[5]!.id,
    });
    const employee = await session.employee('数值交集合成员工');
    const fields = { departmentId: org.id, positionId: position.id, postId: post.id };
    for (const selection of [
      { levelId: levels.get(7)!.id, gradeId: grades[3]!.id },
      { levelId: levels.get(4)!.id, gradeId: grades[2]!.id },
      { levelId: levels.get(4)!.id, gradeId: grades[5]!.id },
    ])
      await expectRejectedHire(session, employee.id, employee.revision, { ...fields, ...selection });
    const hired = await session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { employType: 'internal', ...fields, levelId: levels.get(4)!.id, gradeId: grades[3]!.id },
      },
      employee.revision,
    );
    expect(hired.record!.fields).toMatchObject({ ...fields, levelId: levels.get(4)!.id, gradeId: grades[3]!.id });
  });
});
