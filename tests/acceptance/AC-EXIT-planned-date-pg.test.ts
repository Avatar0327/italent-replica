/**
 * AC-DM-26 / §5.0A：计划生效日只有一个来源，同一业务的多条系统顺延（含同一事务写出、created_at 相同）时，
 * SQL `plannedEffectiveDate` ≡ 纯函数 `resolvePlannedEffectiveDate`，且不受 outbox 顺延事件先后 / UUID 影响；
 * 离职（employment.leave.rescheduled）与调动（employment.transfer.rescheduled）同一口径。
 * 设计 §5.0A 原写作“取全部顺延事件原日期的最小值”，main 已按 F-140 约束 2（迁移 0130）改为读人工计划列，
 * 同样与事件先后无关且对离职自动生效，本文件按 main 的实现断言同一性质。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import { resolvePlannedEffectiveDate, type ExecutionKind, type PlanVersion } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { plannedEffectiveDate } from '../../apps/api/src/modules/employment/timeline.js';
import { resultRows } from './AC-ORG-people-support.js';
import { activationWorld } from './AC-TRF-activation-support.js';
import { derived, insertApprovedApplication, manual, pad, seeded } from './AC-EXIT-queue-support.js';

const database = useTestDb();

async function plannedOf(tx: Tx, tenantId: string, businessId: string) {
  const [row] = resultRows<{ planned: string }>(
    await tx.execute(
      sql`SELECT ${plannedEffectiveDate(tenantId, sql`${businessId}::uuid`, sql`'1900-01-01'::date`)}::text AS planned`,
    ),
  );
  return row!.planned;
}

/** 在同一 created_at 写入若干条顺延事件，id 顺序与写入顺序相反 / 相同 / 乱序，覆盖“按 (created_at, id) 读第一条”的旧写法。 */
async function forgeRescheduleEvents(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  businessId: string,
  eventType: string,
  originals: readonly string[],
  ids: readonly string[],
) {
  for (const [index, original] of originals.entries())
    await tx.execute(sql`
      INSERT INTO employment_outbox(id,tenant_id,employee_id,business_id,event_type,object_type,object_id,command_id,
        payload,created_at)
      VALUES (${ids[index]}::uuid,${tenantId},${employeeId}::uuid,${businessId}::uuid,${eventType},
        'employment-business',${businessId}::uuid,${`forged-${index}`},
        ${JSON.stringify({ after: { originalEffectiveDate: original, effectiveDate: '2026-11-01' } })}::jsonb,
        '2026-11-01T01:00:00Z'::timestamptz)`);
}

describe('AC-DM-26 §5.0A：计划日单一来源（SQL ≡ 纯函数）', () => {
  const named: Record<string, readonly PlanVersion[]> = {
    '创建后不改期：计划日 = 创建时的日期': [manual(1, '2026-11-10')],
    '审批前人工改期，再迟到顺延：计划日 = 顺延前的日期': [
      manual(1, '2026-10-16'),
      manual(2, '2026-10-30'),
      derived(3, '2026-11-01'),
    ],
    '多次顺延，同一事务全部版本共用 created_at：仍是首次顺延前的日期': [
      manual(1, '2026-10-20'),
      derived(2, '2026-11-01'),
      derived(3, '2026-11-02'),
      derived(4, '2026-11-02'),
    ],
    '第 7 轮自构①：人工 11-10 → 10-20，同事务顺延 11-01': [
      manual(1, '2026-11-10'),
      manual(2, '2026-10-20'),
      derived(3, '2026-11-01'),
    ],
  };

  it.each(['transfer', 'leave'] as const)('%s：命名反例与随机版本序列', async (kind: ExecutionKind) => {
    const w = await activationWorld(database().db, `exit-planned-${kind}`);
    const random = seeded(55);
    const generated = Array.from({ length: 20 }, (_unused, index) => {
      const length = 1 + Math.floor(random() * 5);
      const versions = Array.from({ length }, (_item, at) => {
        const day = `2026-10-${pad(1 + Math.floor(random() * 28))}`;
        return at === 0 || random() < 0.4 ? manual(at + 1, day) : derived(at + 1, day);
      });
      return [`随机 ${index}`, versions] as const;
    });
    const person = await w.hired(`计划日-${kind}`);
    await withTenant(w.db, w.session.tenant.id, async (tx) => {
      for (const [name, versions] of [...Object.entries(named), ...generated]) {
        const id = await insertApprovedApplication(tx, w.session.tenant.id, person.employee.id, {
          kind,
          versions,
          submitSeq: 9000 + Math.floor(random() * 1000),
        });
        expect(await plannedOf(tx, w.session.tenant.id, id), name).toBe(
          resolvePlannedEffectiveDate({ versions, fallback: '1900-01-01' }),
        );
      }
    });
  });

  it.each([
    ['transfer', 'employment.transfer.rescheduled'],
    ['leave', 'employment.leave.rescheduled'],
  ] as const)(
    '%s：同一 created_at 的多条顺延事件，无论 UUID 先后，计划日都不读事件、结果相同',
    async (kind, eventType) => {
      const w = await activationWorld(database().db, `exit-planned-events-${kind}`);
      const person = await w.hired(`顺延事件-${kind}`);
      const versions = [manual(1, '2026-10-20'), derived(2, '2026-11-01'), derived(3, '2026-11-03')];
      await withTenant(w.db, w.session.tenant.id, async (tx) => {
        // 事件原日期的写入顺序 / UUID 顺序三种排布，同一 created_at；outbox 只追加，每种排布用一个新业务
        const orders = [
          [
            ['2026-10-20', '2026-11-01'],
            ['00000000-0000-4000-8000-000000000001', 'ffffffff-ffff-4fff-8fff-ffffffffffff'],
          ],
          [
            ['2026-10-20', '2026-11-01'],
            ['ffffffff-ffff-4fff-8fff-ffffffffffff', '00000000-0000-4000-8000-000000000001'],
          ],
          [
            ['2026-11-01', '2026-10-20'],
            ['00000000-0000-4000-8000-000000000002', 'ffffffff-ffff-4fff-8fff-fffffffffffe'],
          ],
        ] as const;
        for (const [at, [originals, ids]] of orders.entries()) {
          const id = await insertApprovedApplication(tx, w.session.tenant.id, person.employee.id, {
            kind,
            versions,
            submitSeq: 9500 + at,
          });
          // outbox 事件 id 全局唯一：排布与 kind 各用不同前缀
          const unique = ids.map((value) => `${at}${kind === 'leave' ? 'a' : 'b'}${value.slice(2)}`);
          expect(await plannedOf(tx, w.session.tenant.id, id)).toBe('2026-10-20');
          await forgeRescheduleEvents(tx, w.session.tenant.id, person.employee.id, id, eventType, originals, unique);
          expect(await plannedOf(tx, w.session.tenant.id, id), `${originals} ${ids}`).toBe('2026-10-20');
        }
      });
    },
  );

  it('没有载荷版本时取 fallback（组织调整等直接落地的记录）', async () => {
    const w = await activationWorld(database().db, 'exit-planned-fallback');
    await withTenant(w.db, w.session.tenant.id, async (tx) => {
      const [row] = resultRows<{ planned: string }>(
        await tx.execute(
          sql`SELECT ${plannedEffectiveDate(
            w.session.tenant.id,
            sql`gen_random_uuid()`,
            sql`'2026-10-09'::date`,
          )}::text AS planned`,
        ),
      );
      expect(row!.planned).toBe('2026-10-09');
      expect(resolvePlannedEffectiveDate({ versions: [], fallback: '2026-10-09' })).toBe('2026-10-09');
    });
  });
});
