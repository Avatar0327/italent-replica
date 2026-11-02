/**
 * AC-OA-37（DEC-644 A-3，R2-T08 §6.3 授权矩阵“执行”列；11b：主体层 / 组织层 / 改名逐员工）：执行时按申请人当时的范围复核。
 * 员工、合同层随 11c。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { type ExecWorld, execWorld } from './AC-OA-exec-support.js';
import { only } from './AC-OA-head-support.js';
import { rename } from './AC-OA-items-support.js';
import { executionAudits } from './support/org-adjustment-execution.js';

const testDb = useTestDb();
const people = (...personIds: string[]): ModuleScope => ({
  ...EMPTY_SCOPE,
  hasDataPermission: true,
  terms: [{ dimension: 'reporting', orgIds: [], personIds }],
});

const reasons = async (w: ExecWorld, id: string) =>
  [...(await w.outcomes(id)).values()].map((o) => [o.execution_result, o.execution_reason]);

describe('AC-OA-37 主体层 / 账号', () => {
  it('主体组织移出申请人 OrganizationApproval 范围 → 全部组 APPLICANT_OUT_OF_SCOPE、不暂停、组织不变', async () => {
    const w = await execWorld(testDb().db, 'oa37-subject');
    const [x, y] = [await w.org('ZZ_主体层X', w.a), await w.org('ZZ_主体层Y', w.a)];
    const adjustment = await w.approved([w.a], [rename(x, { name: 'ZZ_不应改X' }), rename(y)]);
    w.access.main = only(w.a);

    await w.run();

    const denied = [2, 'APPLICANT_OUT_OF_SCOPE'];
    expect(await reasons(w, adjustment.id)).toEqual([denied, denied]);
    expect((await w.orgAt(x))!.name).toBe('ZZ_主体层X');
    const started = (await executionAudits(w.db, w.tenant.id, adjustment.id)).find((r) => r.action.endsWith('started'));
    expect(started!.after.pausedOrgIds).toEqual([]);
    expect(await w.headRow(adjustment.id)).toMatchObject({ success_count: 0, failure_count: 2, pauses: 0 });
  });

  it('申请人在本租户的身份停用 → 范围为空，全部组失败（硬规则 1）', async () => {
    const w = await execWorld(testDb().db, 'oa37-account');
    const x = await w.org('ZZ_停号X', w.a);
    const adjustment = await w.approved([w.a], [rename(x)]);
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`UPDATE tenant_memberships SET status='revoked'
        WHERE tenant_id=${w.tenant.id} AND user_id=${w.hr.id}`),
    );

    await w.run();

    expect(await reasons(w, adjustment.id)).toEqual([[2, 'APPLICANT_OUT_OF_SCOPE']]);
  });
});

describe('AC-OA-37 组织层', () => {
  it('某行目标组织移出申请人组织范围 → 该组失败，其余组正常', async () => {
    const w = await execWorld(testDb().db, 'oa37-org');
    const [x, y] = [await w.org('ZZ_组织层X', w.a), await w.org('ZZ_组织层Y', w.a)];
    const adjustment = await w.approved([w.a], [rename(x, { name: 'ZZ_不应改' }), rename(y, { name: 'ZZ_应改' })]);
    w.access.org = only(w.subject, w.a, w.b, y);

    await w.run();

    expect(await reasons(w, adjustment.id)).toEqual([
      [2, 'APPLICANT_OUT_OF_SCOPE'],
      [1, null],
    ]);
    expect((await w.orgAt(x))!.name).toBe('ZZ_组织层X');
    expect((await w.orgAt(y))!.name).toBe('ZZ_应改');
  });
});

describe('AC-OA-37 改名逐员工', () => {
  it('改名选“是”，整支中 1 人移出申请人任职范围 → 组织已改，此人记逐员工失败，明细 EMPLOYMENT_PARTIAL', async () => {
    const w = await execWorld(testDb().db, 'oa37-employee');
    const x = await w.org('ZZ_逐员工X', w.a);
    const [kept, lost] = [await w.staff(x), await w.staff(x)];
    const adjustment = await w.approved([w.a], [rename(x, { name: 'ZZ_逐员工新名', addEmployment: true })]);
    w.scopes.employment = people(kept);

    await w.run();

    const [row] = [...(await w.outcomes(adjustment.id)).values()];
    expect(row).toMatchObject({
      execution_result: 2,
      execution_reason: 'EMPLOYMENT_PARTIAL',
      execution_message: '组织已调整，1 名员工任职追加失败',
      employment_done: 1,
      employment_failed: 1,
    });
    expect((await w.orgAt(x))!.name).toBe('ZZ_逐员工新名');
    expect(row!.executed_version_id).toBe((await w.orgAt(x))!.version_id);
    expect(await w.failures(adjustment.id)).toEqual([
      { item_id: row!.id, employee_id: lost, reason: 'APPLICANT_OUT_OF_SCOPE' },
    ]);
    expect((await w.records(kept)).some((r) => r.kind === 'org_adjustment')).toBe(true);
    expect((await w.records(lost)).some((r) => r.kind === 'org_adjustment')).toBe(false);
    expect(await w.headRow(adjustment.id)).toMatchObject({ success_count: 0, failure_count: 1 });
  });
});
