/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { MemoryRouter } = requireWeb('react-router');
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
const NEW_DEPARTMENT = '5d8f3a52-1c0e-4b7a-9f4e-0a1b2c3d4e51';
const OLD_DEPARTMENT = '5d8f3a52-1c0e-4b7a-9f4e-0a1b2c3d4e52';
const NEW_MANAGER = '5d8f3a52-1c0e-4b7a-9f4e-0a1b2c3d4e53';
const OLD_MANAGER = '5d8f3a52-1c0e-4b7a-9f4e-0a1b2c3d4e54';
const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
// 与 GET /api/tenant/approval/instances/:id 同形（disclosure.detailView）：终止的调动申请，没有可办理动作。
const transfer = {
  id: 'instance-1',
  title: '合成员工的调动申请',
  status: 'cancelled',
  approvalType: 'transfer',
  revision: 6,
  createdAt: '2026-11-02T01:00:00Z',
  actions: [],
  recordsHidden: false,
  commentNotice: '合成提示',
  form: {
    values: {
      effectiveDate: '2026-11-10',
      reasonCode: 'promotion',
      reasonCodeName: '升职',
      gender: '男',
      age: 30,
      departmentId: NEW_DEPARTMENT,
      departmentIdName: '合成新部门',
      directManagerId: NEW_MANAGER,
      directManagerIdName: '合成新经理',
      place: '合成工作地',
    },
    // 后端 originalsOf 会下发前一条记录的全部同名字段（含没变的 gender / place），名称同样并列下发
    originals: {
      gender: '男',
      departmentId: OLD_DEPARTMENT,
      departmentIdName: '合成原部门',
      directManagerId: OLD_MANAGER,
      directManagerIdName: '合成原经理',
      place: '合成工作地',
    },
  },
  tasks: [
    { id: 'task-1', nodeName: '会签审批', status: 'approved' },
    { id: 'task-2', nodeName: '部门负责人审批', status: 'cancelled' },
  ],
  logs: [
    { event: 'start', actorUserId: 'u1', actorName: '合成发起人甲', createdAt: '2026-11-02T01:00:00Z' },
    { event: 'system_revoke', actorUserId: null, actorName: null, createdAt: '2026-11-03T01:00:00Z' },
  ],
};
const leave = {
  ...transfer,
  id: 'instance-2',
  title: '合成员工的离职申请',
  status: 'approved',
  approvalType: 'leave',
  form: { values: { effectiveDate: '2026-11-30', lastWorkDate: '2026-11-29', kind: 'leave' }, originals: {} },
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
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
async function render(detail: Omit<typeof transfer, 'form'> & { form: unknown }, flags: Record<string, boolean> = {}) {
  const fetcher = vi.fn(async (url: string) =>
    String(url).includes('/logs?')
      ? new Response(JSON.stringify({ items: detail.logs, recordsHidden: false, page: 1, pageSize: 20 }))
      : new Response(JSON.stringify(detail)),
  );
  vi.stubGlobal('fetch', fetcher);
  const row = { id: detail.id, title: detail.title, approvalType: detail.approvalType, status: detail.status };
  await act(async () =>
    root.render(
      h(
        SessionProvider,
        { session },
        h(
          MemoryRouter,
          { initialEntries: ['/'] },
          h(ApprovalDetail, { row, layout: 'page', onClose: () => undefined, onChanged: () => undefined, ...flags }),
        ),
      ),
    ),
  );
  return fetcher;
}
const buttons = () => Array.from(host.querySelectorAll('.approval-detail-head button'));
const labels = () => buttons().map((b) => b.textContent?.replace(/\s/g, ''));
const button = (label: string) =>
  buttons().find((b) => b.textContent?.replace(/\s/g, '') === label) as HTMLButtonElement;
const group = (title: string) =>
  Array.from(host.querySelectorAll('.approval-field-group')).find(
    (item) => item.querySelector('h3')?.textContent === title,
  );
const steps = () =>
  Array.from(host.querySelectorAll('.ant-steps-item')).map((item) => ({
    title: item.querySelector('.ant-steps-item-title')?.textContent,
    status: ['finish', 'process', 'wait', 'error'].find((s) => item.classList.contains(`ant-steps-item-${s}`)),
  }));

describe('AC-FE-F474-3b 我的申请审批详情（§3.8 终止的调动申请）', () => {
  it('顶部只有返回、流程管理、查看流程日志，没有审批动作；查看流程日志可打开完整日志', async () => {
    const fetcher = await render(transfer, { applications: true });
    expect(labels()).toEqual(['返回', '流程管理', '查看流程日志', '重新读取']);
    expect(button('流程管理').disabled).toBe(true);
    expect(button('查看流程日志').disabled).toBe(false);
    await act(() => button('查看流程日志').click());
    expect(String(fetcher.mock.calls.at(-1)![0])).toContain('/instances/instance-1/logs?page=1&pageSize=20');
    expect(document.querySelector('.ant-modal')?.textContent).toContain('合成发起人甲');
  });

  it('进度条：已走过的节点为绿，终止的节点与终止结尾为灰，不显示“后续节点待补”之外的伪造节点', async () => {
    await render(transfer, { applications: true });
    expect(steps()).toEqual([
      { title: '开始', status: 'finish' },
      { title: '会签审批', status: 'finish' },
      { title: '部门负责人审批', status: 'wait' },
      { title: '已终止', status: 'wait' },
    ]);
  });

  it('调动信息与任职调整分组；改变的值橙色并在下方写原值；右侧协作显示操作记录', async () => {
    await render(transfer, { applications: true });
    const info = group('调动信息')!;
    expect(info.textContent).toContain('调动日期');
    expect(info.textContent).toContain('2026-11-10');
    expect(info.textContent).toContain('性别');
    expect(info.textContent).toContain('年龄');
    const adjust = group('任职调整')!;
    const department = Array.from(adjust.querySelectorAll('.approval-field')).find((f) =>
      f.textContent?.includes('新部门'),
    )!;
    expect(department.querySelector('dd')?.classList.contains('approval-changed')).toBe(true);
    expect(department.textContent).toContain('合成新部门');
    expect(department.querySelector('small')?.textContent).toBe('原：合成原部门');
    expect(adjust.textContent).toContain('新直线经理');
    expect(adjust.textContent).toContain('合成工作地');
    expect(host.querySelector('.approval-collaboration-title')?.textContent).toBe('协作');
    expect(host.textContent).toContain('操作记录(2)');
  });

  it('P2-2 引用字段显示名称：原因 / 部门 / 经理（含“原：”值）都不出现英文编码或裸 ID', async () => {
    await render(transfer, { applications: true });
    const text = host.textContent ?? '';
    expect(text).toContain('升职');
    expect(text).not.toContain('promotion');
    expect(text).toContain('合成新部门');
    expect(text).toContain('原：合成原部门');
    expect(text).toContain('合成新经理');
    expect(text).toContain('原：合成原经理');
    expect(text).not.toMatch(UUID_TEXT);
    // 名称键本身不单独成行
    expect(Array.from(host.querySelectorAll('dt')).map((dt) => dt.textContent)).not.toContain('departmentIdName');
  });

  it('P2-2 名称缺失（停用 / 查不到）时显示占位而不回落成 ID；不带名称键的离职原因编码照常显示', async () => {
    const missing = {
      ...transfer,
      form: {
        values: { departmentId: NEW_DEPARTMENT, departmentIdName: null, reasonCode: 'promotion', reasonCodeName: null },
        originals: {},
      },
    };
    await render(missing, { applications: true });
    expect(host.textContent).not.toMatch(UUID_TEXT);
    expect(host.textContent).not.toContain('promotion');
    expect(host.textContent).toContain('已保存的值');
    await act(() => root.unmount());
    root = createRoot(host);
    const exit = { ...leave, form: { values: { reasonCode: 'resign_personal', kind: 'leave' }, originals: {} } };
    await render(exit, { applications: true });
    expect(host.textContent).toContain('resign_personal');
  });

  it('P2-3 只有真正改变的字段标橙色并写“原：”；originals 里没变的字段保持普通样式', async () => {
    await render(transfer, { applications: true });
    const fields = Array.from(host.querySelectorAll('.approval-field'));
    const field = (text: string) => fields.find((f) => f.querySelector('dt')?.textContent === text)!;
    const changed = (text: string) => field(text).querySelector('dd')!.classList.contains('approval-changed');
    expect(changed('新部门')).toBe(true);
    expect(changed('新直线经理')).toBe(true);
    for (const unchanged of ['性别', '工作地']) {
      expect(changed(unchanged), unchanged).toBe(false);
      expect(field(unchanged).querySelector('small'), unchanged).toBeNull();
    }
    expect(host.querySelectorAll('.approval-changed')).toHaveLength(2);
  });

  it('按实例自己的业务类型呈现：离职实例不套用调动分组与调动字段', async () => {
    await render(leave, { applications: true });
    expect(group('调动信息')).toBeUndefined();
    expect(group('任职调整')).toBeUndefined();
    expect(host.textContent).not.toContain('新部门');
    expect(host.textContent).toContain('2026-11-30');
    expect(host.textContent).toContain('2026-11-29');
  });

  it('待办入口与其他入口的呈现不变', async () => {
    await render(transfer, { todo: true });
    expect(group('调动信息')).toBeUndefined();
    expect(steps().at(-1)).toEqual({ title: '结束', status: 'finish' });
    expect(button('查看流程日志').disabled).toBe(false);
    await act(() => root.unmount());
    root = createRoot(host);
    await render(transfer);
    expect(group('调动信息')).toBeUndefined();
    expect(steps().at(-1)).toEqual({ title: '结束', status: 'finish' });
    expect(button('查看流程日志').disabled).toBe(true);
    expect(host.querySelector('.approval-collaboration-title')).toBeNull();
  });
});
