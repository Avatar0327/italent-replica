/**
 * BE-15b1 第 1 轮审查返工（#415），全部走真实授权器（tenantApi authorize: undefined），不用“看全部”替身：
 * - P1-1（DEC-455）：撤销考核权限后，原发起人不能经审批中心 /instances/:id/resubmit 重提并修改考核——重提与发起 / 修改
 *   共用同一个检查入口（创建权限、按钮、字段权限、考核数据范围），在命令事务内复核（首次与同键重放）；撤权 403、范围外 404，
 *   考核记录、审批轮次与业务审计都不变；
 * - P2-1：考核对象登记人员范围，正常的部门授权（org_range）可以办理；范围外与不存在同为 404；空范围；列表 / 详情 / 修改；
 *   撤权后重放；
 * - P2-2（DEC-415）：模块预置管理员（标准版系统管理员、人事管理员）预置考核对象的“看全部”，人事专员不预置。
 */
import { randomUUID } from 'node:crypto';
import { grantMembership, sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS, presetSeeAllTargets, SEE_ALL_BACKFILL_APPROVED, STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { assessmentWorld, type AssessmentView, type LaunchReceipt } from './AC-PB-BE15b1-support.js';
import { realOperator } from './AC-PB-BE15b1-real-support.js';
import { withLoginEmail } from './AC-EMP-support.js';
import { newUser, provisioned, seedOperator } from './support/platform-api.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
const MISSING = '00000000-0000-4000-8000-000000000001';

async function launchBody(w: Awaited<ReturnType<typeof assessmentWorld>>, employeeIds: readonly string[]) {
  const items = [];
  for (const employeeId of employeeIds) items.push({ employeeId, revision: await w.employeeRevision(employeeId) });
  return { assessmentType: 'probation', assessmentName: '真实授权考核', assessmentDate: '2026-10-01', items };
}

async function auditCount(w: Awaited<ReturnType<typeof assessmentWorld>>, id: string) {
  const [row] = await withTenant(w.db, w.tenant.id, async (tx) =>
    rows<{ n: number }>(
      await tx.execute(sql`SELECT count(*)::int AS n FROM audit_events
        WHERE tenant_id=${w.tenant.id} AND object_id=${id}`),
    ),
  );
  return row!.n;
}

async function state(w: Awaited<ReturnType<typeof assessmentWorld>>, id: string) {
  const [row] = await withTenant(w.db, w.tenant.id, async (tx) =>
    rows<{ status: string; revision: number; opinion: string | null; instance: string; round: number }>(
      await tx.execute(sql`SELECT a.status, a.revision::int AS revision, a.regularization_opinion AS opinion,
          i.status AS instance, i.round::int AS round
        FROM employment_probation_assessments a
        JOIN approval_instances i ON i.tenant_id=a.tenant_id AND i.business_type='probation_assessment'
          AND i.business_id=a.id
        WHERE a.tenant_id=${w.tenant.id} AND a.id=${id}::uuid`),
    ),
  );
  return { ...row!, audits: await auditCount(w, id) };
}

describe('P1-1 撤权后重提考核（DEC-455）', () => {
  async function rejected(label: string) {
    const w = await assessmentWorld(testDb().db, `r2-resubmit-${label}`);
    const person = await w.probationer('重提员工');
    const op = await realOperator(w, { orgIds: [w.department] });
    w.asInitiator(op.userId);
    const launched = await op.call('POST', '/probation-assessments', {
      body: await launchBody(w, [person.employeeId]),
    });
    expect(launched.status, await launched.clone().text()).toBe(200);
    const receipt = (await launched.json()) as LaunchReceipt;
    expect(receipt.items[0], JSON.stringify(receipt)).toMatchObject({ status: 'succeeded' });
    const id = receipt.items[0]!.assessmentId!;
    await w.decide(id, person, 'approve', { selfEvaluation: '自评' });
    await w.decide(id, w.manager, 'reject');
    expect((await w.get(id)).status).toBe('rejected');
    const view = await w.instance(id);
    const resubmit = (key?: string) =>
      op.call('POST', `/api/tenant/approval/instances/${view.id}/resubmit`, {
        ifMatch: view.revision,
        body: {
          fields: { managerRating: 'exceeds', regularizationOpinion: 'early', regularizationDate: '2026-10-15' },
        },
        ...(key ? { key } : {}),
      });
    return { w, op, id, view, resubmit };
  }

  it('撤销考核权限后重提 403，考核记录、审批轮次与业务审计都不变', async () => {
    const { w, op, id, resubmit } = await rejected('revoke');
    const before = await state(w, id);
    expect(before).toMatchObject({ status: 'rejected', instance: 'returned' });
    await op.revokePermission();
    // 普通发起已被拒；审批中心重提同样必须被拒
    const again = await op.call('POST', '/probation-assessments', { body: await launchBody(w, [MISSING]) });
    expect(again.status).toBe(403);
    const denied = await resubmit();
    expect(denied.status, await denied.clone().text()).toBe(403);
    expect(await state(w, id)).toEqual(before);
  });

  it('考核对象移出操作人的数据范围后重提 404（与考核不存在同一个 404），状态都不变', async () => {
    const { w, op, id, resubmit } = await rejected('scope');
    const before = await state(w, id);
    const other = await w.org('另一部门');
    await op.setScope([other]);
    const denied = await resubmit();
    expect(denied.status, await denied.clone().text()).toBe(404);
    expect(await state(w, id)).toEqual(before);
  });

  it('同键重放：首次重提成功后撤权，重放同样被拒（事务内复核覆盖重放）', async () => {
    const { w, op, id, resubmit } = await rejected('replay');
    const key = `resubmit-${id}`;
    const first = await resubmit(key);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await state(w, id)).toMatchObject({ status: 'in_review', opinion: 'early' });
    await op.revokePermission();
    const replay = await resubmit(key);
    expect(replay.status, await replay.clone().text()).toBe(403);
  });

  it('权限与范围都在：重提照常成功', async () => {
    const { w, id, resubmit } = await rejected('ok');
    const ok = await resubmit();
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await state(w, id)).toMatchObject({ status: 'in_review', opinion: 'early', instance: 'running' });
  });
});

describe('P2-1 考核对象的人员范围（真实授权器，正常部门授权）', () => {
  it('org_range 覆盖员工部门：发起、列表、详情、审批通过后修改都能办理', async () => {
    const w = await assessmentWorld(testDb().db, 'r2-scope-ok');
    const person = await w.probationer('范围内员工');
    const op = await realOperator(w, { orgIds: [w.department] });
    w.asInitiator(op.userId);
    const launched = await op.call('POST', '/probation-assessments', {
      body: await launchBody(w, [person.employeeId]),
    });
    expect(launched.status, await launched.clone().text()).toBe(200);
    const receipt = (await launched.json()) as LaunchReceipt;
    expect(receipt.items[0], JSON.stringify(receipt)).toMatchObject({ status: 'succeeded' });
    const id = receipt.items[0]!.assessmentId!;

    const listed = await op.call('GET', '/probation-assessments');
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect(((await listed.json()) as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([id]);
    const detail = await op.call('GET', `/probation-assessments/${id}`);
    expect(detail.status, await detail.clone().text()).toBe(200);

    await w.complete(id, person, { managerRating: 'meets', regularizationOpinion: 'normal' });
    const approved = (await (await op.call('GET', `/probation-assessments/${id}`)).json()) as AssessmentView;
    const patched = await op.call('PATCH', `/probation-assessments/${id}`, {
      ifMatch: approved.revision,
      body: { managerRating: 'exceeds' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect(await patched.json()).toMatchObject({ managerRating: 'exceeds' });
  });

  it('范围外：发起只在本人回执里 404；详情 / 修改与不存在同为 404；列表不含；撤权重放被拒', async () => {
    const w = await assessmentWorld(testDb().db, 'r2-scope-out');
    const inside = await w.probationer('范围内');
    const otherDepartment = await w.org('范围外部门');
    const outside = await w.probationer('范围外', { department: otherDepartment });
    const outsideId = await w.launch('probation', outside);
    const op = await realOperator(w, { orgIds: [w.department] });
    w.asInitiator(op.userId);

    const key = `launch-${inside.employeeId}`;
    const body = await launchBody(w, [inside.employeeId, outside.employeeId]);
    const first = await op.call('POST', '/probation-assessments', { body, key });
    expect(first.status, await first.clone().text()).toBe(200);
    const receipt = (await first.json()) as LaunchReceipt;
    expect(receipt.items.map((item) => [item.status, item.error?.code])).toEqual([
      ['succeeded', undefined],
      ['failed', 'NOT_FOUND'],
    ]);

    const hidden = await op.call('GET', `/probation-assessments/${outsideId}`);
    const missing = await op.call('GET', `/probation-assessments/${MISSING}`);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
    const patch = await op.call('PATCH', `/probation-assessments/${outsideId}`, {
      ifMatch: 1,
      body: { managerRating: 'meets' },
    });
    expect(patch.status).toBe(404);
    const listed = await op.call('GET', '/probation-assessments');
    expect(((await listed.json()) as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([
      receipt.items[0]!.assessmentId,
    ]);

    await op.setScope(null);
    const replay = await op.call('POST', '/probation-assessments', { body, key });
    expect([403, 404]).toContain(replay.status);
    expect(await replay.clone().text()).not.toContain(inside.employeeId);
  });

  it('空范围（没有任何数据范围）：列表为空、详情 404、发起只在本人回执里 404，不写入', async () => {
    const w = await assessmentWorld(testDb().db, 'r2-scope-empty');
    const person = await w.probationer('空范围员工');
    const id = await w.launch('probation', person);
    const op = await realOperator(w);
    const listed = await op.call('GET', '/probation-assessments');
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect(((await listed.json()) as { items: unknown[] }).items).toEqual([]);
    expect((await op.call('GET', `/probation-assessments/${id}`)).status).toBe(404);
    const launched = await op.call('POST', '/probation-assessments', {
      body: await launchBody(w, [person.employeeId]),
    });
    expect(launched.status, await launched.clone().text()).toBe(200);
    expect(((await launched.json()) as LaunchReceipt).items[0]).toMatchObject({
      status: 'failed',
      error: { code: 'NOT_FOUND' },
    });
    const all = await w.json<{ items: unknown[] }>(
      await w.request(w.hr.id, 'GET', '/api/tenant/employment/probation-assessments'),
    );
    expect(all.items).toHaveLength(1);
  });
});

describe('P2-2 DEC-415 模块预置管理员的“看全部”', () => {
  const target = {
    appCode: 'TenantBase',
    targetKind: 'entity',
    targetCode: MODULE_OBJECTS.probationAssessment.code,
  };
  const profile = (code: string) => STANDARD_PROFILES.find((p) => p.code === code)!;

  it('标准版系统管理员、人事管理员预置考核对象的看全部，人事专员不预置；批准清单同步', () => {
    expect(presetSeeAllTargets(profile('standard_org_system_admin'))).toContainEqual(target);
    expect(presetSeeAllTargets(profile('standard_hr_admin'))).toContainEqual(target);
    expect(presetSeeAllTargets(profile('standard_hr_specialist'))).not.toContainEqual(target);
    const approved = SEE_ALL_BACKFILL_APPROVED.filter((row) => row.targetCode === target.targetCode);
    expect(approved.map((row) => [row.profileCode, row.dec]).sort()).toEqual([
      ['standard_hr_admin', 'DEC-415'],
      ['standard_org_system_admin', 'DEC-415'],
    ]);
  });

  it('开通后的真实授权器：系统管理员、人事管理员无需配置数据范围即可发起 / 查看考核，人事专员被拒', async () => {
    const { db } = testDb();
    const clock = () => new Date('2026-10-01T04:00:00Z');
    const api = tenantApi(db, { authorize: undefined, clock });
    const fixture = tenantApi(db, { clock });
    const operator = await seedOperator(db);
    const admin = await newUser(db, 'r2-admin');
    const exceptionAdmin = await newUser(db, 'r2-exception');
    const result = await provisioned(api, operator, {
      firstAdminUserId: admin.id,
      exceptionAdminUserId: exceptionAdmin.id,
    });
    const tenant = result.tenant.id;
    const asAdmin = { user: admin.id, tenant };
    const member = async (label: string, code: string) => {
      const user = await newUser(db, label);
      await grantMembership(db, { tenantId: tenant, userId: user.id, expectedRevision: 0 }, cmd());
      const granted = await api.request('POST', '/api/tenant/permission/grants', {
        ...asAdmin,
        body: { userId: user.id, profileId: result.profiles.find((p) => p.code === code)!.id },
      });
      expect(granted.status, await granted.clone().text()).toBe(201);
      return { user: user.id, tenant };
    };
    const asHr = await member('r2-hr', 'standard_hr_admin');
    const asSpecialist = await member('r2-specialist', 'standard_hr_specialist');

    // 员工（试用中）经放行夹具建好：开通租户的预置流程已发布，考核发起会匹配到它
    const org = await fixture.request('POST', '/api/tenant/org/organizations', {
      ...asAdmin,
      ifMatch: 0,
      body: { name: `预置部门${randomUUID()}`, establishedOn: '2020-01-01', parents: { admin: { parentId: tenant } } },
    });
    expect(org.status, await org.clone().text()).toBe(201);
    const department = ((await org.json()) as { id: string }).id;
    const employees: string[] = [];
    for (const name of ['预置员工甲', '预置员工乙']) {
      const created = await fixture.request('POST', '/api/tenant/employment/employees', {
        ...asAdmin,
        ifMatch: 0,
        body: { name, code: `R2_${randomUUID().replaceAll('-', '')}` },
      });
      expect(created.status, await created.clone().text()).toBe(201);
      const employee = (await created.json()) as { id: string };
      const hired = await fixture.request('POST', `/api/tenant/employment/employees/${employee.id}/businesses`, {
        ...asAdmin,
        ifMatch: 1,
        body: withLoginEmail(employee.id, {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: '2026-09-01',
          fields: { employType: 'internal', departmentId: department },
          probation: true,
          probationEndDate: '2026-11-30',
        }),
      });
      expect(hired.status, await hired.clone().text()).toBe(201);
      employees.push(employee.id);
    }
    const body = (employeeId: string) => ({
      assessmentType: 'probation',
      assessmentName: '预置看全部',
      assessmentDate: '2026-10-01',
      items: [{ employeeId, revision: 2 }],
    });
    const launch = (as: { user: string; tenant: string }, employeeId: string) =>
      api.request('POST', '/api/tenant/employment/probation-assessments', { ...as, body: body(employeeId) });

    const ids: string[] = [];
    for (const [as, employeeId] of [
      [asAdmin, employees[0]!],
      [asHr, employees[1]!],
    ] as const) {
      const response = await launch(as, employeeId);
      expect(response.status, await response.clone().text()).toBe(200);
      const receipt = (await response.json()) as LaunchReceipt;
      expect(receipt.items[0], JSON.stringify(receipt)).toMatchObject({ status: 'succeeded' });
      ids.push(receipt.items[0]!.assessmentId!);
    }
    for (const as of [asAdmin, asHr]) {
      const listed = await api.request('GET', '/api/tenant/employment/probation-assessments', as);
      expect(listed.status, await listed.clone().text()).toBe(200);
      expect(((await listed.json()) as { items: { id: string }[] }).items.map((item) => item.id).sort()).toEqual(
        [...ids].sort(),
      );
    }
    // 人事专员有对象功能授权，但没有预置看全部、也没配数据范围：看不到、发起不了
    const specialist = await api.request('GET', '/api/tenant/employment/probation-assessments', asSpecialist);
    expect(specialist.status).toBe(403);
    expect((await launch(asSpecialist, employees[0]!)).status).toBe(403);
  });
});
