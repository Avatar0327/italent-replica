/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalDetail as Detail, ApprovalLog } from '../../apps/web/src/approval/types.js';

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

async function renderLog(entry: ApprovalLog, recordsHidden = false) {
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

describe('AC-FE-F248 审批时间线操作人', () => {
  it('系统撤销显示撤销、系统和日志自身的理由', async () => {
    const entry = await renderLog(log);
    expect(entry).not.toBeNull();
    expect(entry!.querySelector('strong')?.textContent).toBe('撤销');
    expect(entry!.textContent).toContain('系统');
    expect(entry!.querySelector('p')?.textContent).toBe(reason);
  });
  it('自动节点显式空操作人也显示系统', async () => {
    expect((await renderLog({ ...log, event: 'approve', detail: {} }))?.textContent).toContain('系统');
  });
  it.each(['synthetic-actor', undefined])('操作人有值或键缺失时不显示系统（%s）', async (actor) => {
    const { actorUserId: _actor, ...withoutActor } = log;
    const entry = await renderLog(actor === undefined ? withoutActor : { ...log, actorUserId: actor });
    expect(entry).not.toBeNull();
    expect(entry!.textContent).toContain(reason);
    expect(entry!.textContent).not.toContain('系统');
    expect(entry!.textContent).not.toContain('synthetic-actor');
  });
  it('审批记录隐藏时不展示系统操作人或日志理由', async () => {
    expect(await renderLog(log, true)).toBeNull();
    expect(host.textContent).toContain('当前查看人不可查看审批记录');
    expect(host.textContent).not.toContain('系统');
    expect(host.textContent).not.toContain(reason);
  });
});
