/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const modelPath = resolve('apps/web/src/self-service/pages/model.ts');
const readPath = resolve('apps/web/src/self-service/pages/useRead.ts');
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
afterEach(() => vi.unstubAllGlobals());

describe('AC-FE-R1d-1 页面数据与权限规则', () => {
  it('AC-TRF-39：三个本人调动权限都来自服务端，缺任一项即不显示发起按钮', async () => {
    const { canApplySelf } = await import(modelPath);
    const all = ['Transfer.Self', 'Employment.Create', 'Employment.Submit'];
    expect(canApplySelf(() => false)).toBe(false);
    expect(canApplySelf((code: string, level: string) => all.includes(code) && level === 'detail')).toBe(true);
    for (const removed of all)
      expect(canApplySelf((code: string) => code !== removed && all.includes(code))).toBe(false);
  });
  it('AC-TRF-37：隐藏字段不被残留名称复活，日期与零值按服务端原值展示', async () => {
    const { recordItems } = await import(modelPath);
    const items = recordItems({
      id: 'record',
      effectiveDate: '2026-10-13',
      approvalStatus: 'approved',
      fields: { departmentId: 'department', onTrialMonths: 0 },
      fieldLabels: { departmentId: '合成部门', postId: '隐藏职务' },
    });
    expect(items).toContainEqual({ key: 'departmentId', label: '部门', children: '合成部门' });
    expect(items.some((item: { children: unknown }) => item.children === '隐藏职务')).toBe(false);
    expect(items.find((item: { key: string }) => item.key === 'effectiveDate')?.children).toBe('2026-10-13');
    expect(items.find((item: { key: string }) => item.key === 'approvalStatus')?.children).toBe('通过');
  });
  it('AC-TRF-42：经理列表按原始字段缺席裁剪列，不从 display 或其他员工补字段', async () => {
    const { teamKeys, teamValue } = await import(modelPath);
    const row = { name: '合成员工', tenure: 0, display: { name: '合成员工', email: 'hidden@example.com' } };
    expect(teamKeys([row])).toContain('name');
    expect(teamKeys([row])).not.toContain('email');
    expect(teamValue(row, 'email')).toBe('—');
    expect(teamValue(row, 'tenure')).toBe('0');
    const code = '30000000-0000-4000-8000-000000000002';
    expect(teamValue({ code }, 'code')).toBe(code);
    expect(teamValue({ departmentId: code }, 'departmentId')).toBe('—');
    expect(teamValue({ departmentId: code, display: { departmentId: '合成部门' } }, 'departmentId')).toBe('合成部门');
  });
  it('AC-TRF-45：审批通过与已生效明确区分，未知状态不自行推算', async () => {
    const { statusText } = await import(modelPath);
    expect(statusText('approved')).toBe('通过');
    expect(statusText('effective')).toBe('已生效');
    expect(statusText('future_state')).toBe('future_state');
    expect(statusText(undefined)).toBe('—');
  });
  it('AC-TRF-42：经理查询在服务器分页前筛选，搜索内容编码且不拼入其他参数', async () => {
    const { managerListPath } = await import(modelPath);
    const url = new URL(
      managerListPath('team', { page: 2, pageSize: 15 }, 'active', '合成&category=leaving'),
      'http://local',
    );
    expect(url.searchParams.get('search')).toBe('合成&category=leaving');
    expect(url.searchParams.get('category')).toBe('active');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('pageSize')).toBe('15');
  });
});

describe('AC-FE-R1d-1 读取生命周期', () => {
  it('切换身份、路径后立即清除旧记录，迟到响应不能覆盖新身份数据', async () => {
    const { useRead } = await import(readPath);
    const pending: { resolve: (response: Response) => void; signal: AbortSignal }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((resolve) => {
            pending.push({ resolve, signal: init.signal as AbortSignal });
          }),
      ),
    );
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    function Probe({ path }: { path: string }) {
      const state = useRead(path);
      return h('p', null, state.data?.name ?? '等待');
    }
    const tree = (identityKey: string, path: string) =>
      h(
        SessionProvider,
        {
          session: { tenantId: 'tenant', identityKey, timezone: 'Asia/Shanghai' },
        },
        h(Probe, { path }),
      );
    try {
      await act(async () => root.render(tree('a', '/api/tenant/self-service/profile')));
      await act(async () => pending[0]!.resolve(Response.json({ name: '旧员工' })));
      expect(host.textContent).toBe('旧员工');
      await act(async () => root.render(tree('b', '/api/tenant/self-service/profile')));
      expect(host.textContent).toBe('等待');
      await act(async () => root.render(tree('b', '/api/tenant/self-service/applications')));
      expect(pending[1]!.signal.aborted).toBe(true);
      await act(async () => pending[2]!.resolve(Response.json({ name: '新身份申请' })));
      await act(async () => pending[1]!.resolve(Response.json({ name: '迟到档案' })));
      expect(host.textContent).toBe('新身份申请');
    } finally {
      await act(() => root.unmount());
      host.remove();
    }
  });
});
