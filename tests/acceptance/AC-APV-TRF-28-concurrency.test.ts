/**
 * PR #35 第二轮清单 主题 A：审批与业务单的一致性与并发（AGENTS §10「并发」「幂等」）。
 * 1 审批中的单据不能从业务端改，实例绑定审批人所读的载荷版本；10 业务撤回入口同样只允许发起人；
 * 11 审批同意与业务撤回统一加锁顺序；14 processCode 由服务端派生；C-非5 撤回复核权限、催办限频。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { approvalWorld, TRANSFER_NODES, transferScene, type InstanceView } from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

function current(view: InstanceView) {
  const tasks = view.tasks.filter((task) => task.status === 'pending');
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

async function reasonOf(response: Response) {
  const body = (await response.json()) as { error?: { code: string; details?: { reason?: string } } };
  return { status: response.status, code: body.error?.code, reason: body.error?.details?.reason };
}

describe('清单 1：审批中的单据被修改后旧审批失效', () => {
  it('审批中业务端 PATCH 返回 409，单据保持原值并按原值生效', async () => {
    const w = await approvalWorld(database().db, 'apv-lock-patch');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!] });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to, place: '原地点' });
    const view = await w.submit(draft);
    const business = await w.business(draft.id);
    const patched = await w.request(w.hr.id, 'PATCH', `/api/tenant/employment/businesses/${draft.id}`, {
      ifMatch: business.revision,
      body: { fields: { place: '偷改地点' } },
    });
    expect(await reasonOf(patched)).toMatchObject({ status: 409, reason: 'APPROVAL_IN_PROGRESS' });
    const approved = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision),
    );
    expect(approved.status).toBe('approved');
    expect(await w.business(draft.id)).toMatchObject({ status: 'effective', fields: { place: '原地点' } });
  });

  it('实例绑定审批人所读的载荷版本：绕过审批改了载荷，携旧 revision 的同意返回 409', async () => {
    const w = await approvalWorld(database().db, 'apv-lock-version');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!] });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to, place: '原地点' });
    const view = await w.submit(draft);
    // 模拟任何绕过审批的写入路径（导入、夹具）追加了一版载荷。
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO employment_payload_versions
        SELECT (jsonb_populate_record(NULL::employment_payload_versions, to_jsonb(p) || jsonb_build_object(
          'id', gen_random_uuid(), 'version_no', p.version_no + 1, 'place', '绕过修改'))).*
        FROM employment_payload_versions p WHERE p.business_id=${draft.id}::uuid
        ORDER BY p.version_no DESC LIMIT 1`),
    );
    const stale = await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision);
    expect(await reasonOf(stale)).toMatchObject({ status: 409, reason: 'APPROVAL_BUSINESS_CHANGED' });
    expect((await w.detail(view.id)).status).toBe('running');
  });
});

describe('清单 10：业务撤回入口也只允许发起人', () => {
  it('非发起人经业务单撤回被拒，审批与申请都不变；发起人可撤回', async () => {
    const w = await approvalWorld(database().db, 'apv-withdraw-owner');
    const s = await transferScene(w);
    const other = await w.member('其他 HR');
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    const view = await w.submit(draft);
    const business = await w.business(draft.id);
    const path = `/api/tenant/employment/businesses/${draft.id}/withdraw`;
    const denied = await w.request(other, 'POST', path, { ifMatch: business.revision });
    expect(await reasonOf(denied)).toMatchObject({ status: 403, reason: 'APPROVAL_NOT_INITIATOR' });
    expect(await w.business(draft.id)).toMatchObject({ status: 'in_review' });
    expect((await w.detail(view.id)).status).toBe('running');
    const ok = await w.request(w.hr.id, 'POST', path, { ifMatch: business.revision });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await w.detail(view.id)).status).toBe('withdrawn');
  });

  it('C-非5：审批侧撤回时复核发起人当前的任职撤回权限', async () => {
    const w = await approvalWorld(database().db, 'apv-withdraw-perm');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const denyWithdraw: Authorizer = (request) =>
      !(request.action === 'object.button' && String(request.resource).includes('Employment.Withdraw'));
    const revoked = tenantApi(w.db, { authorize: denyWithdraw, clock: w.clock });
    const response = await revoked.request('POST', `${BASE}/instances/${view.id}/withdraw`, {
      ...w.as(w.hr.id),
      ifMatch: view.revision,
    });
    expect(response.status).toBe(403);
    expect((await w.detail(view.id)).status).toBe('running');
  });
});

describe('清单 11：审批同意与业务撤回统一加锁顺序', () => {
  it('最后节点同意与业务撤回并发：一方成功、另一方 409，不出现死锁或 500', async () => {
    const w = await approvalWorld(database().db, 'apv-lock-order');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!] });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    const view = await w.submit(draft);
    const business = await w.business(draft.id);
    const raced = await Promise.all([
      w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision),
      w.request(w.hr.id, 'POST', `/api/tenant/employment/businesses/${draft.id}/withdraw`, {
        ifMatch: business.revision,
      }),
    ]);
    const statuses = raced.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    const final = await w.detail(view.id);
    const after = await w.business(draft.id);
    if (final.status === 'approved') expect(after.status).toBe('effective');
    else expect([final.status, after.status]).toEqual(['withdrawn', 'draft']);
  });
});

describe('清单 14：processCode 由服务端按业务派生', () => {
  it('提交时不接受客户端指定的流程编码；实例使用审批类型的默认编码', async () => {
    const w = await approvalWorld(database().db, 'apv-process-code');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    const forged = await w.request(w.hr.id, 'POST', `/api/tenant/employment/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: { processCode: 'SomeOtherProcess' },
    });
    expect(forged.status).toBe(400);
    expect(await w.business(draft.id)).toMatchObject({ status: 'draft' });
    const view = await w.submit(draft);
    expect(view).toMatchObject({ status: 'running' });
    const stored = await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT process_code FROM approval_instances WHERE id=${view.id}::uuid`),
    );
    const rows = (Array.isArray(stored) ? stored : (stored as { rows: unknown[] }).rows) as { process_code: string }[];
    expect(rows[0]!.process_code).toBe('TransferProcessNew');
  });
});

describe('C-非5：催办频率限制', () => {
  it('同一实例 30 分钟内只能催办一次，到点后可再次催办', async () => {
    const w = await approvalWorld(database().db, 'apv-urge-limit');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.instanceAction(w.hr.id, view.id, 'urge', view.revision));
    const again = await w.instanceAction(w.hr.id, view.id, 'urge', view.revision, {});
    expect(await reasonOf(again)).toMatchObject({ status: 409, reason: 'APPROVAL_URGE_TOO_FREQUENT' });
    w.setNow('2026-10-01T01:31:00.000Z');
    const later = await w.request(w.hr.id, 'POST', `${BASE}/instances/${view.id}/urge`, {
      ifMatch: view.revision,
      idempotencyKey: randomUUID(),
    });
    expect(later.status, await later.clone().text()).toBe(200);
  });
});
