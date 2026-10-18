/**
 * AC-TRF-31 / DEC-161：历史遗留的未来停用排期也阻止生效，保留原日期并接入 DEC-052 / DEC-112。
 * 原标题误写为不存在的 AC-TRF-161，按 DEC-271 改为实际对应的 AC-TRF-31（R1-T08 段：生效失败框架）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { activationWorld, seedLegacyOrgDeactivation } from './AC-TRF-activation-support.js';

const testDb = useTestDb();

describe('AC-TRF-31 / DEC-161 生效时按 DEC-150 再校验整个时段', () => {
  it.each(['2026-10-05', '2026-10-06'])(
    '历史遗留的目标部门未来停用：到期失败生成 HR 待办，后续 %s 业务挂起且不写版本链',
    async (laterDate) => {
      const w = await activationWorld(testDb().db, `trf161-${laterDate}`);
      const { employee, hire } = await w.hired();
      const first = await w.approve(
        await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id }),
        '2026-10-02T02:00:00Z',
      );
      const later = await w.approve(
        await w.apply(employee.id, laterDate, { place: '后序调动' }),
        '2026-10-02T03:00:00Z',
      );
      expect(first).toMatchObject({ status: 'approved', record: null, activation: { status: 'pending' } });
      const chainBefore = await w.session.records(employee.id, '2026-10-05');
      await seedLegacyOrgDeactivation(w, '2026-10-10');

      expect(await w.runScheduler('2026-10-05T01:00:00Z')).toMatchObject({
        activated: [],
        failed: [first.id],
        suspended: laterDate === '2026-10-05' ? [later.id] : [],
      });
      expect(await w.business(first.id)).toMatchObject({
        status: 'approved',
        effectiveDate: '2026-10-05',
        record: null,
        activation: { status: 'failed', failureCount: 1, failureReason: 'RULE_REJECTED' },
      });
      expect(await w.session.records(employee.id, '2026-10-05')).toEqual(chainBefore);
      expect(chainBefore.map((record) => record.id)).toEqual([hire.id]);
      expect(await w.todos()).toEqual([
        expect.objectContaining({
          id: first.id,
          effectiveDate: '2026-10-05',
          activation: expect.objectContaining({ status: 'failed', failureCount: 1 }),
        }),
      ]);
      expect(
        (await w.auditEvents(first.id)).find((event) => event.action === 'employment.activation.failed'),
      ).toMatchObject({
        after: {
          reason: 'RULE_REJECTED',
          detail: {
            rule: 'EMPLOYMENT_DEPARTMENT_DISABLED',
            message: '任职部门【调入部门】已被停用（停用日期：2026-10-10），请检查',
          },
        },
      });
      expect((await w.outboxEvents(first.id)).map((event) => event.eventType)).toContain(
        'employment.activation.failed',
      );

      if (laterDate === '2026-10-06') {
        expect(await w.runScheduler('2026-10-06T01:00:00Z')).toMatchObject({
          activated: [],
          failed: [],
          suspended: [later.id],
        });
      }
      expect(await w.business(later.id)).toMatchObject({
        status: 'approved',
        effectiveDate: laterDate,
        record: null,
        activation: { status: 'suspended', failureReason: 'PREDECESSOR_FAILED', blockedByBusinessId: first.id },
      });
      expect(await w.runScheduler('2026-10-06T02:00:00Z')).toMatchObject({ activated: [], failed: [], suspended: [] });
      expect((await w.business(first.id)).activation).toMatchObject({ failureCount: 1 });
      expect(await w.session.records(employee.id, '2026-10-05')).toEqual(chainBefore);
    },
  );
});
