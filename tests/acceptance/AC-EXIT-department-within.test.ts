/**
 * AC-DM-27（§6B.2-3）：有终点的组织可用性校验 `assertEmploymentDepartmentAvailableWithin(departmentId, from, to)`——
 * 区间内任一天组织不可用才拒绝（to 开放则任一），既有无终点 `assertEmploymentDepartmentAvailable` 不改。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../apps/api/src/errors.js';
import {
  assertEmploymentDepartmentAvailable,
  assertEmploymentDepartmentAvailableWithin,
} from '../../apps/api/src/modules/employment/references.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { activationWorld, seedLegacyOrgDeactivation, type ActivationWorld } from './AC-TRF-activation-support.js';

const database = useTestDb();
const DISABLED_ON = '2026-10-26';

function context(w: ActivationWorld): EmploymentContext {
  return {
    tenantId: w.session.tenant.id,
    userId: w.session.user.id,
    timezone: w.session.tenant.timezone,
    now: new Date('2026-10-18T01:00:00Z'),
    commandId: 'within-check',
    expectedRevision: 0,
  };
}

async function world(label: string) {
  const w = await activationWorld(database().db, label);
  await seedLegacyOrgDeactivation(w, DISABLED_ON);
  return w;
}

const run = (w: ActivationWorld, fn: Parameters<typeof withTenant<unknown>>[2]) =>
  withTenant(w.db, w.session.tenant.id, fn);

describe('assertEmploymentDepartmentAvailableWithin', () => {
  it.each([
    ['区间在停用日之前结束（半开区间不含停用日）', '2026-10-01', '2026-10-26'],
    ['区间远在停用日之前', '2026-10-01', '2026-10-10'],
  ])('通过：%s', async (_name, from, to) => {
    const w = await world(`within-ok-${to}`);
    await expect(
      run(w, (tx) => assertEmploymentDepartmentAvailableWithin(tx, context(w), w.to.id, from, to)),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['区间含停用日', '2026-10-01', '2026-10-27'],
    ['区间以停用日起算', '2026-10-26', '2026-11-30'],
    ['区间开放（任一天停用即拒绝）', '2026-10-01', null],
    ['区间整段在停用之后', '2026-11-05', '2026-11-30'],
    ['开放区间起点已在停用之后', '2026-11-05', null],
  ])('拒绝：%s', async (_name, from, to) => {
    const w = await world(`within-reject-${from}-${to}`);
    const error = await run(w, (tx) =>
      assertEmploymentDepartmentAvailableWithin(tx, context(w), w.to.id, from, to),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'EMPLOYMENT_DEPARTMENT_DISABLED', disabledOn: DISABLED_ON },
    });
    expect((error as AppError).message).toContain(`停用日期：${DISABLED_ON}`);
  });

  it('从未停用的组织：任何区间都通过；部门为空时不校验', async () => {
    const w = await world('within-never');
    await run(w, async (tx) => {
      await assertEmploymentDepartmentAvailableWithin(tx, context(w), w.from.id, '2026-01-01', null);
      await assertEmploymentDepartmentAvailableWithin(tx, context(w), null, '2026-01-01', null);
    });
  });

  it('既有无终点变体不改：停用日在起点之后同样拒绝（与 Within 的开放区间等价）', async () => {
    const w = await world('within-legacy');
    const call = (fn: () => Promise<void>) =>
      fn().then(
        () => null,
        (caught: unknown) => caught,
      );
    const legacy = await run(w, (tx) =>
      call(() => assertEmploymentDepartmentAvailable(tx, context(w), w.to.id, '2026-10-01')),
    );
    const open = await run(w, (tx) =>
      call(() => assertEmploymentDepartmentAvailableWithin(tx, context(w), w.to.id, '2026-10-01', null)),
    );
    expect(legacy).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((legacy as AppError).details).toEqual((open as AppError).details);
    expect((legacy as AppError).message).toBe((open as AppError).message);
  });
});
