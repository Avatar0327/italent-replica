/**
 * BE-5d2 第 1 轮审查 P1-2（#456）真 PG 强制交错：写范围 / 授权复核必须在取得员工锁 → 申请行锁之后，用当前授权判定。
 * 事务 A 持员工锁；HR 发起审批中心撤回 / HR 直接修改并在锁上等待；管理员此时把其范围从 B 收窄到 A；释放锁后应被拒（404），
 * 完整快照不变。对照：不撤权时同样的交错成功。撤回 / 重提 / 修改共用同一入口 lockIntentionRows → requireIntentionRight。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { intentionWorld, type IntentionWorld } from './AC-RT-intention-support.js';
import { realUser } from './AC-RT-intention-real-support.js';
import { waitForBlocked } from './support/pg-interleave.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const APPROVAL = '/api/tenant/approval';

/** 持有该员工行锁直到 release()；locked 在拿到锁后兑现。 */
function holdEmployeeLock(w: IntentionWorld) {
  let release!: () => void;
  let acquired!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const locked = new Promise<void>((resolve) => (acquired = resolve));
  const done = withTenant(w.db, w.tenant.id, async (tx) => {
    await tx.execute(sql`SELECT 1 FROM employment_employees WHERE tenant_id=${w.tenant.id}
      AND id=${w.subject.employeeId}::uuid FOR UPDATE`);
    acquired();
    await gate;
  });
  return { locked, release: () => release(), done };
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-RT-20d 等锁期间撤权（真 PG）', () => {
  for (const revoke of [true, false]) {
    it(`审批中心撤回：持员工锁 → ${revoke ? '撤权（范围 B → A）→ 释放后拒绝 404' : '不撤权 → 释放后成功'}`, async () => {
      const w = await intentionWorld(database().db, `toctou-withdraw-${uniqueSuffix()}`);
      const operator = await realUser(w, 'HR操作人', { orgIds: [w.deptB] });
      const created = await operator.call('POST', `/retirement-intentions/employees/${w.subject.employeeId}`, {
        ifMatch: await w.revisionOf(),
        body: { intendedDate: '2030-03-01' },
      });
      const intention = (await created.json()) as { id: string; revision: number };
      expect(
        (await operator.call('POST', `/retirement-intentions/${intention.id}/submit`, { ifMatch: intention.revision }))
          .status,
      ).toBe(200);
      const instance = await w.instance(intention.id, operator.userId);

      const holder = holdEmployeeLock(w);
      await holder.locked;
      const pending = operator.call('POST', `${APPROVAL}/instances/${instance.id}/withdraw`, {
        ifMatch: instance.revision,
        body: {},
      });
      await waitForBlocked(w.db, 1);
      if (revoke) await operator.setScope([w.deptA]);
      // 撤权这条管理命令本身会写台账：快照取在撤权之后、释放锁之前，只比较被拒请求带来的变化
      const before = await w.footprint(intention.id);
      holder.release();
      await holder.done;
      const response = await pending;
      if (revoke) {
        expect(response.status, await response.clone().text()).toBe(404);
        expect(await w.footprint(intention.id)).toEqual(before);
        expect((await w.get(intention.id)).status).toBe('in_review');
      } else {
        expect(response.status, await response.clone().text()).toBe(200);
        expect((await w.get(intention.id)).status).toBe('withdrawn');
      }
    });
  }

  it('HR 直接修改：持员工锁 → 撤权 → 释放后拒绝 404，申请不变', async () => {
    const w = await intentionWorld(database().db, `toctou-patch-${uniqueSuffix()}`);
    const operator = await realUser(w, 'HR操作人', { orgIds: [w.deptB] });
    const created = await operator.call('POST', `/retirement-intentions/employees/${w.subject.employeeId}`, {
      ifMatch: await w.revisionOf(),
      body: { intendedDate: '2030-03-01' },
    });
    const draft = (await created.json()) as { id: string; revision: number };

    const holder = holdEmployeeLock(w);
    await holder.locked;
    const pending = operator.call('PATCH', `/retirement-intentions/${draft.id}`, {
      ifMatch: draft.revision,
      body: { reason: '改' },
    });
    await waitForBlocked(w.db, 1);
    await operator.setScope([w.deptA]);
    const before = await w.footprint(draft.id);
    holder.release();
    await holder.done;
    const response = await pending;
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await w.footprint(draft.id)).toEqual(before);
  });
});
