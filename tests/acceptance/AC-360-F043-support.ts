/**
 * F-043 夹具（同步范围复核）：甲部门是受限高级管理员的 360 人员范围；范围内员工的直线经理也在甲部门。
 * 系统管理员先同步，所有人都已挂接 360 人员；之后组织侧把范围内 / 外员工都改了名——下一次同步会覆盖 360 端的名称。
 * 供 AC-360-F043-sync-scope（普通）与 AC-360-F043-race-pg（真 PG 交错）共用。
 */
import { randomUUID } from 'node:crypto';
import { survey360 } from '@italent/domain';
import type { useTestDb } from '@italent/testkit';
import { expect } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { fullAccess, type PersonView, world360, type World360 } from './AC-360-support.js';
import { EMP_TODAY } from './AC-EMP-support.js';

const APP = survey360.SURVEY360_APP;
type Db = ReturnType<ReturnType<typeof useTestDb>>['db'];

export interface SyncPage {
  created: { personId: string; employeeId: string }[];
  updated: { personId: string; employeeId: string }[];
  conflicts: string[];
  skipped: { employeeId: string; reason: string }[];
  nextCursor: string | null;
}

export async function hire(w: World360, name: string, orgId: string, managerId?: string) {
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
  return employee;
}

export async function rename(w: World360, employeeId: string, name: string) {
  const res = await w.api.request('PATCH', `/api/tenant/personnel/employees/${employeeId}`, {
    user: w.admin,
    tenant: w.tenantId,
    ifMatch: 0,
    body: { name },
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

export async function scene(db: Db, label: string, fine: boolean) {
  const w = await world360(db, label, { access: fullAccess() });
  const orgA = await w.session.org('甲部门', { establishedOn: '2025-01-01' });
  const orgB = await w.session.org('乙部门', { establishedOn: '2025-01-01' });
  const orgC = await w.session.org('丙部门（空）', { establishedOn: '2025-01-01' });
  const manager = await hire(w, '甲部门经理', orgA.id);
  const inside = await hire(w, '范围内员工', orgA.id, manager.id);
  const outside = await hire(w, '范围外员工', orgB.id);
  await w.ok(w.request('POST', '/people/sync', { body: {} }));
  const people = async () => (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items;
  const personOf = async (employeeId: string) => (await people()).find((p) => p.employeeId === employeeId)!;
  const managerPerson = await personOf(manager.id);
  const insidePerson = await personOf(inside.id);
  const outsidePerson = await personOf(outside.id);
  const mouFor = async (tag: string, name: string, orgId: string) =>
    (
      await w.ok<{ id: string }>(
        w.enterprise('POST', '/mous', {
          ifMatch: 0,
          body: { code: `mou-${tag}-${label}`, name, orgRanges: [{ orgId, includeDescendants: true }] },
        }),
        201,
      )
    ).id;
  const mouA = await mouFor('a', '甲', orgA.id);
  const mouC = await mouFor('c', '丙', orgC.id);
  const admin = await w.member('受限高级管理员');
  await w.appoint(admin, 'advanced');
  await w.ok(w.enterprise('PUT', `/scopes/${admin}/${APP}`, { ifMatch: 0, body: { kind: 'mou', mouId: mouA } }));
  if (fine) {
    const settings = await w.ok<{ revision: number }>(w.request('GET', '/settings'));
    await w.ok(w.request('PUT', '/settings', { ifMatch: settings.revision, body: { finePermission: true } }));
  }
  await rename(w, inside.id, '范围内新名');
  await rename(w, outside.id, '范围外新名');
  const as = w.as(admin);
  const sync = (key = randomUUID(), body: object = {}) => as('POST', '/people/sync', { idempotencyKey: key, body });
  const current = async (id: string) => w.ok<PersonView>(w.request('GET', `/people/${id}`));
  const audit = auditApi(db, '2026-10-01T02:00:00Z', { authorize: w.authorize });
  const skippedLogs = async (viewer: string) =>
    (await audit.dataChanges({ user: viewer, tenant: w.tenantId }, { limit: '100' })).items.filter(
      (log) => log.action === 'survey360.person.sync_skipped',
    );
  /** 组织侧把员工调到乙部门（受限管理员的 360 人员范围外）。 */
  const transferOut = async (employeeId: string) => {
    const employee = await w.session.getEmployee(employeeId);
    await w.session.business(
      employeeId,
      { kind: 'transfer', mode: 'direct', effectiveDate: EMP_TODAY, fields: { departmentId: orgB.id } },
      employee.revision,
    );
  };
  /** 系统管理员把受限管理员的 360 范围改成空部门（丙），即撤空原范围。 */
  const emptyScope = async () =>
    w.ok(w.enterprise('PUT', `/scopes/${admin}/${APP}`, { ifMatch: 1, body: { kind: 'mou', mouId: mouC } }));
  return {
    w,
    admin,
    as,
    sync,
    current,
    transferOut,
    emptyScope,
    people,
    personOf,
    manager,
    inside,
    outside,
    managerPerson,
    insidePerson,
    outsidePerson,
    skippedLogs,
  };
}
