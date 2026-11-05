/**
 * F-429 ① 离职生效撤回在途合同申请：站内消息按 F-400 任职类终止口径发给“发起人 + 申请人”（去重）。
 * 设计 R2-T03 §5.5：合同申请通知与任职申请作废通知同收件人；此前只通知发起人，申请人看不到申请被撤回。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { setExitTermination } from './support/exit-termination.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const TEMPLATE = 'contract_request_voided_by_exit';

async function pendingRequest(x: Awaited<ReturnType<typeof downstreamWorld>>) {
  await setExitTermination(database().db, x.session.tenant.id, x.session.user.id, { contract_create: true });
  const type = await x.contractType('保密协议');
  const created = await x.createContract(type, {}, 'application');
  return created.id as string;
}

describe('F-429 ① 合同申请被离职撤回的通知收件人', () => {
  it('申请人与发起人各收到一条站内消息，重试生效被拒后不重复发送', async () => {
    const x = await downstreamWorld(database().db, 'f429-notice', TODAY);
    const applicant = await x.applicantAccount(x.employee.id);
    const requestId = await pendingRequest(x);
    const instance = (await x.instanceOf(requestId))!;
    const leave = await x.directLeave('2026-10-05');

    expect(await x.activate(leave.id, TODAY)).toMatchObject({ outcome: 'effective' });

    expect((await x.requestRows()).find((row) => row.id === requestId)!.status).toBe('withdrawn');
    expect(await x.notices(instance.id)).toEqual(
      [instance.initiator, applicant].sort().map((recipient) => ({ recipient, template: TEMPLATE, kind: 'message' })),
    );
    await expect(x.activate(leave.id, TODAY)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await x.notices(instance.id)).toHaveLength(2);
  });

  it('申请人就是发起人时只发一条', async () => {
    const x = await downstreamWorld(database().db, 'f429-notice-same', TODAY);
    const requestId = await pendingRequest(x);
    const instance = (await x.instanceOf(requestId))!;
    await x.sqlRows(sql`DELETE FROM permission_user_person_links
      WHERE tenant_id=${x.session.tenant.id} AND employee_id=${x.employee.id}::uuid`);
    await x.sqlRows(sql`INSERT INTO permission_user_person_links(tenant_id,user_id,employee_id)
      VALUES (${x.session.tenant.id}, ${instance.initiator}::uuid, ${x.employee.id}::uuid)`);
    const leave = await x.directLeave('2026-10-05');

    expect(await x.activate(leave.id, TODAY)).toMatchObject({ outcome: 'effective' });

    expect(await x.notices(instance.id)).toEqual([
      { recipient: instance.initiator, template: TEMPLATE, kind: 'message' },
    ]);
  });
});
