import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { rehireWorld } from './AC-EMP-F432-rehire-support.js';

const db = useTestDb();
it.each([0, 1])(
  'AC-EMP-F432-11：撤销已生效重聘恢复自动写入前 %s，关闭开关不影响回退，保留其他编辑与审计',
  async (manual) => {
    const w = await rehireWorld(db().db, `restore-${manual}`);
    const prior = await w.departed();
    await w.setting(true);
    const auto = await w.create(prior.e.id, manual);
    expect(auto.record?.fields.workYearCompanyBefore).toBe(3);
    const edit = await w.s.request('PATCH', `/records/${auto.id}`, {
      ifMatch: auto.revision,
      body: { fields: { remarks: '撤销前的合成备注' } },
    });
    expect(edit.status, await edit.clone().text()).toBe(200);
    await w.setting(false);
    const current = await w.saved(auto.id);
    const commandId = randomUUID();
    // 既有契约：已生效任职的撤销使用 delete；revoke 仅对未审批完成申请开放。
    const cancel = () =>
      w.s.request('DELETE', `/businesses/${auto.id}`, {
        ifMatch: current.revision,
        idempotencyKey: commandId,
        body: {},
      });
    const cancelled = await cancel();
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    const after = await w.saved(auto.id);
    expect(after.fields.workYearCompanyBefore).toBe(manual);
    expect(after).toMatchObject({ status: 'deleted', record: null, fields: { remarks: '撤销前的合成备注' } });
    expect(await w.versions(auto.id)).toEqual([manual, 3, 3, manual]);
    expect((await cancel()).status).toBe(200);
    expect(await w.versions(auto.id)).toEqual([manual, 3, 3, manual]);
    expect((await w.s.record(prior.leave.id)).fields.workYearCompanyBefore).toBe(2);
    await withTenant(db().db, w.s.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT before,after FROM audit_events
      WHERE tenant_id=${w.s.tenant.id} AND object_id=${auto.id}
        AND action='employment.rehire.seniority.restore'`);
      const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
      expect(rows).toEqual([{ before: { workYearCompanyBefore: 3 }, after: { workYearCompanyBefore: manual } }]);
    });
  },
);
