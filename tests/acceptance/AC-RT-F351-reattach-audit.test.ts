/**
 * F-351 ⑥：退休路径的两条回归（F-400 R1 把离职侧同名用例改成“作废”断言后，退休侧失去了挂回 / 删除审计的覆盖）。
 * DEC-725③ 只让离职生效时作废晚于 L 的已落地调动；退休只摘下、不作废（R2-T03 设计 §5.8），所以：
 * - 撤销已生效退休 → 被摘下的未来调动按台账窗口挂回原位，清单列“已挂回”；
 * - 被退休摘下的调动再被 HR 删除 → 审计 before 取最新记录快照（编辑后的备注），不回退首版。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { retirementCancelWorld, type RetirementCancelWorld } from './AC-RT-cancel-support.js';
import { retireBody } from './AC-RT-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => retirementCancelWorld(database().db, label, TODAY);

async function futureTransfer(x: RetirementCancelWorld, effectiveDate: string, fields: object) {
  const employee = await x.session.getEmployee(x.employee.id);
  return x.session.business(
    x.employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate, fields },
    employee.revision,
  );
}

describe('F-351 撤销已生效退休：挂回被摘下的未来调动', () => {
  it('退休生效摘下 T（不作废）→ 撤销退休：T 按台账窗口挂回，员工不再读为退休；清单列出“已挂回”', async () => {
    const x = await world('f351-reattach');
    const transfer = await futureTransfer(x, '2026-10-25', { departmentId: x.to.id });
    const retire = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    expect(retire.status).toBe('effective');
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'retirement']);
    // 退休只摘下、不作废：T 仍是 effective，也没有墓碑
    expect(await x.stateOfBusiness(transfer.id)).toBe('effective');
    expect(await x.tombstoned(transfer.id)).toBe(false);

    const result = await x.retireCancelled(retire.id, {});

    expect((await x.timeline()).map((row) => [row.kind, row.valid])).toEqual([
      ['hire', '[2026-09-01,2026-10-25)'],
      ['transfer', '[2026-10-25,)'],
    ]);
    expect(await x.stateOfBusiness(transfer.id)).toBe('effective');
    const reattached = result.downstream.additional.find((entry) => entry.kind === 'future_transfer_detached')!;
    expect(reattached).toMatchObject({ action: 'reattached' });
    expect(reattached.targets.map((target) => target.id)).toEqual([transfer.id]);
    // 台账只追加：摘下记录仍在，也没有作废记录
    const kinds = (await x.effects(retire.id)).map((row) => row.kind);
    expect(kinds).toContain('future_transfer_detached');
    expect(kinds).not.toContain('application_voided');
  });
});

describe('F-351 删除被退休摘下的调动：审计 before 取最新记录快照', () => {
  it('备注 before-edit 改为 after-edit 后被退休摘下再删除：delete.before 为新值，版本 ID 对应同一内容', async () => {
    const x = await world('f351-detach-audit');
    const transfer = await futureTransfer(x, '2026-10-25', { departmentId: x.to.id, remarks: 'before-edit' });
    const edited = await x.session.request('PATCH', `/records/${transfer.id}`, {
      ifMatch: transfer.revision,
      body: { fields: { remarks: 'after-edit' } },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const retire = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    expect(retire.status).toBe('effective');
    x.setNow('2026-10-26T01:00:00Z');

    const current = await x.business(transfer.id);
    const deleted = await x.session.request('DELETE', `/businesses/${transfer.id}`, { ifMatch: current.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const [audit] = await x.audits(transfer.id, 'employment.record.delete');
    const before = audit!.before as Record<string, unknown>;
    expect(before.remarks).toBe('after-edit');
    const [version] = await x.sqlRows<{ remarks: string | null }>(sql`SELECT remarks FROM employment_payload_versions
      WHERE tenant_id=${x.session.tenant.id} AND id=${String(before.payloadVersionId)}::uuid`);
    expect(version!.remarks).toBe(before.remarks);
  });
});
