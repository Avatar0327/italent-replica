/**
 * F-462（DEC-644 A-3，R2-T08 §6.3 “执行”列）：执行器的申请人范围走真实授权链（`resolveApplicantScope` →
 * `resolveDataScope` → 管理单元 / 用户应用范围表），**不注入 `scopeOf`**，与 `AC-OA-exec-support.ts` 的 `scopeOf`
 * 替身互不依赖：本文件直接调 `runOrgAdjustmentTenant`，申请人范围只来自库里的管理单元与用户应用范围。
 * 提交 / 审批仍走审批世界的夹具授权器（与执行侧范围无关）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runOrgAdjustmentTenant } from '../../apps/api/src/modules/org-adjustment/execution-runner.js';
import { type ExecWorld, execWorld } from './AC-OA-exec-support.js';
import { rename } from './AC-OA-items-support.js';

const testDb = useTestDb();
const APP = 'TenantBase';

/** 不传 scopeOf：执行器用产品默认的 `resolveApplicantScope`。 */
const runReal = (w: ExecWorld) => runOrgAdjustmentTenant(w.db, w.tenant, w.clock, { holderToken: `p-${randomUUID()}` });

/** 可信夹具：给申请人建一个管理单元（含下级）并挂到其 TenantBase 应用范围。 */
async function grantManagement(w: ExecWorld, orgIds: readonly string[]) {
  const mou = randomUUID();
  await withTenant(w.db, w.tenant.id, async (tx) => {
    await tx.execute(sql`INSERT INTO permission_mous(id,tenant_id,code,name)
      VALUES (${mou}::uuid,${w.tenant.id},${`F462_${mou.slice(0, 8)}`},'合成管理单元')`);
    for (const orgId of orgIds)
      await tx.execute(sql`INSERT INTO permission_mou_org_refs(tenant_id,mou_id,org_id,include_descendants)
        VALUES (${w.tenant.id},${mou}::uuid,${orgId}::uuid,true)`);
    await tx.execute(sql`INSERT INTO permission_user_app_scopes(tenant_id,user_id,app_code,kind,mou_id)
      VALUES (${w.tenant.id},${w.hr.id}::uuid,${APP},'mou',${mou}::uuid)`);
  });
}

/** 撤销：把申请人挂的管理单元停用（managementRoots 只认 active 的管理单元）。 */
const revokeManagement = (w: ExecWorld) =>
  withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`UPDATE permission_mous SET status='disabled' WHERE tenant_id=${w.tenant.id}
      AND id IN (SELECT mou_id FROM permission_user_app_scopes
        WHERE tenant_id=${w.tenant.id} AND user_id=${w.hr.id}::uuid AND app_code=${APP})`),
  );

const reasons = async (w: ExecWorld, id: string) =>
  [...(await w.outcomes(id)).values()].map((o) => [o.execution_result, o.execution_reason]);

describe('F-462 申请人范围走真实授权链（不注入 scopeOf）', () => {
  it('正向：申请人的管理单元含主体与目标组织 → 执行成功，组织改名', async () => {
    const w = await execWorld(testDb().db, 'f462-in');
    const x = await w.org('ZZ_真链X', w.a);
    const adjustment = await w.approved([w.a], [rename(x, { name: 'ZZ_真链新名X', addEmployment: false })]);
    await grantManagement(w, [w.subject, w.a]);

    await runReal(w);

    expect(await reasons(w, adjustment.id)).toEqual([[1, null]]);
    expect((await w.orgAt(x))!.name).toBe('ZZ_真链新名X');
  });

  it('反向：审批通过后申请人的范围被撤销 → APPLICANT_OUT_OF_SCOPE，组织不变', async () => {
    const w = await execWorld(testDb().db, 'f462-revoked');
    const x = await w.org('ZZ_撤销X', w.a);
    const adjustment = await w.approved([w.a], [rename(x, { name: 'ZZ_不应改X', addEmployment: false })]);
    await grantManagement(w, [w.subject, w.a]);
    await revokeManagement(w);

    await runReal(w);

    expect(await reasons(w, adjustment.id)).toEqual([[2, 'APPLICANT_OUT_OF_SCOPE']]);
    expect((await w.orgAt(x))!.name).toBe('ZZ_撤销X');
  });

  it('反向：管理单元只含主体与 B 支 → A 支下的行 APPLICANT_OUT_OF_SCOPE，B 支下的行正常（组织层）', async () => {
    const w = await execWorld(testDb().db, 'f462-org-layer');
    const [x, y] = [await w.org('ZZ_A支X', w.a), await w.org('ZZ_B支Y', w.b)];
    const adjustment = await w.approved(
      [w.a, w.b],
      [rename(x, { name: 'ZZ_不应改X', addEmployment: false }), rename(y, { name: 'ZZ_应改Y', addEmployment: false })],
    );
    await grantManagement(w, [w.subject, w.b]);

    await runReal(w);

    expect(await reasons(w, adjustment.id)).toEqual([
      [2, 'APPLICANT_OUT_OF_SCOPE'],
      [1, null],
    ]);
    expect((await w.orgAt(x))!.name).toBe('ZZ_A支X');
    expect((await w.orgAt(y))!.name).toBe('ZZ_应改Y');
  });
});
