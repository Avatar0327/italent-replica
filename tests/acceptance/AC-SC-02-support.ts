import { sql } from '@italent/db';
import { expect } from 'vitest';
import { permissionWorldOf, recordOperator } from './AC-SC-permission-support.js';
import { type SuccessionWorld, successionWorld } from './AC-SC-support.js';
import { tenantApi } from './support/tenant-api.js';
import { rowsOf } from './support/f048.js';
import { dispatchCalcJobs } from '../../apps/api/src/modules/succession/calc-jobs.js';

export async function exitWorld(db: Parameters<typeof successionWorld>[0], label: string) {
  const w = await successionWorld(db, label);
  const targetOrg = await w.org('离职目标部门');
  const targetPosition = await w.position(targetOrg.id, '离职关键岗位');
  let seq = 0;
  let now = new Date('2026-10-01T01:00:00Z');
  const api = tenantApi(db, { clock: () => now });
  const setNow = (iso: string) => {
    now = new Date(iso);
    w.setNow(iso);
  };
  const requestEmployment = (method: string, path: string, options: Parameters<typeof w.request>[2] = {}) =>
    api.request(method, `/api/tenant/employment${path}`, { ...options, user: w.user.id, tenant: w.tenant.id });
  const hire = () => {
    setNow('2026-10-01T01:00:00Z');
    return w.hire(`合成离职员工${++seq}`, { departmentId: targetOrg.id });
  };
  const seedRecord = (employeeId: string, type: 'org' | 'position' = 'position', extra = {}) =>
    w.insertRecord({
      type,
      targetId: type === 'org' ? targetOrg.id : targetPosition.id,
      successorId: employeeId,
      startDate: '2026-10-01',
      ...extra,
    });
  const read = async (id: string) =>
    rowsOf<Record<string, unknown>>(
      await w.asTenant((tx) =>
        tx.execute(sql`SELECT id, end_date::text, end_source, end_reason, exit_record_id,
          revision, backup_type, deleted_at FROM succession_records WHERE id=${id}::uuid`),
      ),
    )[0]!;
  const leave = (employee: { id: string; revision: number }, date = '2026-10-01') =>
    w.business(employee.id, { kind: 'leave', mode: 'direct', lastWorkDate: date }, employee.revision);
  const sweep = (time: string) => dispatchCalcJobs({ db, clock: () => new Date(time) }, { kind: 'exit_sweep' });
  const apps = (employeeId: string) =>
    w.asTenant(async (tx) =>
      rowsOf<{ source: string; ended_record_ids: string[]; candidate_record_ids: string[]; leave_date: string }>(
        await tx.execute(sql`SELECT source, ended_record_ids, candidate_record_ids, leave_date::text
          FROM succession_exit_applications WHERE employee_id=${employeeId}::uuid`),
      ),
    );
  return { ...w, targetOrg, targetPosition, hire, seedRecord, read, leave, sweep, apps, setNow, requestEmployment };
}
export type ExitWorld = Awaited<ReturnType<typeof exitWorld>>;

/** 合成标准计算身份，功能权通过真实权限 API 授予；范围显式授予，不依赖管理员绕过。 */
export async function runner(w: SuccessionWorld, orgIds?: readonly string[]) {
  const pw = await permissionWorldOf(w);
  const operator = await recordOperator(pw, {
    seeAll: orgIds === undefined,
    orgIds,
    writer: { operations: { update: true }, buttons: ['update'] },
  });
  await w.asTenant((tx) =>
    tx.execute(sql`UPDATE permission_profiles SET code='standard_succession_runner', source='standard'
      WHERE id=${operator.profile.id}::uuid`),
  );
  const response = await w.call('PUT', 'settings/succession.system_principal_user_id', {
    ifMatch: 0,
    body: { value: operator.userId },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return { ...operator, pw };
}
