/**
 * BE-11c-b 第 2 轮 P2-5：AC-OA-52 单行编制超限的公开写入口验收（R2-T08 §7.4）。
 * 调动行经 POST …/transfer-items 写入（勾选带编），审批通过后由默认运行器执行：目标部门所在链上编制不足 →
 * 执行即时校验拒绝（VALIDATION_FAILED），整组回滚，编制版本 / 分配 / 调动请求都不变，任职仍在原部门。
 * 多行互调的公开证据随 11c2 的生成组入口补（本片 11c 每条手工调动独立成组，11c-a 内部夹具保留互调证据）。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { transferWorld } from './AC-OA-11cb-support.js';
import { resultRows } from './AC-ORG-people-support.js';

const testDb = useTestDb();

describe('AC-OA-52 单行（公开写入口）', () => {
  it('勾选带编、目标部门编制不足：执行 VALIDATION_FAILED，编制与任职都不变', async () => {
    const w = await transferWorld(testDb().db, 'oa52-single');
    const parentId = await w.org('ZZ_编制上级', w.tenant.id);
    const targetId = await w.org('ZZ_编制目标', parentId);
    const post = async (path: string, body: object) => {
      const res = await w.call('POST', `/api/tenant/${path}`, { ifMatch: 0, body });
      expect(res.status, await res.clone().text()).toBe(201);
      return (await res.json()) as { id: string };
    };
    const scheme = await post('establishment/schemes', {
      name: 'ZZ_编制方案',
      periodType: 'annual',
      maintenanceMode: 'both',
      startDate: '2026-01-01',
    });
    for (const [orgId, localCapacity, inclusiveCapacity] of [
      [w.a, 1, 2],
      [parentId, 2, 12],
      [targetId, 0, 10],
    ] as const) {
      await post('establishment/capacities', {
        orgId,
        schemeId: scheme.id,
        periodStart: '2026-01-01',
        effectiveDate: '2026-01-01',
        localCapacity,
        inclusiveCapacity,
        strictControl: false,
      });
    }
    const mover = await w.staff(w.a);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, targetId] }));
    await w.transfer(view.id, w.transferBody(mover, { orgId: targetId }, { withEstablishment: true }));
    await w.submitted(view.id);
    await w.acted(view.id, w.hrbp, 'approve');
    await w.acted(view.id, w.head, 'approve');
    const snapshot = () =>
      w.inTenant(async (tx) =>
        resultRows(
          await tx.execute(sql`SELECT
            (SELECT jsonb_agg(v ORDER BY v.id) FROM establishment_versions v WHERE tenant_id=${w.tenant.id}) AS versions,
            (SELECT count(*)::int FROM transfer_establishment_allocations WHERE tenant_id=${w.tenant.id}) AS allocations,
            (SELECT count(*)::int FROM transfer_requests WHERE tenant_id=${w.tenant.id}) AS transfers`),
        ),
      );
    const before = await snapshot();

    await w.run();

    const [row] = await w.transferRows(view.id);
    expect(row).toMatchObject({
      execution_result: 2,
      execution_reason: 'VALIDATION_FAILED',
      created_business_id: null,
    });
    expect(await snapshot()).toEqual(before);
    expect((await w.currentRecord(mover))!.department_id).toBe(w.a);
  });
});
