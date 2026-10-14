import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../apps/web/src/foundation/client.js';
import { approvalCommand, approvalList, visibleActions } from '../../apps/web/src/approval/api.js';
import type { ApprovalDetail } from '../../apps/web/src/approval/types.js';
import { transferRequest } from '../../apps/web/src/transfer/api.js';

const api = createApiClient(() => ({ tenantId: 'synthetic-tenant', identityKey: 'synthetic-user' }));
const detail: ApprovalDetail = {
  id: 'instance-1',
  title: '合成调动申请',
  revision: 7,
  status: 'running',
  approvalType: 'transfer',
  actions: ['approve', 'reject', 'transfer', 'withdraw'],
  form: { values: { effectiveDate: '2026-11-01' } },
  tasks: [],
  logs: [],
  recordsHidden: false,
};
afterEach(() => vi.unstubAllGlobals());

describe('AC-FE-R1c-01 / AC-APV-05 审批命令契约', () => {
  it('同意携带实例 revision 和固定命令 ID，不把表单字段拼回请求', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ instanceId: detail.id })));
    vi.stubGlobal('fetch', fetcher);
    const command = approvalCommand(detail, 'approve', 'task-1', { comment: '同意' });
    await api.request(command.path, { method: 'POST', command: command.command });
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe('/api/tenant/approval/tasks/task-1/approve');
    expect(new Headers(init.headers).get('if-match')).toBe('7');
    expect(new Headers(init.headers).get('idempotency-key')).toBe(command.command.id);
    expect(JSON.parse(init.body)).toEqual({ comment: '同意' });
  });
  it('撤销走实例接口；转交规范化账号 UUID', () => {
    expect(approvalCommand(detail, 'withdraw').path).toBe('/api/tenant/approval/instances/instance-1/withdraw');
    const target = 'ABCDEFAB-0000-4000-8000-000000000001';
    expect(approvalCommand(detail, 'transfer', 'task-1', { toUserId: target }).command.body).toEqual({
      toUserId: target.toLowerCase(),
      comment: null,
    });
  });
  it('无动作权、无待办 ID、非法转交账号均不产生请求', () => {
    expect(visibleActions({ ...detail, actions: ['adminTransfer', 'transfer'] })).toEqual(['transfer']);
    expect(() => approvalCommand({ ...detail, actions: [] }, 'approve', 'task-1')).toThrow();
    expect(() => approvalCommand(detail, 'approve')).toThrow();
    expect(() => approvalCommand(detail, 'transfer', 'task-1', { toUserId: 'employee-id' })).toThrow();
  });
  it('未知结果与 revision 冲突不自动重试', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: { code: 'REVISION_CONFLICT' } }), { status: 409 }));
    vi.stubGlobal('fetch', fetcher);
    const request = approvalCommand(detail, 'reject', 'task-1');
    await expect(api.request(request.path, { method: 'POST', command: request.command })).rejects.toMatchObject({
      kind: 'refresh',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('AC-FE-R1c-02 我的列表', () => {
  it('待办与我发起使用对应接口和服务端分页', async () => {
    const request = vi.fn().mockResolvedValue({ items: [{ taskId: 't', instanceId: 'i', title: '申请' }] });
    const result = await approvalList({ request }, 'pending', { page: 2, pageSize: 20 });
    expect(request.mock.calls[0]![0]).toBe('/api/tenant/approval/todos?page=2&pageSize=20');
    expect(result.items[0]).toMatchObject({ id: 'i', taskId: 't' });
    await approvalList({ request }, 'initiated', { page: 1, pageSize: 20 });
    expect(request.mock.calls[1]![0]).toContain('role=initiated');
  });
  it('已办演示适配不以 participated 冒充已办，不请求真实接口', async () => {
    const request = vi.fn();
    const result = await approvalList({ request }, 'completed', { page: 1, pageSize: 20 });
    expect(result.demo).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('AC-FE-R1c-05 调动复用底座客户端', () => {
  it('网络结果未知仍返回既有调动错误类型和状态，供表单阻止盲重放', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(transferRequest('synthetic-tenant', '/api/tenant/employment/transfers/catalog')).rejects.toMatchObject(
      { code: 'NETWORK_ERROR', status: 503 },
    );
  });
  it('既有调动写入保留幂等键和 revision，不改变请求体', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'business-1' })));
    vi.stubGlobal('fetch', fetcher);
    await transferRequest('synthetic-tenant', '/api/tenant/employment/transfers/employees/employee-1', {
      method: 'POST',
      body: JSON.stringify({ fields: { place: '合成工作地' } }),
      headers: { 'if-match': '8', 'idempotency-key': 'original-command' },
    });
    const init = fetcher.mock.calls[0]![1];
    expect(new Headers(init.headers).get('if-match')).toBe('8');
    expect(new Headers(init.headers).get('idempotency-key')).toBe('original-command');
    expect(JSON.parse(init.body)).toEqual({ fields: { place: '合成工作地' } });
  });
});
