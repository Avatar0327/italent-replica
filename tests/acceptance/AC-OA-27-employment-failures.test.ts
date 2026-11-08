/**
 * R2-T08 F-414③：逐员工失败（BE-11b，§7.5 / §10“可见员工才列”）按查看人的任职对象范围裁剪。
 * 范围外员工不出现姓名 / 原因；组织级结果（executionResult / executionMessage 的失败总数）不受员工范围影响，
 * 范围外失败数另给 `employmentFailureHiddenCount`，让查看人知道“还有 N 人未披露”而不知道是谁。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { ModuleScope } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { itemsWorld, rename } from './AC-OA-items-support.js';
import { reader, setItemResult } from './AC-OA-read-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

const people = (...personIds: string[]): ModuleScope => ({
  ...EMPTY_SCOPE,
  personIds,
  hasDataPermission: true,
  terms: [{ dimension: 'management', orgIds: [], personIds }],
});

describe('AC-OA-27 F-414③ 逐员工失败按查看人员工范围裁剪', () => {
  it('只列范围内员工的姓名与原因；范围外员工不出现，只计入未披露人数；组织级总数不变', async () => {
    const w = await itemsWorld(testDb().db, 'oa27f');
    const s = uniqueSuffix();
    const [seenName, hiddenName] = [`ZZ_可见员工${s}`, `ZZ_范围外员工${s}`];
    const seen = await w.employee(seenName);
    const hidden = await w.employee(hiddenName);
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const row = (await w.item(view.id, rename(w.a))).items.at(-1)!;
    await setItemResult(w, row.id, 2, 'EMPLOYMENT_PARTIAL');
    const failure = (employeeId: string, reason: string, message: string) =>
      sql`INSERT INTO org_adjustment_employment_failures
          (tenant_id, adjustment_id, item_id, employee_id, reason, message)
        VALUES (${w.tenant.id}, ${view.id}, ${row.id}, ${employeeId}, ${reason}, ${message})`;
    await withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.execute(failure(seen.id, 'OUT_OF_SCOPE', `可见原因${s}`));
      await tx.execute(failure(hidden.id, 'JOB_CHANGED', `隐藏原因${s}`));
    });
    w.access.employment = people(seen.id);

    const body = await reader(w).items(view.id);
    const [item] = body.items;
    expect(item).toMatchObject({
      employmentFailures: [
        { employeeId: seen.id, employeeName: seenName, reason: 'OUT_OF_SCOPE', message: `可见原因${s}` },
      ],
      employmentFailureHiddenCount: 1,
      executionResult: 2,
    });
    const text = JSON.stringify(body);
    for (const secret of [hidden.id, hiddenName, `隐藏原因${s}`, 'JOB_CHANGED']) expect(text).not.toContain(secret);
  });

  it('员工范围为空（fail-closed）：一条都不列，全部计入未披露人数', async () => {
    const w = await itemsWorld(testDb().db, 'oa27f');
    const employee = await w.employee(`ZZ_员工${uniqueSuffix()}`);
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const row = (await w.item(view.id, rename(w.a))).items.at(-1)!;
    await setItemResult(w, row.id, 2, 'EMPLOYMENT_PARTIAL');
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO org_adjustment_employment_failures
          (tenant_id, adjustment_id, item_id, employee_id, reason, message)
        VALUES (${w.tenant.id}, ${view.id}, ${row.id}, ${employee.id}, 'JOB_CHANGED', '合成原因')`),
    );
    w.access.employment = { ...EMPTY_SCOPE, hasDataPermission: true };

    const [item] = (await reader(w).items(view.id)).items;
    expect(item).toMatchObject({ employmentFailures: [], employmentFailureHiddenCount: 1 });
  });
});
