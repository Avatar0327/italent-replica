/**
 * PR #107 第 1 轮审查（权限 / 泄露类 P2-1～P2-5）的回归：
 * P2-1 同步按操作人字段权限裁剪；P2-2 自动添加重新校验员工范围；P2-3 失效确认任务不能读候选；
 * P2-4 幂等重放先校验当前任务与权限；P2-5 失败命令日志按 360 身份裁剪。
 * 负向用例断言具体状态码，并前后读取比对。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { PERSONNEL_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { auditApi } from './AC-AUD-support.js';
import { fullAccess, type PersonView, world360, type World360 } from './AC-360-support.js';

const testDb = useTestDb();
const RECORD = 'TenantBase.EmploymentRecord';

interface SyncResult {
  created: { personId: string; employeeId: string }[];
  updated: { personId: string; employeeId: string }[];
  conflicts: string[];
  skipped: { employeeId: string; reason: string }[];
}

async function hire(w: World360, name: string, orgId: string, managerId?: string, workEmail?: string) {
  const employee = await w.session.employee(name);
  await w.session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2025-01-01',
      fields: { departmentId: orgId, ...(managerId ? { directManagerId: managerId } : {}) },
    },
    employee.revision,
  );
  if (workEmail) {
    const patched = await w.api.request('PATCH', `/api/tenant/personnel/employees/${employee.id}`, {
      user: w.admin,
      tenant: w.tenantId,
      ifMatch: 0,
      body: { workEmail },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
  }
  return employee;
}

const people = async (w: World360) =>
  (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items;

describe('P2-1 同步按操作人对员工信息的字段权限裁剪', () => {
  it('姓名不可见：不建 360 人员（跳过），姓名与工号不出现在 360 人员里', async () => {
    const access = fullAccess();
    const w = await world360(testDb().db, 'r2a1', { access });
    const org = await w.session.org('同步部门', { establishedOn: '2025-01-01' });
    const employee = await hire(w, 'HIDDEN_PROFILE_NAME', org.id, undefined, 'visible-r2a1@example.com');
    access.fields = { [PERSONNEL_OBJECT]: new Set(['workEmail']), [RECORD]: new Set() };
    const result = await w.ok<SyncResult>(w.request('POST', '/people/sync', { body: {} }));
    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([{ employeeId: employee.id, reason: 'FIELD_HIDDEN' }]);
    const all = JSON.stringify(await people(w));
    expect(all).not.toContain('HIDDEN_PROFILE_NAME');
    expect(all).not.toContain(employee.code);
  });

  it('工号、手机、部门、职位不可见：建人员但这些字段为空；登录邮箱兜底同样受邮箱字段权限约束', async () => {
    const access = fullAccess();
    const w = await world360(testDb().db, 'r2a2', { access });
    const org = await w.session.org('隐藏部门', { establishedOn: '2025-01-01' });
    const withWork = await hire(w, '可见姓名', org.id, undefined, 'work-r2a2@example.com');
    const loginOnly = await hire(w, '仅登录邮箱', org.id);
    access.fields = { [PERSONNEL_OBJECT]: new Set(['name', 'workEmail']), [RECORD]: new Set() };
    const result = await w.ok<SyncResult>(w.request('POST', '/people/sync', { body: {} }));
    expect(result.created.map((c) => c.employeeId)).toEqual([withWork.id]);
    expect(result.skipped).toEqual([{ employeeId: loginOnly.id, reason: 'NO_EMAIL' }]);
    const [person] = await people(w);
    expect(person).toMatchObject({
      name: '可见姓名',
      email: 'work-r2a2@example.com',
      staffCode: null,
      mobile: null,
      department: null,
      position: null,
      superiorPersonId: null,
    });
  });

  it('已挂接人员再同步：不可见字段保留 360 现值，不被清空也不被组织值覆盖', async () => {
    const access = fullAccess();
    const w = await world360(testDb().db, 'r2a3', { access });
    const org = await w.session.org('原部门', { establishedOn: '2025-01-01' });
    await hire(w, '再同步员工', org.id, undefined, 'resync-r2a3@example.com');
    const first = await w.ok<SyncResult>(w.request('POST', '/people/sync', { body: {} }));
    const personId = first.created[0]!.personId;
    const before = await w.ok<PersonView>(w.request('GET', `/people/${personId}`));
    const edited = await w.ok<PersonView>(
      w.request('PUT', `/people/${personId}`, { ifMatch: before.revision, body: { department: '360自填' } }),
    );
    access.fields = { [PERSONNEL_OBJECT]: new Set(['name', 'workEmail']), [RECORD]: new Set() };
    const second = await w.ok<SyncResult>(w.request('POST', '/people/sync', { body: {} }));
    expect(second.updated).toEqual([]);
    expect(await w.ok<PersonView>(w.request('GET', `/people/${personId}`))).toEqual(edited);
  });
});

/** 组织架构：M 无上级；E、P1 的直线经理是 M。 */
async function orgScene(w: World360) {
  const org = await w.session.org('评估部', { establishedOn: '2025-01-01' });
  const M = await hire(w, '经理M', org.id);
  const E = await hire(w, '员工E', org.id, M.id);
  const P1 = await hire(w, '同事P1', org.id, M.id);
  const sync = await w.ok<SyncResult>(w.request('POST', '/people/sync', { body: {} }));
  const personOf = (id: string) => sync.created.find((c) => c.employeeId === id)!.personId;
  const q = await w.enableQuestionnaire(await w.keyBehavior());
  const activity = await w.activity();
  const object = await w.object(activity.id, personOf(E.id), [q.id]);
  return { M, E, P1, personOf, q, activity, object };
}

describe('P2-2 按组织架构自动添加重新校验当前员工范围', () => {
  it('撤销操作人员工范围后：自动添加 404，不创建评价关系', async () => {
    const access = fullAccess();
    const w = await world360(testDb().db, 'r2b1', { access });
    const s = await orgScene(w);
    const path = `/activities/${s.activity.id}/objects/${s.object.id}/appraisers`;
    const before = await w.ok<{ items: unknown[] }>(w.request('GET', path));
    access.scope = EMPTY_SCOPE;
    const res = await w.request('POST', `${path}/auto`, { ifMatch: 0, body: { roles: ['superior', 'peer'] } });
    expect(res.status).toBe(404);
    expect(await w.ok<{ items: unknown[] }>(w.request('GET', path))).toEqual(before);
    expect(before.items).toEqual([]);
  });

  it('范围只含评价对象本人：已挂接的同事与上级不在范围内，不被添加', async () => {
    const access = fullAccess();
    const w = await world360(testDb().db, 'r2b2', { access });
    const s = await orgScene(w);
    access.scope = {
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [{ dimension: 'reporting', orgIds: [], personIds: [s.E.id] }],
    };
    const result = await w.ok<{ added: unknown[] }>(
      w.request('POST', `/activities/${s.activity.id}/objects/${s.object.id}/appraisers/auto`, {
        ifMatch: 0,
        body: { roles: ['superior', 'peer'] },
      }),
    );
    expect(result.added).toEqual([]);
    const list = await w.ok<{ items: unknown[] }>(
      w.request('GET', `/activities/${s.activity.id}/objects/${s.object.id}/appraisers`),
    );
    expect(list.items).toEqual([]);
  });
});

describe('P2-3 失效的确认任务不能再读取任何内容', () => {
  it('评价对象移除后：确认主页与候选人员都 404，写入同样 404', async () => {
    const w = await world360(testDb().db, 'r2c');
    const s = await orgScene(w);
    await w.ok(
      w.request('POST', `/activities/${s.activity.id}/objects/${s.object.id}/confirmation`, { ifMatch: 0, body: {} }),
      201,
    );
    const confirm = w.link(await w.token(s.activity.id, s.personOf(s.M.id), 'survey360.confirm_invitation'));
    expect((await confirm('GET', '/confirmation/candidates')).status).toBe(200);
    const object = await w.ok<{ items: { id: string; revision: number }[] }>(
      w.request('GET', `/activities/${s.activity.id}/objects`),
    );
    await w.ok(
      w.request('DELETE', `/activities/${s.activity.id}/objects/${s.object.id}`, {
        ifMatch: object.items[0]!.revision,
      }),
    );
    expect((await confirm('GET', '')).status).toBe(404);
    const candidates = await confirm('GET', '/confirmation/candidates');
    expect(candidates.status).toBe(404);
    expect(await candidates.text()).not.toContain('同事P1');
    const write = await confirm('POST', '/confirmation/appraisers', {
      ifMatch: 1,
      body: { personId: s.personOf(s.P1.id), roleId: w.role('peer') },
    });
    expect(write.status).toBe(404);
  });
});

describe('P2-4 幂等重放先校验当前任务与权限', () => {
  it('评价关系被移除后，用原命令 ID 重放保存答卷：404，答卷不变', async () => {
    const w = await world360(testDb().db, 'r2d1');
    const q = await w.enableQuestionnaire(await w.keyBehavior({ self: 0, customer: 1 }));
    const activity = await w.activity();
    const object = await w.object(activity.id, (await w.person('对象')).id, [q.id]);
    const rater = await w.person('评价者');
    const relation = await w.appraiser(activity.id, object.id, rater.id, 'customer');
    await w.transition(activity.id, 'enable');
    const call = w.link(await w.token(activity.id, rater.id));
    const key = randomUUID();
    const body = { answers: [{ itemId: q.questions[0]!.id, optionId: q.scales[0]!.options[0]!.id }] };
    const path = `/tasks/${relation.id}/questionnaires/${q.id}`;
    expect((await call('PUT', path, { ifMatch: 0, body, idempotencyKey: key })).status).toBe(200);
    const before = await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`SELECT revision, status FROM survey360_sheets WHERE relation_id = ${relation.id}::uuid`),
    );
    await w.ok(
      w.request('DELETE', `/activities/${activity.id}/objects/${object.id}/appraisers/${relation.id}`, {
        ifMatch: relation.revision,
      }),
    );
    expect((await call('GET', path)).status).toBe(404);
    const replay = await call('PUT', path, { ifMatch: 0, body, idempotencyKey: key });
    expect(replay.status).toBe(404);
    const after = await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`SELECT revision, status FROM survey360_sheets WHERE relation_id = ${relation.id}::uuid`),
    );
    expect(after).toEqual(before);
  });

  it('失去员工信息查看权后重放同步：403', async () => {
    const access = fullAccess();
    const w = await world360(testDb().db, 'r2d2', { access });
    const org = await w.session.org('部门', { establishedOn: '2025-01-01' });
    await hire(w, '员工', org.id);
    const key = randomUUID();
    const first = await w.request('POST', '/people/sync', { body: {}, idempotencyKey: key });
    expect(first.status).toBe(200);
    access.canView = false;
    const replay = await w.request('POST', '/people/sync', { body: {}, idempotencyKey: key });
    expect(replay.status).toBe(403);
  });
});

describe('P2-5 失败命令日志按 360 身份裁剪', () => {
  it('匿名作答失败的来源（IP、终端、时间、命令 ID）只给 360 系统管理员', async () => {
    const db = testDb().db;
    const w = await world360(db, 'r2e');
    const q = await w.enableQuestionnaire(await w.keyBehavior({ self: 0, customer: 1 }));
    const activity = await w.activity();
    const object = await w.object(activity.id, (await w.person('对象')).id, [q.id]);
    const rater = await w.person('评价者');
    const relation = await w.appraiser(activity.id, object.id, rater.id, 'customer');
    await w.transition(activity.id, 'enable');
    const call = w.link(await w.token(activity.id, rater.id));
    const key = randomUUID();
    const failed = await call('POST', `/tasks/${relation.id}/questionnaires/${q.id}/submit`, {
      ifMatch: 0,
      idempotencyKey: key,
      headers: { 'x-forwarded-for': '203.0.113.99', 'user-agent': 'ProbeAgent/1.0' },
    });
    expect(failed.status).toBe(400);
    const audit = auditApi(db, '2026-10-01T02:00:00Z', { authorize: w.authorize });
    const failures = async (user: string) =>
      (await audit.commandFailures({ user, tenant: w.tenantId }, { commandId: key })).items;
    const outsider = await w.member('审计员');
    const general = await w.member('一般管理员');
    await w.appoint(general, 'general');
    expect(await failures(outsider)).toEqual([]);
    expect(await failures(general)).toEqual([]);
    const visible = await failures(w.admin);
    expect(visible).toHaveLength(1);
    expect((visible[0] as unknown as { ip: string }).ip).toBe('203.0.113.99');
  });
});
