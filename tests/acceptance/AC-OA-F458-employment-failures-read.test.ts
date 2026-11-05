/**
 * F-458（B3b，BE-11b 审查转出）：§7.5“失败员工在详情逐人列出”。
 * - 详情读取带 `employmentFailures`：只列查看人员工范围内的员工，范围外员工的姓名 / 原因 / 编码都不出现；
 *   员工范围为空一律不列（fail-closed）；失败所属明细行对查看人不可见时同样不列；审批人路径不具员工范围，不列。
 * - 失败表复合外键：(tenant_id, adjustment_id, item_id) → 明细行、(tenant_id, employee_id) → 员工头表，
 *   指向不存在的明细 / 员工的失败行写不进去。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { APV_TODAY } from './AC-APV-support.js';
import { only } from './AC-OA-head-support.js';
import { itemsWorld, rename } from './AC-OA-items-support.js';
import { reader } from './AC-OA-read-support.js';
import { resultRows } from './AC-ORG-people-support.js';

const testDb = useTestDb();

/** 员工范围只含指定员工（汇报线维度的人员集合）。 */
const people = (...personIds: string[]): ModuleScope => ({
  ...EMPTY_SCOPE,
  personIds,
  hasDataPermission: true,
  terms: [{ dimension: 'reporting', orgIds: [], personIds }],
});

async function world(label: string) {
  const w = await itemsWorld(testDb().db, label);
  const view = await w.created(w.head({ adjustmentRange: [w.a] }));
  const renamed = await w.item(view.id, rename(w.a));
  const itemId = renamed.items.at(-1)!.id;
  const inScope = await w.person('ZZ_范围内甲', w.a);
  const outScope = await w.person('ZZ_范围外乙', w.b);
  const insertFailure = (employeeId: string, reason: string, message: string, id = itemId) =>
    withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO org_adjustment_employment_failures
        (tenant_id, adjustment_id, item_id, employee_id, reason, message)
        VALUES (${w.tenant.id}, ${view.id}, ${id}, ${employeeId}, ${reason}, ${message})`),
    );
  await insertFailure(inScope.employeeId, 'EMPLOYMENT_CHANGED', '范围内员工的失败说明');
  await insertFailure(outScope.employeeId, 'APPLICANT_OUT_OF_SCOPE', '范围外员工的失败说明');
  return { w, r: reader(w), view, itemId, inScope, outScope, insertFailure };
}

describe('F-458 详情逐人列出人员联动失败（按查看人员工范围裁剪）', () => {
  it.each([
    { scopeOnTarget: true, scenario: '只有组织 A 范围：当前在 B 的员工在 A 明细上的失败行可见' },
    { scopeOnTarget: false, scenario: '只有无关组织 C 范围：失败行及姓名 / 编码 / 原因 / 说明均不泄露' },
  ])('DEC-177 $scenario（无人员维度授权）', async ({ scopeOnTarget }) => {
    const w = await itemsWorld(testDb().db, `oaf458-department-${scopeOnTarget}`);
    const view = await w.created();
    const itemId = (await w.item(view.id, rename(w.a, { addEmployment: true }))).items.at(-1)!.id;
    const employee = await w.person('ZZ_当前在乙的员工', w.b);
    const employeeCode = await withTenant(w.db, w.tenant.id, async (tx) => {
      const [row] = resultRows<{ code: string }>(
        await tx.execute(sql`SELECT code FROM employment_employees WHERE id = ${employee.employeeId}`),
      );
      return row!.code;
    });
    const failure = {
      itemId,
      employeeId: employee.employeeId,
      employeeCode,
      employeeName: employee.name,
      reason: 'EMPLOYMENT_CHANGED',
      message: '甲部门追加任职失败的合成说明',
    };
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO org_adjustment_employment_failures
        (tenant_id, adjustment_id, item_id, employee_id, reason, message)
        VALUES (${w.tenant.id}, ${view.id}, ${itemId}, ${employee.employeeId}, ${failure.reason}, ${failure.message})`),
    );
    const orgIds = [scopeOnTarget ? w.a : await w.org('无关组织丙')];
    w.access.org = only(w.a);
    w.access.employment = {
      ...EMPTY_SCOPE,
      orgIds,
      hasDataPermission: true,
      terms: [
        {
          dimension: 'organization',
          orgIds,
          personIds: [],
          personQuery: { kind: 'organization', tenantId: w.tenant.id, asOf: APV_TODAY },
        },
      ],
    };

    const detail = await reader(w).detail(view.id);
    expect(detail.employmentFailures).toEqual(scopeOnTarget ? [failure] : []);
    if (!scopeOnTarget) {
      const text = JSON.stringify(detail);
      for (const secret of [failure.employeeName, employeeCode, failure.reason, failure.message]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('员工范围含部分员工：只列范围内的人；范围外员工的姓名 / 编码 / 原因 / 说明都不出现', async () => {
    const { w, r, view, itemId, inScope } = await world('oaf458-scope');
    w.access.employment = people(inScope.employeeId);

    const detail = (await r.detail(view.id)) as { employmentFailures?: unknown };

    expect(detail.employmentFailures).toEqual([
      {
        itemId,
        employeeId: inScope.employeeId,
        employeeCode: expect.any(String),
        employeeName: 'ZZ_范围内甲',
        reason: 'EMPLOYMENT_CHANGED',
        message: '范围内员工的失败说明',
      },
    ]);
    const text = JSON.stringify(detail);
    for (const secret of ['ZZ_范围外乙', 'APPLICANT_OUT_OF_SCOPE', '范围外员工的失败说明']) {
      expect(text).not.toContain(secret);
    }
  });

  it('看全部：两人都列出', async () => {
    const { r, view, inScope, outScope } = await world('oaf458-all');
    const detail = (await r.detail(view.id)) as { employmentFailures?: { employeeId: string }[] };
    expect(detail.employmentFailures?.map((f) => f.employeeId).sort()).toEqual(
      [inScope.employeeId, outScope.employeeId].sort(),
    );
  });

  it('员工范围为空：一个都不列（fail-closed），详情其余内容照常', async () => {
    const { w, r, view } = await world('oaf458-empty');
    w.access.employment = EMPTY_SCOPE;
    const detail = (await r.detail(view.id)) as { employmentFailures?: unknown; sections: Record<string, unknown> };
    expect(detail.employmentFailures).toEqual([]);
    expect(detail.sections).toHaveProperty('org');
  });

  it('失败所属明细行对查看人不可见（组织在其组织范围外）：不列', async () => {
    const { w, r, view } = await world('oaf458-hidden-row');
    w.access.org = only(w.b);
    const detail = (await r.detail(view.id)) as { employmentFailures?: unknown };
    expect(detail.employmentFailures).toEqual([]);
  });
});

describe('F-458 失败表复合外键', () => {
  it('明细行不存在或属于别的申请单 → 拒绝；员工不存在 → 拒绝', async () => {
    const { w, view, inScope, insertFailure } = await world('oaf458-fk');
    await expect(insertFailure(inScope.employeeId, 'X', 'x', randomUUID())).rejects.toThrow();
    const other = await w.created(w.head({ adjustmentRange: [w.b] }));
    const foreign = (await w.item(other.id, rename(w.b))).items.at(-1)!.id;
    await expect(insertFailure(inScope.employeeId, 'X', 'x', foreign)).rejects.toThrow();
    await expect(insertFailure(randomUUID(), 'X', 'x')).rejects.toThrow();
    expect(view.id).not.toBe(other.id);
  });
});
