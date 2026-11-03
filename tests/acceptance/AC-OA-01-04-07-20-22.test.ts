/**
 * BE-11b 组织明细执行（R2-T08 §8.1 / §7.5 / §7.8）：经公开建单 → 明细 → 提交 → 两节点同意（入队）→ 执行器默认的组织明细执行器。
 * AC-OA-01 改上级选“是”逐人新增任职（业务类型、变动类型均为组织调整）；AC-OA-04 停用整支一个组；
 * AC-OA-07（DEC-526⑤）部分失败不改审批 / 执行状态、无重新执行接口；AC-OA-20 直接改组织路径不变；AC-OA-22 兼职不生成记录。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { ORG_EMPLOYMENT_LIMIT } from '../../apps/api/src/modules/org/employment-linkage.js';
import { E, cloneStaff, execWorld } from './AC-OA-exec-support.js';
import { BASE } from './AC-OA-head-support.js';
import { rename, stop } from './AC-OA-items-support.js';
import { insertPartTimeRecord } from './AC-PT-support.js';

const testDb = useTestDb();
const EVE = '2026-10-31';

describe('AC-OA-01 / 22 改上级、改名执行与任职联动', () => {
  it('改上级选“是”：组织内每名在职主职员工在 E 各新增一条组织调整记录；改名选“否”不生成；兼职不生成、部门不变', async () => {
    const w = await execWorld(testDb().db, 'oa01-exec');
    const x = await w.org('ZZ_甲下X', w.a);
    const y = await w.org('ZZ_甲下Y', w.a);
    const [e1, e2, ey] = [await w.staff(x), await w.staff(x), await w.staff(y)];
    const partTimer = await w.staff(w.b);
    await withTenant(w.db, w.tenant.id, (tx) =>
      insertPartTimeRecord(tx, {
        tenantId: w.tenant.id,
        employeeId: partTimer,
        departmentId: x,
        startDate: '2026-09-01',
      }),
    );
    const newName = `ZZ_改名${w.a.slice(0, 8)}`;
    const adjustment = await w.approved(
      [w.a, w.b],
      [rename(x, { name: undefined, parent: { orgId: w.b }, addEmployment: true }), rename(y, { name: newName })],
    );

    const result = await w.run();

    expect(result.completed).toEqual([adjustment.id]);
    const outcomes = [...(await w.outcomes(adjustment.id)).values()];
    expect(outcomes.map((o) => [o.execution_result, o.execution_reason])).toEqual([
      [1, null],
      [1, null],
    ]);
    expect(outcomes[0]).toMatchObject({ exec_phase: 2, employment_done: 2, employment_failed: 0 });
    expect(await w.headRow(adjustment.id)).toMatchObject({
      approval_status: 2,
      execution_status: 2,
      success_count: 2,
      failure_count: 0,
      execution_note: '成功执行2个调整，失败0个调整',
      pauses: 0,
    });
    expect((await w.orgAt(x))!.parent_id).toBe(w.b);
    expect((await w.orgAt(x, EVE))!.parent_id).toBe(w.a);
    expect((await w.orgAt(y))!.name).toBe(newName);
    for (const employeeId of [e1, e2]) {
      const added = (await w.records(employeeId)).filter((r) => r.start_date === E);
      expect(added).toEqual([
        {
          kind: 'org_adjustment',
          change_type: 'org_adjustment',
          start_date: E,
          department_id: x,
          service_type: 'primary',
        },
      ]);
    }
    expect((await w.records(ey)).map((r) => r.kind)).toEqual(['hire']);
    const partTime = (await w.records(partTimer)).filter((r) => r.service_type !== 'primary');
    expect(partTime).toEqual([
      expect.objectContaining({ kind: 'part_time', department_id: x, start_date: '2026-09-01' }),
    ]);
    expect((await w.records(partTimer)).some((r) => r.kind === 'org_adjustment')).toBe(false);
  });
});

describe('AC-OA-04 停用整支', () => {
  it('停用有 2 个下级的组织：3 个组织在 E 都停用、E 前仍启用，一个组 3 行都成功，计入 N', async () => {
    const w = await execWorld(testDb().db, 'oa04-exec');
    const p = await w.org('ZZ_停用父', w.a);
    const children = [await w.org('ZZ_停用子一', p), await w.org('ZZ_停用子二', p)];
    const adjustment = await w.approved([w.a], [stop(p)]);
    expect(adjustment.rows).toHaveLength(3);

    await w.run();

    for (const orgId of [p, ...children]) {
      expect((await w.orgAt(orgId))!.enabled).toBe(false);
      expect((await w.orgAt(orgId, EVE))!.enabled).toBe(true);
    }
    const outcomes = [...(await w.outcomes(adjustment.id)).values()];
    expect(outcomes.map((o) => o.execution_result)).toEqual([1, 1, 1]);
    expect(await w.headRow(adjustment.id)).toMatchObject({
      success_count: 3,
      failure_count: 0,
      execution_note: '成功执行3个调整，失败0个调整',
    });
  });
});

describe('AC-OA-07 部分失败（DEC-526⑤）', () => {
  it('一组成功一组失败：审批通过 / 已执行不变，失败行带原因，备注按 §7.8 计数；没有重新执行接口', async () => {
    const w = await execWorld(testDb().db, 'oa07-exec');
    const ok = await w.org('ZZ_成功组', w.a);
    const busy = await w.org('ZZ_停用失败组', w.a);
    const adjustment = await w.approved([w.a], [rename(ok), stop(busy)]);
    // 审批后才有人入职：执行时停用整支不再是空部门，组织写入端口拒绝 → 业务失败。
    await w.staff(busy);

    await w.run();

    const [first, second] = [...(await w.outcomes(adjustment.id)).values()];
    expect(first).toMatchObject({ execution_result: 1, execution_reason: null });
    expect(second).toMatchObject({ execution_result: 2, exec_phase: 2 });
    expect(second!.execution_reason).toEqual(expect.any(String));
    expect(second!.execution_reason).not.toBe('EXECUTOR_NOT_AVAILABLE');
    expect(await w.headRow(adjustment.id)).toMatchObject({
      approval_status: 2,
      execution_status: 2,
      success_count: 1,
      failure_count: 1,
      execution_note: '成功执行1个调整，失败1个调整',
      pauses: 0,
    });
    expect((await w.orgAt(busy))!.enabled).toBe(true);
    for (const path of ['execute', 'retry', 're-execute'])
      expect((await w.call('POST', `${BASE}/${adjustment.id}/${path}`, { ifMatch: 1, body: {} })).status).toBe(404);
  });
});

describe('AC-OA-20 直接改组织路径回归', () => {
  it('PATCH 改名选“是”：任职记录变动类型仍为空，同事务落地；超 1000 人整单 413、组织不写新版本', async () => {
    const w = await execWorld(testDb().db, 'oa20-exec');
    const x = await w.org('ZZ_直接改', w.a);
    const seed = await w.staff(x);
    const ok = await w.patchOrg(x, { name: 'ZZ_直接改名', effectiveDate: E, addEmployment: true });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const added = (await w.records(seed)).filter((r) => r.start_date === E);
    expect(added).toEqual([expect.objectContaining({ kind: 'org_adjustment', change_type: null })]);

    expect(ORG_EMPLOYMENT_LIMIT).toBe(1000);
    const big = await w.org('ZZ_直接超限', w.a);
    const bigSeed = await w.staff(big);
    await cloneStaff(w.db, w.tenant.id, bigSeed, ORG_EMPLOYMENT_LIMIT);
    const versions = await w.versionCount(big);
    const tooMany = await w.patchOrg(big, { name: 'ZZ_不应保存', effectiveDate: E, addEmployment: true });
    expect(tooMany.status).toBe(413);
    expect(await w.versionCount(big)).toBe(versions);
  });
});
