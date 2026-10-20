/**
 * R2 BE-8b2 真 PG 交错（DEC-632）：离职申请审批通过（发起交接）与撤销离职并发。
 * PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。两个事务都先取员工锁再取业务头，所以只有两种结果：
 * 审批先成功 → 撤销随后终止刚发起的交接；撤销先成功 → 审批失败、不发起。无论哪种，被撤销的离职下不留进行中 / 已完成的交接。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { FUTURE_LAST_WORK_DATE, handoverWorld, TODAY } from './AC-EXIT-handover-support.js';

const database = useTestDb();
const itPg = process.env.TEST_DATABASE_URL ? it : it.skip;

describe('离职交接并发（真 PG）', () => {
  itPg('审批通过与撤销离职并发：不留属于已撤销离职的进行中交接，且至多一张', async () => {
    const x = await handoverWorld(database().db, 'pg-approve-cancel');
    await x.addSettingItems();
    await x.publishHandoverProcess();
    const draft = await x.createdExit(x.employee.id, FUTURE_LAST_WORK_DATE, 'application', {
      exitTypeCode: 'voluntary',
      handoverEmployeeId: x.workOwner.employeeId,
    });
    const sent = await x.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    const current = await x.business(draft.id);
    const cancel = () =>
      x.session.request('POST', `/exits/${draft.id}/cancel`, {
        ifMatch: current.revision,
        body: { reason: '并发撤销' },
      });
    await Promise.allSettled([x.approve(draft, `${TODAY}T02:00:00Z`), cancel()]);
    const rows = await x.requestRows(draft.id);
    expect(rows.length).toBeLessThanOrEqual(1);
    const status = (await x.business(draft.id)).status;
    if (status !== 'approved') expect(rows.every((row) => row.state === 'terminated')).toBe(true);
  });
});
