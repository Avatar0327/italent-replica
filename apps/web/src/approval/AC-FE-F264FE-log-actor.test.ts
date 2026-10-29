/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalDetail as Detail, ApprovalLog } from './types.js';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { ApprovalDetail } = await import(resolve('apps/web/src/approval/ApprovalDetail.tsx'));
const session = {
  tenantId: 'synthetic-tenant',
  identityKey: 'synthetic-user',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '合成用户',
  source: 'server',
};
const reason = '离职业务终止在途审批流程';
const log: ApprovalLog = {
  event: 'system_revoke',
  actorUserId: null,
  detail: { comment: reason },
  createdAt: '2026-10-19T10:00:00Z',
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function renderLog(entry: ApprovalLog & { actorName?: string | null }, recordsHidden = false) {
  const detail: Detail = {
    id: 'synthetic-instance',
    title: '合成考核审批',
    revision: 2,
    status: 'cancelled',
    approvalType: 'assessment',
    actions: [],
    recordsHidden,
    form: { values: {} },
    tasks: [],
    logs: [entry],
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(detail))));
  await act(async () => {
    root.render(
      h(SessionProvider, { session }, h(ApprovalDetail, { row: detail, layout: 'page', onClose() {}, onChanged() {} })),
    );
  });
  return host.querySelector('.approval-log');
}

describe('AC-FE-F264FE 审批日志操作人姓名', () => {
  it.each(['合成审批人林晓', '操作人不可用', '<合成审批人>'])('普通日志原样显示服务端姓名（%s）', async (actorName) => {
    const entry = await renderLog({ ...log, event: 'approve', actorUserId: 'synthetic-actor', actorName });
    expect(entry).not.toBeNull();
    expect(entry!.textContent).toContain(actorName);
    expect(entry!.textContent).not.toContain('synthetic-actor');
    expect(entry!.textContent!.indexOf(actorName)).toBeLessThan(entry!.textContent!.indexOf('同意'));
    expect(entry!.querySelector('合成审批人')).toBeNull();
  });
  it('显式空操作人保留系统标签，忽略姓名', async () => {
    const entry = await renderLog({ ...log, actorName: '不应显示的合成姓名' });
    expect(entry!.querySelector('.ant-tag')?.textContent).toBe('系统');
    expect(entry!.textContent).not.toContain('不应显示的合成姓名');
  });
  it.each([undefined, null])('姓名未下发或为空时不显示 ID 或系统（%s）', async (actorName) => {
    const entry = await renderLog({
      ...log,
      actorUserId: 'synthetic-actor',
      ...(actorName === undefined ? {} : { actorName }),
    });
    expect(entry!.textContent).toContain(reason);
    expect(entry!.textContent).not.toContain('synthetic-actor');
    expect(entry!.textContent).not.toContain('系统');
    expect(entry!.querySelector('.approval-log-actor')).toBeNull();
  });
  it('操作人和姓名均未下发时不误标为系统', async () => {
    const { actorUserId: _actor, ...legacy } = log;
    const entry = await renderLog(legacy);
    expect(entry!.textContent).not.toContain('系统');
  });
  it('审批记录隐藏时不显示姓名', async () => {
    expect(await renderLog({ ...log, actorUserId: 'synthetic-actor', actorName: '合成审批人林晓' }, true)).toBeNull();
    expect(host.textContent).not.toContain('合成审批人林晓');
  });
});
