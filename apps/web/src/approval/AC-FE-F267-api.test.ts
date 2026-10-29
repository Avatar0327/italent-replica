import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestWorld, type RequestWorld } from '../../../../tests/acceptance/AC-PT-request-support.js';
import { createApiClient, newCommand } from '../foundation/client.js';
import { acceptReceipt, approvalFailure, approvalRequest, readApproval } from './api.js';
import { editValues } from './edit-model.js';
import type { ApprovalDetail } from './types.js';

const database = useTestDb();
afterEach(() => vi.unstubAllGlobals());

/** 沿用 F-291 的租户与真实 HTTP 路由夹具；不替换详情、命令回执或业务校验。 */
function client(w: RequestWorld, userId: string) {
  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    return w.request(userId, init?.method ?? 'GET', path, {
      ifMatch: headers.get('if-match') ?? undefined,
      idempotencyKey: headers.get('idempotency-key'),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
  });
  return createApiClient(() => ({ tenantId: w.tenant.id, identityKey: userId }));
}

async function scene(kind: 'add' | 'extend' | 'end', separate = false) {
  const w = await requestWorld(database().db, `f267-${kind}`, separate ? { editMode: 'separate' } : {});
  let created;
  if (kind === 'add') created = await w.create({ endDate: null });
  else if (kind === 'extend') created = await w.extend(await w.seedRecord(), '2026-12-31', '合成延长原因');
  else created = await w.end(await w.seedRecord({ endDate: '2026-12-31' }), '2026-10-15');
  await w.send(created.id, created.revision);
  const view = await w.instance(created.id);
  const task = w.pending(view)[0]!;
  const api = client(w, task.assigneeUserId);
  const detail = await readApproval(api, view.id);
  expect(detail.form.edit?.taskId).toBe(task.id);
  for (const field of detail.form.edit!.fields) expect(field.value).toEqual(detail.form.values[field.key] ?? null);
  return { w, created, task, api, detail };
}

describe('AC-FE-F267 对接 F-291 真接口', () => {
  it.each(['add', 'extend', 'end'] as const)('%s：真实详情经前端投影提交 fields 和 comment', async (kind) => {
    const { w, created, task, api, detail } = await scene(kind);
    expect(detail.form.edit?.mode).toBe('with_approve');
    const values = editValues(detail, 'approve');
    // 与表单的未知字段只读策略一致，不把未提供控件的字段回传。
    delete values.isDepartmentHead;
    const request = approvalRequest(detail, 'approve', '过期待办编号', {
      ...values,
      endDate: kind === 'end' ? '2026-10-16' : '2027-01-31',
      comment: '合成审批意见',
      undisclosed: '不应提交',
    });
    expect(request.path).toBe(`/api/tenant/approval/tasks/${task.id}/approve`);
    expect(request.body.fields).not.toHaveProperty('undisclosed');
    expect(request.body.fields).not.toHaveProperty('isDepartmentHead');
    const receipt = await api.request<ApprovalDetail>(request.path, {
      method: 'POST',
      command: newCommand(request.body, detail.revision),
    });
    expect(acceptReceipt(receipt, detail.id, detail.revision)).toBeDefined();
    expect(receipt.tasks.find((item) => item.id === task.id)).toMatchObject({
      status: 'approved',
      comment: '合成审批意见',
    });
    expect((await w.load(created.id)).version.endDate).toBe(request.body.fields!.endDate);
  });

  it('separate：真实 edit 回执保留待办，随后同意只带意见', async () => {
    const { w, created, task, api, detail } = await scene('extend', true);
    expect(detail.form.edit?.mode).toBe('separate');
    expect(detail.actions).toContain('edit');
    const request = approvalRequest(detail, 'edit', undefined, {
      endDate: '2027-01-31',
      requestRemark: '独立编辑合成备注',
      comment: '不应提交',
    });
    expect(Object.keys(request.body)).toEqual(['fields']);
    const receipt = await api.request<ApprovalDetail>(request.path, {
      method: 'POST',
      command: newCommand(request.body, detail.revision),
    });
    expect(receipt.tasks.find((item) => item.id === task.id)?.status).toBe('pending');
    expect((await w.load(created.id)).version).toMatchObject({
      endDate: '2027-01-31',
      remark: '独立编辑合成备注',
    });
    const approval = approvalRequest(receipt, 'approve', undefined, { endDate: '不应提交', comment: '合成意见' });
    expect(approval.body).toEqual({ comment: '合成意见' });
    const approved = await api.request<ApprovalDetail>(approval.path, {
      method: 'POST',
      command: newCommand(approval.body, receipt.revision),
    });
    expect(approved.tasks.find((item) => item.id === task.id)?.status).toBe('approved');
  });

  it('真实 403 FORBIDDEN 信封保留服务端拒绝原因', async () => {
    const { w, task, api, detail } = await scene('extend');
    await expect(
      api
        .request(`/api/tenant/approval/tasks/${task.id}/approve`, {
          method: 'POST',
          command: newCommand({ fields: { departmentId: w.primary } }, detail.revision),
        })
        .catch((error: unknown) => {
          throw approvalFailure(error);
        }),
    ).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: '只能编辑本节点开放且您可查看的字段',
    });
  });
});
