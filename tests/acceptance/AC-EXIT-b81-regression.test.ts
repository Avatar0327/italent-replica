/**
 * B-81 回归（docs/08_设计/R2-T03_离职管理设计.md §5.0A、§12）：对调动与 main 现有 kind，待生效队列的排序、计划日、
 * 执行日结果不变。先于 B1b 实现在 main 上写成并通过，实现后原样通过；基准是 main 的排序口径
 * （调动与离职按 greatest(计划日, 今天)，B3-3 起离职与调动同式；其余 kind 按载荷日，再按计划日、开新周期排后、操作序号）。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { pendingActivations } from '../../apps/api/src/modules/employment/activation-store.js';
import { activationWorld } from './AC-TRF-activation-support.js';
import {
  derived,
  lastVersion,
  manual,
  plannedOf,
  queueContext,
  randomApplication,
  seedQueue,
  seeded,
  type SyntheticApplication,
} from './AC-EXIT-queue-support.js';

const database = useTestDb();

// 字面量而不是生产导出：本回归夹具必须能在 main 上原样运行（B-81 的基准是 main 行为）
const CYCLE_OPENING_KINDS: readonly string[] = ['hire', 'rehire', 'retire_rehire'];
const ALL_KINDS = [
  'hire',
  'rehire',
  'retire_rehire',
  'regularization',
  'transfer',
  'org_adjustment',
  'leave',
  'retirement',
  'intern_regularization',
] as const;

function legacyOrder(applications: readonly SyntheticApplication[], ids: readonly string[], today: string): string[] {
  return applications
    .map((application, index) => {
      const effective = lastVersion(application.versions).effectiveDate;
      return {
        id: ids[index]!,
        key: [
          (application.kind === 'transfer' || application.kind === 'leave') && effective < today ? today : effective,
          plannedOf(application.versions),
          CYCLE_OPENING_KINDS.includes(application.kind) ? '1' : '0',
          String(application.submitSeq).padStart(12, '0'),
        ].join('|'),
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((item) => item.id);
}

describe('B-81：调动与 main 现有 kind 的队列顺序不变', () => {
  // 含离职：B3-3 起离职与调动同按最终执行日期排序（设计 §5.0）
  const legacyKinds = ALL_KINDS;

  it.each([
    ['今天 = 10-18', '2026-10-18'],
    ['今天 = 10-12（部分申请尚未到期）', '2026-10-12'],
    ['今天 = 11-05（全部已过期）', '2026-11-05'],
  ])('随机队列（全部 kind，含离职）与 main 的排序口径逐条一致：%s', async (_name, today) => {
    const w = await activationWorld(database().db, `exit-b81-${today}`);
    const random = seeded(81);
    for (let round = 0; round < 4; round++) {
      const applications = Array.from({ length: 10 }, (_unused, index) =>
        randomApplication(random, legacyKinds, 2000 + round * 100 + index * 7, today),
      );
      const person = (await w.hired(`B81 ${today} ${round}`)).employee;
      const ids = await seedQueue(w, person.id, applications);
      const queue = await withTenant(w.db, w.session.tenant.id, (tx) =>
        pendingActivations(tx, queueContext(w, today), person.id),
      );
      expect(
        queue.map((item) => item.id),
        `round ${round}`,
      ).toEqual(legacyOrder(applications, ids, today));
    }
  });

  it('队列项的载荷生效日语义不变：迟到顺延后仍是系统写入的执行日', async () => {
    const w = await activationWorld(database().db, 'exit-b81-fields');
    const person = await w.hired();
    const [id] = await seedQueue(w, person.employee.id, [
      { kind: 'transfer', versions: [manual(1, '2026-10-10'), derived(2, '2026-10-12')], submitSeq: 5000 },
    ]);
    const [item] = await withTenant(w.db, w.session.tenant.id, (tx) =>
      pendingActivations(tx, queueContext(w), person.employee.id),
    );
    expect(item).toMatchObject({ id, kind: 'transfer', effectiveDate: '2026-10-12' });
  });
});
