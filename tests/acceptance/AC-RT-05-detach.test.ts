/**
 * R2-T04 BE-5a 第 1 轮返工 P2-2 / P2-3（均走真实退休入口 POST retirements/employees/:id，不用可信造数）：
 * P2-2 已有未来直接调动时办理退休：生效摘下同周期排在其后的调动（与离职同，§5.8），覆盖校验触发器不再 23514；
 *      同日中间插入（退休排在同日已落地的调动之前）同样放行。
 * P2-3 实际退休日期的审计旧值取写入前的真实人事快照：首次为空；退休 → 返聘 → 再次退休时是上一次的实际退休日期。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { dedicatedBody, retirementWorld, type RetirementWorld } from './AC-RT-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => retirementWorld(database().db, label, TODAY);

/** 专用入口办理直接退休；断言 201。 */
async function retireDirect(x: RetirementWorld, lastWorkDate: string) {
  const { revision } = await x.session.getEmployee(x.employee.id);
  const response = await x.session.request('POST', `/retirements/employees/${x.employee.id}`, {
    ifMatch: revision,
    body: dedicatedBody(lastWorkDate, 'direct'),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string; status: string };
}

async function landedTransfer(x: RetirementWorld, effectiveDate: string) {
  const { revision } = await x.session.getEmployee(x.employee.id);
  const transfer = await x.session.business(
    x.employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate, fields: { departmentId: x.to.id } },
    revision,
  );
  expect(transfer.status).toBe('effective');
  return transfer;
}

describe('AC-RT-05 P2-2 已有未来直接调动时办理退休', () => {
  it('未来日期调动：退休生效，调动被摘下时间轴并记台账，不再 500', async () => {
    const x = await world('rt-detach-future');
    const transfer = await landedTransfer(x, '2026-10-20');
    const retire = await retireDirect(x, '2026-10-05');
    expect(retire.status).toBe('effective');
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'retirement']);
    expect((await x.effects(retire.id)).filter((row) => row.kind === 'future_transfer_detached')).toMatchObject([
      { phase: 'effective', target_id: transfer.id },
    ]);
  });

  it('同日中间插入：退休（计划日更早）插到同日已落地的调动之前，放行并摘下该调动', async () => {
    const x = await world('rt-detach-sameday');
    const transfer = await landedTransfer(x, TODAY);
    // L = 10-04 → 计划日 10-05 < 调动计划日 10-06，迟到顺延到今天，按 C-3 排在同日调动之前
    const retire = await retireDirect(x, '2026-10-04');
    expect(retire.status).toBe('effective');
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'retirement']);
    expect((await x.effects(retire.id)).filter((row) => row.kind === 'future_transfer_detached')).toMatchObject([
      { target_id: transfer.id },
    ]);
  });
});

describe('AC-RT-05 P2-3 实际退休日期审计旧值', () => {
  it('首次退休旧值为空；退休 → 返聘 → 再次退休，旧值 = 第一次的实际退休日期', async () => {
    const x = await world('rt-audit-before');
    const first = await retireDirect(x, '2026-10-05');
    expect((await x.audits(first.id, 'retirement.actual_date.synced'))[0]!.before).toMatchObject({
      actualRetirementDate: null,
    });
    expect((await x.retirementDates()).actual).toBe(TODAY);

    x.setNow('2026-10-10T01:00:00Z');
    const { revision } = await x.session.getEmployee(x.employee.id);
    const rehire = await x.session.business(
      x.employee.id,
      { kind: 'retire_rehire', mode: 'direct', effectiveDate: '2026-10-10', fields: { departmentId: x.to.id } },
      revision,
    );
    expect(rehire.status).toBe('effective');

    x.setNow('2026-10-20T01:00:00Z');
    const second = await retireDirect(x, '2026-10-19');
    expect(second.status).toBe('effective');
    expect((await x.audits(second.id, 'retirement.actual_date.synced'))[0]).toMatchObject({
      before: { actualRetirementDate: TODAY },
      after: { actualRetirementDate: '2026-10-20' },
    });
    expect((await x.retirementDates()).actual).toBe('2026-10-20');
  });
});
