import './support/exit-gate-enforced.js';
import { withTenant } from '@italent/db';
import { randomUUID } from 'node:crypto';
import { lockEmploymentEmployee } from '../../apps/api/src/modules/employment/record-store.js';
import { createEmploymentBusiness } from '../../apps/api/src/modules/employment/write-service.js';
import { waitForBlocked } from './support/pg-interleave.js';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';

const database = useTestDb();
it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  'F-140b2 P2-2：替代预锁失败职责下属，与其真实调动创建串行收敛',
  async () => {
    const x = await downstreamWorld(database().db, 'review-f140-approval-duty-race');
    await x.useTiming('approval_passed');
    const receiver = await x.peer('合成接收人');
    const sub = await x.subordinateOf(x.employee.id, '合成下属');
    const draft = await x.submittedLeave('2026-10-15');
    await x.planDuties(draft.id, [{ employeeId: sub.id, receiverId: receiver.id }]);
    const badLeave = await x.directLeave('2026-10-05', undefined, receiver.id);
    await x.runScheduler('2026-10-06T02:00:00Z');
    await x.approveInReview(draft.id);
    expect((await x.items(draft.id))[0]!.status).toBe('failed');
    await x.runScheduler('2026-10-16T02:00:00Z');
    x.setNow('2026-11-05T02:00:00Z');
    const cancelBad = await x.session.request('POST', `/exits/${badLeave.id}/cancel`, {
      ifMatch: (await x.business(badLeave.id)).revision,
      body: { reason: '合成恢复接收人' },
    });
    expect(cancelBad.status, await cancelBad.clone().text()).toBe(200);
    const currentSub = await x.session.getEmployee(sub.id);
    const revision = (await x.business(draft.id)).revision;
    let ready!: () => void, release!: () => void;
    const held = new Promise<void>((r) => {
      ready = r;
    });
    const released = new Promise<void>((r) => {
      release = r;
    });
    const moving = withTenant(x.db, x.session.tenant.id, async (tx) => {
      const ctx = {
        tenantId: x.session.tenant.id,
        userId: x.session.user.id,
        timezone: x.session.tenant.timezone,
        now: new Date('2026-11-05T02:00:00Z'),
        commandId: randomUUID(),
        expectedRevision: currentSub.revision,
      };
      // 生产创建入口的同一员工锁；仅在已持锁处设置交错屏障。
      await lockEmploymentEmployee(tx, ctx, sub.id, currentSub.revision);
      ready();
      await released;
      return createEmploymentBusiness(tx, ctx, sub.id, {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-11-10',
        fields: { departmentId: x.from.id, directManagerId: null },
      });
    });
    // 尽早消费拒绝，避免测试框架把确定性的 DB 死锁当成未处理 Promise。
    const movingResult = moving.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    await held;
    const replacing = x.session.request('PATCH', `/exits/${draft.id}`, {
      ifMatch: revision,
      body: { lastWorkDate: '2026-11-20' },
    });
    try {
      await waitForBlocked(x.db, 1);
    } finally {
      release();
    }
    const [first, second] = await Promise.all([replacing, movingResult]);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(second.ok, second.ok ? '' : String(second.error)).toBe(true);
    const result = await first.json();
    expect((await x.items(draft.id))[0]!.status).toBe('superseded');
    expect((await x.items(result.successor.id))[0]!.status).toBe('succeeded');
  },
);
