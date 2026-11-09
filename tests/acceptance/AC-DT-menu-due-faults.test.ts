/**
 * R2-T09a 职责转交菜单：到期执行的逐人兜底（第 2 轮返工 P3-1；仿任职生效 sweepTenant 的逐员工 catch）。
 * 非业务异常（瞬时 DB 错误、死锁、未映射的错误码）只记入本轮 errors 与执行次数，不记失败原因（下轮照常重试），
 * 不打断同租户后续被转交人，也不打断任职生效调度的后续租户。故障经模块替身注入，业务路径保持真实。
 * F-448（第 2 轮交叉审 P3-4）：非业务异常累计到上限（同类定时任务的 5 次）后按既有失败口径落账、不再重试；
 * 记次本身失败（第 2 轮 Sol 的二次兜底）只在逐人兜底一处接住，不打断同租户后续被转交人。
 * F-454：覆盖清零重试预算；业务失败不占预算；只给抛错的那条记录计次，定位不到时按整人口径；
 * 记次失败另记一条 errors（ATTEMPT_COUNT_FAILED）；记次先取参与人锁，被占用则本轮不记。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import type * as DutyExecution from '../../apps/api/src/modules/transfer/linkage/duty-execution.js';
import type * as DutyScheduler from '../../apps/api/src/modules/duty-transfer/scheduler.js';
import type * as DutyService from '../../apps/api/src/modules/duty-transfer/service.js';
import type * as TransferLocks from '../../apps/api/src/modules/employment/transfer-locks.js';
import { runEmploymentActivations } from '../../apps/api/src/modules/employment/activation-scheduler.js';
import { cmd } from './support/tenant-api.js';
import { menuWorld, subordinateItem } from './AC-DT-menu-support.js';

const faults = vi.hoisted(() => ({
  holders: new Set<string>(),
  tenants: new Set<string>(),
  /** 到期执行给这些被转交人的记录落“失败”审计时抛错（模拟记次 / 落账事务自身出错）。 */
  failedAudit: new Set<string>(),
  /** 到期执行时这些下属的转交抛非业务异常（按条定位，F-454）。 */
  subordinates: new Set<string>(),
  /** 被转交人 → 参与人锁的脚本：依次对该人的取锁调用生效（'throw' 抛错 / 'busy' 报被占用 / 其余走真实取锁）。 */
  locks: new Map<string, ('throw' | 'busy' | 'real')[]>(),
}));

vi.mock('../../apps/api/src/modules/transfer/linkage/duty-execution.js', async (importOriginal) => {
  const original = await importOriginal<typeof DutyExecution>();
  return {
    ...original,
    executeDutyItem: (...args: Parameters<typeof original.executeDutyItem>) => {
      if (faults.holders.has(args[2].employeeId)) throw new Error('合成故障：连接中断');
      if (args[2].kind === 'subordinate' && faults.subordinates.has(args[2].subordinateId))
        throw new Error('合成故障：这一条的连接中断');
      return original.executeDutyItem(...args);
    },
  };
});

vi.mock('../../apps/api/src/modules/employment/transfer-locks.js', async (importOriginal) => {
  const original = await importOriginal<typeof TransferLocks>();
  return {
    ...original,
    lockTransferParticipants: async (...args: Parameters<typeof original.lockTransferParticipants>) => {
      const step = faults.locks.get(args[2])?.shift();
      if (step === 'throw') throw new Error('合成故障：取参与人锁失败');
      if (step === 'busy') return 'busy' as const;
      return original.lockTransferParticipants(...args);
    },
  };
});

vi.mock('../../apps/api/src/modules/duty-transfer/scheduler.js', async (importOriginal) => {
  const original = await importOriginal<typeof DutyScheduler>();
  return {
    ...original,
    runDueMenuDutyTransfers: (...args: Parameters<typeof original.runDueMenuDutyTransfers>) => {
      if (faults.tenants.has(args[1].id)) throw new Error('合成故障：租户库不可用');
      return original.runDueMenuDutyTransfers(...args);
    },
  };
});

vi.mock('../../apps/api/src/modules/duty-transfer/service.js', async (importOriginal) => {
  const original = await importOriginal<typeof DutyService>();
  return {
    ...original,
    auditRecord: (...args: Parameters<typeof original.auditRecord>) => {
      if (args[2] === 'duty_transfer.menu.failed' && faults.failedAudit.has(args[4].employeeId))
        throw new Error('合成故障：审计写入失败');
      return original.auditRecord(...args);
    },
  };
});

const database = useTestDb();
/** 本轮到期转交的汇总（挂在任职生效调度每个租户的结果上）。 */
const dutyTransferOf = (run: object | undefined) => (run as { dutyTransfer?: unknown } | undefined)?.dutyTransfer;
const world = (label: string) => menuWorld(database().db, label);
const LATER = '2026-10-20';

/** 一名被转交人 + 一条到期的下属转交。 */
async function scheduledFor(x: Awaited<ReturnType<typeof world>>, holderId: string, name: string) {
  const subordinate = await x.subordinateOf(holderId, `${name}的下属`);
  const receiver = await x.peer(`${name}的接收人`);
  const saved = await x.submitted(holderId, {
    timing: 'scheduled',
    transferDate: LATER,
    items: [subordinateItem(subordinate.id, receiver.id)],
  });
  return { subordinate, receiver, recordId: saved.records[0]!.id };
}

describe('F-408 到期执行逐人兜底（DEC-052，第 2 轮 P3-1）', () => {
  it('前一名被转交人抛非业务异常：记入 errors 与次数、不记失败原因；后一名照常完成；下轮重试成功', async () => {
    const x = await world('fault-person');
    const second = await x.peer('第二被转交人');
    const plans = new Map([
      [x.employee.id, await scheduledFor(x, x.employee.id, '甲')],
      [second.id, await scheduledFor(x, second.id, '乙')],
    ]);
    // 调度按被转交人 ID 升序办理：让排在前面的那位出故障。
    const [faulty, healthy] = [...plans.keys()].sort();
    faults.holders.add(faulty!);
    try {
      const run = await x.runScheduler(`${LATER}T02:00:00Z`);
      expect(dutyTransferOf(run)).toMatchObject({
        completed: 1,
        failed: 0,
        errors: [{ employeeId: faulty, code: 'INTERNAL_ERROR' }],
      });
    } finally {
      faults.holders.clear();
    }
    const bad = plans.get(faulty!)!;
    const good = plans.get(healthy!)!;
    expect(await x.ledger(good.recordId)).toMatchObject({ status: 1 });
    expect(await x.managerOf(good.subordinate.id, LATER)).toBe(good.receiver.id);
    expect(await x.ledger(bad.recordId)).toEqual({ attempts: 1, failure: null, status: 0 });
    expect(await x.managerOf(bad.subordinate.id, LATER)).toBe(faulty);

    const again = await x.runScheduler(`${LATER}T03:00:00Z`);
    expect(dutyTransferOf(again)).toMatchObject({ completed: 1, errors: [] });
    expect(await x.ledger(bad.recordId)).toMatchObject({ attempts: 2, status: 1, failure: null });
    expect(await x.managerOf(bad.subordinate.id, LATER)).toBe(bad.receiver.id);
  });

  it('某租户的到期转交整步抛错：调度不中断，其他租户照常完成，结果里标出出错租户', async () => {
    const broken = await world('fault-tenant-a');
    await scheduledFor(broken, broken.employee.id, '甲');
    const fine = await world('fault-tenant-b');
    const plan = await scheduledFor(fine, fine.employee.id, '乙');
    const decoy = await world('fault-tenant-c');
    await scheduledFor(decoy, decoy.employee.id, '丙');
    faults.tenants.add(broken.session.tenant.id);
    faults.tenants.add(decoy.session.tenant.id);
    try {
      const result = await runEmploymentActivations(
        database().db,
        cmd(),
        {},
        { clock: () => new Date(`${LATER}T02:00:00Z`) },
      );
      const byTenant = new Map(result.runs.map((run) => [run.tenantId, run]));
      for (const tenant of [broken, decoy])
        expect(dutyTransferOf(byTenant.get(tenant.session.tenant.id))).toMatchObject({
          completed: 0,
          errors: [{ employeeId: null, code: 'INTERNAL_ERROR' }],
        });
      expect(dutyTransferOf(byTenant.get(fine.session.tenant.id))).toMatchObject({ completed: 1, errors: [] });
    } finally {
      faults.tenants.clear();
    }
    expect(await fine.ledger(plan.recordId)).toMatchObject({ status: 1 });
  });
});

/** 同类定时任务（组织调整执行 MAX_GROUP_ATTEMPTS、360 凭据维护 FAILING_ATTEMPTS）的出错上限。 */
const ERROR_ATTEMPTS = 5;

describe('F-448 非业务异常的重试上限（DEC-052，第 2 轮交叉审 P3-4）', () => {
  /** 两名被转交人，排在前面的那位持续出非业务异常，执行次数预置为 attempts。 */
  async function stuck(label: string, attempts: number) {
    const x = await world(label);
    const second = await x.peer('第二被转交人');
    const plans = new Map([
      [x.employee.id, await scheduledFor(x, x.employee.id, '甲')],
      [second.id, await scheduledFor(x, second.id, '乙')],
    ]);
    const [faulty, healthy] = [...plans.keys()].sort();
    await x.sqlRows(sql`UPDATE duty_transfer_records SET attempt_count=${attempts}
      WHERE tenant_id=${x.session.tenant.id} AND id=${plans.get(faulty!)!.recordId}::uuid RETURNING id`);
    return { x, faulty: faulty!, bad: plans.get(faulty!)!, good: plans.get(healthy!)! };
  }

  it('累计到上限：转为失败（带原因、仍未完成），之后不再重试；同租户另一名照常完成', async () => {
    const { x, faulty, bad, good } = await stuck('cap', ERROR_ATTEMPTS - 2);
    faults.holders.add(faulty);
    try {
      const first = await x.runScheduler(`${LATER}T02:00:00Z`);
      expect(dutyTransferOf(first)).toMatchObject({ completed: 1, errors: [{ employeeId: faulty }] });
      expect(await x.ledger(bad.recordId)).toEqual({ attempts: ERROR_ATTEMPTS - 1, failure: null, status: 0 });

      const second = await x.runScheduler(`${LATER}T03:00:00Z`);
      expect(dutyTransferOf(second)).toMatchObject({ errors: [{ employeeId: faulty }] });
      expect(await x.ledger(bad.recordId)).toEqual({ attempts: ERROR_ATTEMPTS, failure: 'EXECUTION_ERROR', status: 0 });

      const third = await x.runScheduler(`${LATER}T04:00:00Z`);
      expect(dutyTransferOf(third)).toMatchObject({ completed: 0, failed: 0, errors: [] });
      expect(await x.ledger(bad.recordId)).toMatchObject({ attempts: ERROR_ATTEMPTS, failure: 'EXECUTION_ERROR' });
    } finally {
      faults.holders.clear();
    }
    const failed = (await x.records('tab=pending')).items.find((row) => row.id === bad.recordId);
    expect(failed).toMatchObject({ status: 0, transferTime: null, failure: { code: 'EXECUTION_ERROR', rule: null } });
    expect(failed!.failure!.message).not.toBe('');
    expect(await x.managerOf(bad.subordinate.id, LATER)).toBe(faulty);
    expect(await x.ledger(good.recordId)).toMatchObject({ status: 1 });
  });

  it('记次 / 落账本身出错：errors 里另记 ATTEMPT_COUNT_FAILED、执行次数不变，同租户另一名照常完成，下轮再记', async () => {
    const { x, faulty, bad, good } = await stuck('cap-count-fault', ERROR_ATTEMPTS - 1);
    faults.holders.add(faulty);
    faults.failedAudit.add(faulty);
    try {
      const run = await x.runScheduler(`${LATER}T02:00:00Z`);
      expect(dutyTransferOf(run)).toMatchObject({
        completed: 1,
        errors: [
          { employeeId: faulty, code: 'INTERNAL_ERROR' },
          { employeeId: faulty, code: 'ATTEMPT_COUNT_FAILED', cause: 'INTERNAL_ERROR' }, // F-454：记次失败不再静默
        ],
      });
    } finally {
      faults.failedAudit.clear();
    }
    expect(await x.ledger(bad.recordId)).toEqual({ attempts: ERROR_ATTEMPTS - 1, failure: null, status: 0 });
    expect(await x.ledger(good.recordId)).toMatchObject({ status: 1 });

    try {
      await x.runScheduler(`${LATER}T03:00:00Z`);
    } finally {
      faults.holders.clear();
    }
    expect(await x.ledger(bad.recordId)).toEqual({ attempts: ERROR_ATTEMPTS, failure: 'EXECUTION_ERROR', status: 0 });
  });
});

describe('F-454 重试预算、按条记次与参与人锁', () => {
  /** 一名被转交人（x.employee）名下两条同日到期的下属转交，另一名被转交人一条（用来核对不被打断）。 */
  async function twoRecords(label: string) {
    const x = await world(label);
    const first = await scheduledFor(x, x.employee.id, '甲一');
    const second = await scheduledFor(x, x.employee.id, '甲二');
    return { x, first, second };
  }

  it('覆盖 = 新提交：attempt_count 清零；到过上限前一档的记录被覆盖后，下一次瞬时异常只记 1 次、不直接永久失败', async () => {
    const x = await world('override-reset');
    const plan = await scheduledFor(x, x.employee.id, '甲');
    await x.sqlRows(sql`UPDATE duty_transfer_records SET attempt_count=${ERROR_ATTEMPTS - 1}
      WHERE tenant_id=${x.session.tenant.id} AND id=${plan.recordId}::uuid RETURNING id`);
    const pending = (await x.duties(x.employee.id)).items[0]!.pending!;
    const other = await x.peer('新接收人');
    await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [subordinateItem(plan.subordinate.id, other.id, pending.revision)],
    });
    expect(await x.ledger(plan.recordId)).toEqual({ attempts: 0, failure: null, status: 0 });

    faults.holders.add(x.employee.id);
    try {
      await x.runScheduler(`${LATER}T02:00:00Z`);
    } finally {
      faults.holders.clear();
    }
    expect(await x.ledger(plan.recordId)).toEqual({ attempts: 1, failure: null, status: 0 });
  });

  it('业务失败不占重试预算：已有非业务异常次数的记录遇业务失败仍记业务原因；覆盖后重新从 0 计', async () => {
    const x = await world('business-no-budget');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('将离职的接收人');
    const other = await x.peer('新接收人');
    const saved = await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [subordinateItem(subordinate.id, receiver.id)],
    });
    const recordId = saved.records[0]!.id;
    await x.sqlRows(sql`UPDATE duty_transfer_records SET attempt_count=${ERROR_ATTEMPTS - 1}
      WHERE tenant_id=${x.session.tenant.id} AND id=${recordId}::uuid RETURNING id`);
    x.setNow('2026-10-17T02:00:00Z');
    await x.effectiveExit(receiver.id, '2026-10-15');

    const first = await x.runScheduler(`${LATER}T02:00:00Z`);
    expect(dutyTransferOf(first)).toMatchObject({ failed: 1, errors: [] });
    expect(await x.ledger(recordId)).toMatchObject({ failure: 'VALIDATION_FAILED', status: 0 });

    x.setNow(`${LATER}T06:00:00Z`);
    const pending = (await x.duties(x.employee.id)).items[0]!.pending!;
    await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: '2026-10-25',
      items: [subordinateItem(subordinate.id, other.id, pending.revision)],
    });
    faults.holders.add(x.employee.id);
    try {
      await x.runScheduler('2026-10-25T02:00:00Z');
    } finally {
      faults.holders.clear();
    }
    expect(await x.ledger(recordId)).toEqual({ attempts: 1, failure: null, status: 0 });
  });

  it('同一人名下一条抛异常：只给抛错的那条计次，同日的另一条整人回滚但不占预算', async () => {
    const { x, first, second } = await twoRecords('only-throwing');
    faults.subordinates.add(second.subordinate.id);
    try {
      const run = await x.runScheduler(`${LATER}T02:00:00Z`);
      expect(dutyTransferOf(run)).toMatchObject({ completed: 0, errors: [{ employeeId: x.employee.id }] });
    } finally {
      faults.subordinates.clear();
    }
    expect(await x.ledger(second.recordId)).toEqual({ attempts: 1, failure: null, status: 0 });
    expect(await x.ledger(first.recordId)).toEqual({ attempts: 0, failure: null, status: 0 });
    expect(await x.managerOf(first.subordinate.id, LATER)).toBe(x.employee.id);
  });

  it('抛错的那条累计到上限：只它落账为 EXECUTION_ERROR，同日另一条不受连累，之后照常完成', async () => {
    const { x, first, second } = await twoRecords('cap-only-throwing');
    await x.sqlRows(sql`UPDATE duty_transfer_records SET attempt_count=${ERROR_ATTEMPTS - 1}
      WHERE tenant_id=${x.session.tenant.id} AND id=${second.recordId}::uuid RETURNING id`);
    faults.subordinates.add(second.subordinate.id);
    try {
      await x.runScheduler(`${LATER}T02:00:00Z`);
    } finally {
      faults.subordinates.clear();
    }
    expect(await x.ledger(second.recordId)).toEqual({
      attempts: ERROR_ATTEMPTS,
      failure: 'EXECUTION_ERROR',
      status: 0,
    });
    expect(await x.ledger(first.recordId)).toEqual({ attempts: 0, failure: null, status: 0 });

    const again = await x.runScheduler(`${LATER}T03:00:00Z`);
    expect(dutyTransferOf(again)).toMatchObject({ completed: 1, errors: [] });
    expect(await x.ledger(first.recordId)).toMatchObject({ attempts: 1, status: 1 });
    expect(await x.managerOf(first.subordinate.id, LATER)).toBe(first.receiver.id);
  });

  it('整人级步骤出错（取参与人锁）定位不到具体记录：按整人口径，该人全部到期记录一起记次', async () => {
    const { x, first, second } = await twoRecords('whole-person');
    faults.locks.set(x.employee.id, ['throw']);
    try {
      const run = await x.runScheduler(`${LATER}T02:00:00Z`);
      expect(dutyTransferOf(run)).toMatchObject({ completed: 0, errors: [{ employeeId: x.employee.id }] });
    } finally {
      faults.locks.clear();
    }
    expect(await x.ledger(first.recordId)).toEqual({ attempts: 1, failure: null, status: 0 });
    expect(await x.ledger(second.recordId)).toEqual({ attempts: 1, failure: null, status: 0 });
  });

  it('记次先取参与人锁：被菜单提交 / 联动占用（skipLocked 报 busy）时本轮不记，下一轮再记', async () => {
    const x = await world('count-lock-busy');
    const plan = await scheduledFor(x, x.employee.id, '甲');
    faults.holders.add(x.employee.id);
    faults.locks.set(x.employee.id, ['real', 'busy']); // 第 1 次 = 到期执行取锁；第 2 次 = 记次取锁
    try {
      const run = await x.runScheduler(`${LATER}T02:00:00Z`);
      expect(dutyTransferOf(run)).toMatchObject({ errors: [{ employeeId: x.employee.id, code: 'INTERNAL_ERROR' }] });
      expect(await x.ledger(plan.recordId)).toEqual({ attempts: 0, failure: null, status: 0 });

      await x.runScheduler(`${LATER}T03:00:00Z`);
    } finally {
      faults.holders.clear();
      faults.locks.clear();
    }
    expect(await x.ledger(plan.recordId)).toEqual({ attempts: 1, failure: null, status: 0 });
  });
});
