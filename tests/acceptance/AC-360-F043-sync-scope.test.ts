/**
 * F-043（#107 第 3 轮审查存量问题，DEC-285④）：360 普通同步循环写入前按目标人员范围复核。
 * 精细化权限生效时（受限管理员，admin.people 非空），同步循环原来只按“员工信息范围”挑员工，对已挂接的 360 人员照写
 * （名称、部门、职位、上级……）——人员在该管理员的 360 人员范围外时同样被覆盖，回执只是把条目藏起来（写入已经发生）。
 * 修复：已挂接的人员在每次写入前按目标人员范围（与人员列表同一谓词，含创建人维度）复核；范围外的跳过、不写，
 * 回执里记入 skipped（受限查看人看到的与“没有这个人”相同，不泄露存在性），并写审计（action = survey360.person.sync_skipped，
 * 对象 = 该 360 人员，只有能查看该人员日志的人看得到）。精细化关闭或不受限管理员不受影响。
 * 反向用例断言具体值：范围外人员的 name / revision 前后各读一次，范围内的照常覆盖。
 */
import { randomUUID } from 'node:crypto';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { fullAccess, type PersonView, world360, type World360 } from './AC-360-support.js';

const testDb = useTestDb();
const APP = survey360.SURVEY360_APP;

interface SyncPage {
  created: { personId: string; employeeId: string }[];
  updated: { personId: string; employeeId: string }[];
  conflicts: string[];
  skipped: { employeeId: string; reason: string }[];
  nextCursor: string | null;
}

async function hire(w: World360, name: string, orgId: string) {
  const employee = await w.session.employee(name);
  await w.session.business(
    employee.id,
    { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: orgId } },
    employee.revision,
  );
  return employee;
}

async function rename(w: World360, employeeId: string, name: string) {
  const res = await w.api.request('PATCH', `/api/tenant/personnel/employees/${employeeId}`, {
    user: w.admin,
    tenant: w.tenantId,
    ifMatch: 0,
    body: { name },
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

/**
 * 甲部门（受限高级管理员的 360 人员范围）：范围内员工；乙部门：范围外员工。系统管理员先同步，两人都已挂接 360 人员。
 * 之后组织侧把两人都改了名——下一次同步会覆盖 360 端的名称。
 */
async function scene(label: string, fine: boolean) {
  const w = await world360(testDb().db, label, { access: fullAccess() });
  const orgA = await w.session.org('甲部门', { establishedOn: '2025-01-01' });
  const orgB = await w.session.org('乙部门', { establishedOn: '2025-01-01' });
  const inside = await hire(w, '范围内员工', orgA.id);
  const outside = await hire(w, '范围外员工', orgB.id);
  await w.ok(w.request('POST', '/people/sync', { body: {} }));
  const personOf = async (employeeId: string) =>
    (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items.find(
      (p) => p.employeeId === employeeId,
    )!;
  const insidePerson = await personOf(inside.id);
  const outsidePerson = await personOf(outside.id);
  const mou = await w.ok<{ id: string }>(
    w.enterprise('POST', '/mous', {
      ifMatch: 0,
      body: { code: `mou-${label}`, name: '甲部门', orgRanges: [{ orgId: orgA.id, includeDescendants: true }] },
    }),
    201,
  );
  const admin = await w.member('受限高级管理员');
  await w.appoint(admin, 'advanced');
  await w.ok(w.enterprise('PUT', `/scopes/${admin}/${APP}`, { ifMatch: 0, body: { kind: 'mou', mouId: mou.id } }));
  if (fine) {
    const settings = await w.ok<{ revision: number }>(w.request('GET', '/settings'));
    await w.ok(w.request('PUT', '/settings', { ifMatch: settings.revision, body: { finePermission: true } }));
  }
  await rename(w, inside.id, '范围内新名');
  await rename(w, outside.id, '范围外新名');
  const as = w.as(admin);
  const sync = (key = randomUUID()) => as('POST', '/people/sync', { idempotencyKey: key, body: {} });
  const current = async (id: string) => w.ok<PersonView>(w.request('GET', `/people/${id}`));
  const audit = auditApi(testDb().db, '2026-10-01T02:00:00Z', { authorize: w.authorize });
  const skippedLogs = async (viewer: string) =>
    (await audit.dataChanges({ user: viewer, tenant: w.tenantId }, { limit: '100' })).items.filter(
      (log) => log.action === 'survey360.person.sync_skipped',
    );
  return { w, admin, as, sync, current, insidePerson, outsidePerson, inside, outside, skippedLogs };
}

describe('F-043 精细化下同步循环写入前按目标人员范围复核', () => {
  it('范围外已挂接的人员不被覆盖（名称与 revision 前后不变），范围内照常覆盖；回执里看不到范围外条目', async () => {
    const s = await scene('f043a', true);
    const page = await s.w.ok<SyncPage>(s.sync());

    expect(page.updated).toEqual([{ personId: s.insidePerson.id, employeeId: s.inside.id }]);
    expect(JSON.stringify(page)).not.toContain(s.outside.id);
    expect(JSON.stringify(page)).not.toContain(s.outsidePerson.id);
    expect((await s.current(s.insidePerson.id)).name).toBe('范围内新名');
    const outside = await s.current(s.outsidePerson.id);
    expect(outside.name).toBe(s.outsidePerson.name);
    expect(outside.revision).toBe(s.outsidePerson.revision);
  });

  it('每个被跳过的人员记一条审计（对象 = 该 360 人员）：系统管理员看得到，受限管理员看不到；重放不重复记', async () => {
    const s = await scene('f043b', true);
    const key = randomUUID();
    const first = await s.w.ok<SyncPage>(s.sync(key));
    const logs = await s.skippedLogs(s.w.admin);
    expect(logs.map((log) => log.objectId)).toEqual([s.outsidePerson.id]);
    expect(logs[0]!.objectType).toBe('survey360-person');
    expect(await s.skippedLogs(s.admin)).toEqual([]);

    const replay = await s.w.ok<SyncPage>(s.sync(key));
    expect(replay).toEqual(first);
    expect((await s.skippedLogs(s.w.admin)).length).toBe(1);
  });

  it('不受限的系统管理员同步仍覆盖范围外人员；之后受限同步不再有变化', async () => {
    const s = await scene('f043c', true);
    await s.w.ok(s.sync());
    expect((await s.current(s.outsidePerson.id)).name).toBe(s.outsidePerson.name);
    const full = await s.w.ok<SyncPage>(s.w.request('POST', '/people/sync', { body: {} }));
    expect(full.updated.map((e) => e.employeeId).sort()).toEqual([s.outside.id].sort());
    expect((await s.current(s.outsidePerson.id)).name).toBe('范围外新名');
    expect((await s.skippedLogs(s.w.admin)).length).toBe(1);
  });

  it('精细化关闭时不复核：范围外员工同样被覆盖，不记跳过审计（与改动前一致）', async () => {
    const s = await scene('f043d', false);
    const page = await s.w.ok<SyncPage>(s.sync());
    expect(page.updated.map((e) => e.employeeId).sort()).toEqual([s.inside.id, s.outside.id].sort());
    expect((await s.current(s.outsidePerson.id)).name).toBe('范围外新名');
    expect(await s.skippedLogs(s.w.admin)).toEqual([]);
  });
});
