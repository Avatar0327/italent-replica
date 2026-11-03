/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { act, createElement: h, useState } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { StaffDetail } = await import(resolve('apps/web/src/personnel/StaffDetail.tsx'));

// 保留 StaffDetail 与真实 useRead；用可编辑的页签子树观察是否被卸载，不依赖 antd 动画。
vi.mock('../../apps/web/src/foundation/templates.js', () => ({
  DetailPage: ({ summary, tabs }: { summary: unknown; tabs?: { key: string; children: unknown }[] }) =>
    h(
      'div',
      null,
      summary,
      tabs?.map((tab) => h('section', { key: tab.key }, tab.children)),
    ),
}));
vi.mock('../../apps/web/src/foundation/Permissions.js', () => ({
  usePermissions: vi.fn(() => ({ field: () => ({ visible: true }) })),
}));
vi.mock('../../apps/web/src/foundation/DecisionNote.js', () => ({ DecisionNote: () => null }));
vi.mock('../../apps/web/src/personnel/EditCommands.js', () => ({ EditPersonButton: () => null }));
vi.mock('../../apps/web/src/part-time/EmployeePartTimes.js', () => ({ EmployeePartTimes: () => null }));
vi.mock('../../apps/web/src/personnel/ProfileSections.js', () => ({
  PersonnelProfile: () => null,
  EmploymentRecords: () => {
    const [value, setValue] = useState('');
    return h('input', {
      'aria-label': '合成编辑任职',
      value,
      onChange: (event: { target: { value: string } }) => setValue(event.target.value),
    });
  },
}));
vi.mock('../../apps/web/src/foundation/PageState.js', () => ({
  PageState: ({ kind, retry }: { kind: string; retry?: () => void }) =>
    h('button', { onClick: retry, 'data-state': kind }, kind === 'error' ? '重试读取' : '读取中'),
}));
const permissions = await import(resolve('apps/web/src/foundation/Permissions.tsx'));
const session = {
  tenantId: 'synthetic-f444',
  identityKey: 'synthetic-user',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '合成用户',
  source: 'server' as const,
};
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let response: () => Promise<Response>;
let reads: number;
async function render(
  reload: number | undefined,
  employeeId = 'synthetic-employee',
  identityKey = session.identityKey,
) {
  await act(async () =>
    root.render(
      h(SessionProvider, {
        session: { ...session, identityKey },
        children: h(StaffDetail, { employeeId, onClose: () => undefined, reload }),
      }),
    ),
  );
  await flush();
}
const input = () => host.querySelector('input');
async function edit() {
  await act(async () => {
    // React happy-dom input 的 change 路径用原生 setter + input 事件。
    const node = input()!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, '尚未保存的备注');
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('AC-FE-F444 人员详情临时读失败保留编辑子树', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    reads = 0;
    response = async () => Response.json({ id: 'synthetic-employee', name: '合成人员' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        reads += 1;
        return response();
      }),
    );
    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it.each(['500', 'network'])('AC-FE-F444-05 重读 %s：保留页签节点和输入，显示错误、可重试', async (failure) => {
    await render(0);
    await edit();
    const editor = input();
    expect(editor?.value).toBe('尚未保存的备注');
    response =
      failure === '500'
        ? async () => Response.json({ error: { code: 'INTERNAL', message: '合成错误' } }, { status: 500 })
        : async () => {
            throw new TypeError('Failed to fetch');
          };
    await render(1);
    expect(reads).toBe(2);
    expect(host.querySelector('[data-state="error"]')).not.toBeNull();
    expect(input()).toBe(editor);
    expect(input()?.value).toBe('尚未保存的备注');
    response = async () => Response.json({ id: 'synthetic-employee', name: '合成更新姓名' });
    await act(async () => (host.querySelector('[data-state="error"]') as HTMLButtonElement).click());
    await flush();
    expect(input()).toBe(editor);
    expect(input()?.value).toBe('尚未保存的备注');
    expect(host.textContent).toContain('合成更新姓名');
  });

  it.each([401, 403])('AC-FE-F444-06 重读 %s：清除旧档案，失败后重试仍不可复活旧页签', async (status) => {
    await render(0);
    response = async () => Response.json({ error: { code: 'FORBIDDEN', message: '合成撤权' } }, { status });
    await render(1);
    expect(input()).toBeNull();
    response = () => new Promise(() => undefined);
    await act(async () => (host.querySelector('[data-state="error"]') as HTMLButtonElement).click());
    expect(input()).toBeNull();
  });

  it('AC-FE-F444-10 未传 reload：读成功不产生缓存引起的额外渲染', async () => {
    await render(undefined);
    expect(reads).toBe(1);
    expect(permissions.usePermissions).toHaveBeenCalledTimes(2);
    expect(input()).not.toBeNull();
  });

  it('AC-FE-F444-07 换员工或身份的请求失败，不借用上一份档案；未传 reload 沿用原读取行为', async () => {
    await render(0);
    response = async () => {
      throw new TypeError('Failed to fetch');
    };
    await render(0, 'synthetic-other');
    expect(input()).toBeNull();
    await render(0, 'synthetic-employee', 'synthetic-other-identity');
    expect(input()).toBeNull();
    await render(undefined);
    expect(input()).toBeNull();
  });
});
