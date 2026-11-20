/// <reference lib="dom" />
// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 只用动态导入既有模块：基线上按行为变红（刷新后丢锁），不是因缺新模块报错。期望值手写。
const secret = '合成敏感说明';
const offline = async () => {
  throw new TypeError('合成断网');
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  sessionStorage.clear();
});
/** F-120 真实接口形状（apps/api/src/modules/command-result/service.ts）。 */
const resultOf = (commandId: string, status: 'succeeded' | 'failed') => ({
  commandId,
  status,
  commandType: 'POST /api/tenant/employment/transfers',
  businessType: status === 'succeeded' ? 'transfer' : null,
  businessId: status === 'succeeded' ? 'synthetic-business' : null,
  revision: status === 'succeeded' ? 2 : null,
  httpStatus: status === 'succeeded' ? 200 : 422,
  completedAt: '2026-11-20T01:02:03.000Z',
});

describe('AC-FE-F110 自助调动抽屉刷新恢复', () => {
  it('AC-FE-F110-08 自助调动抽屉：刷新后仍只读、记录不含摘要原文，查询成功读回单据后解锁', async () => {
    const scope = JSON.stringify([randomUUID(), 'identity', 'manager']);
    const business = randomUUID();
    const command = {
      commandId: randomUUID(),
      employeeId: 'synthetic-employee',
      action: 'submit' as const,
      effectiveDate: '2026-11-02',
      summary: { fields: { note: secret } },
    };
    const before = await import('../../apps/web/src/self-service/pages/application-session.js');
    await expect(before.runApplicationCommand(scope, command, offline)).rejects.toThrow('处理中 / 结果待确认');
    const raw = sessionStorage.getItem('italent.commands.pending:transfer')!;
    expect(raw).toContain(command.commandId);
    expect(raw).not.toContain(secret);
    vi.resetModules();
    const after = await import('../../apps/web/src/self-service/pages/application-session.js');
    expect(after.readApplicationSession(scope)).toMatchObject({
      restored: true,
      saved: null,
      pending: { commandId: command.commandId, employeeId: 'synthetic-employee', effectiveDate: '2026-11-02' },
    });
    const execute = vi.fn(offline);
    await expect(
      after.runApplicationCommand(scope, { ...command, commandId: randomUUID() }, execute),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    const fetch = vi.fn(async (path: string) => {
      if (path === `/api/tenant/commands/${command.commandId}/result`)
        return Response.json({ ...resultOf(command.commandId, 'succeeded'), businessId: business });
      if (path === `/api/tenant/employment/businesses/${business}`)
        return Response.json({ id: business, revision: 2, employeeRevision: 7, status: 'in_review' });
      return Response.json({}, { status: 500 });
    });
    vi.stubGlobal('fetch', fetch);
    await after.queryApplicationResult(scope, 'synthetic-tenant');
    expect(after.readApplicationSession(scope)).toMatchObject({
      pending: null,
      saved: { id: business, status: 'in_review' },
    });
    expect(sessionStorage.getItem('italent.commands.pending:transfer')).toBeNull();
  });
});
