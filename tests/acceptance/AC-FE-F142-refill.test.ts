/// <reference lib="dom" />
// @vitest-environment happy-dom
// F-142 第 1 轮 P2：冲突核对后用户继续编辑，动态字段显隐使可提交字段集合变化时，不能用上次提交的草稿覆盖实时输入。
// 场景照组织变更页：改名提交 → 409 → 重读核对 → 输入新备注、把名称改回原名 → “是否新增任职”随之隐藏。
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { Input } = requireWeb('antd');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { FormOverlay } = await import(resolve('apps/web/src/foundation/FormOverlay.tsx'));
const { FormCommands, useCommandForm } = await import(resolve('apps/web/src/foundation/forms/useCommandForm.tsx'));
const { slotKey } = await import(resolve('apps/web/src/foundation/forms/slot.ts'));
const { ApiError } = await import(resolve('apps/web/src/foundation/client.ts'));

const session = {
  tenantId: 't-1',
  identityKey: 'u-1',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '合成用户',
  source: 'server',
};
const original = { name: '原组织', remark: '原备注', addJob: '是' };
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let form!: ReturnType<typeof useCommandForm>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

const field = (name: string, label: string) => ({
  name,
  label,
  control: h(Input),
  access: { visible: true, editable: true },
});
function Org({ extra }: { extra: boolean }) {
  form = useCommandForm(slotKey('/api/tenant/org/organizations', 'o-1'));
  const fields = [field('name', '名称'), field('remark', '备注'), ...(extra ? [field('addJob', '是否新增任职')] : [])];
  return h(FormOverlay, {
    open: true,
    recordKey: 'o-1',
    title: '组织变更',
    mode: 'modal',
    submission: form,
    initialValues: original,
    groups: [{ title: '基本信息', fields }],
    onSubmit: vi.fn(),
    onClose: vi.fn(),
  });
}
const render = (extra: boolean) =>
  act(() => root.render(h(SessionProvider, { session }, h(FormCommands, null, h(Org, { extra })))));
const input = (name: string) => document.getElementById(name) as HTMLInputElement;
function type(name: string, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(name), value);
  input(name).dispatchEvent(new Event('input', { bubbles: true }));
}

describe('AC-FE-F142 重读回填', () => {
  it('核对后继续编辑，可提交字段集合变化时保留实时草稿，不回退到上次提交的草稿或服务端值', async () => {
    await render(true);
    await act(async () => {
      await form.submit({
        values: { ...original, name: '新组织' },
        baseline: original,
        editableFields: ['name', 'remark', 'addJob'],
        revision: 2,
        businessId: 'o-1',
        patchOnly: true,
        send: async () => {
          throw new ApiError(409, 'REVISION_CONFLICT', 'refresh', '合成冲突');
        },
      });
    });
    expect(form.status).toBe('conflict');
    await act(() =>
      form.reread(async () => ({ id: 'o-1', revision: 3, values: { ...original, remark: '服务端备注' } })),
    );
    expect([input('name').value, input('remark').value]).toEqual(['新组织', '服务端备注']);
    await act(() => form.confirm());
    await act(() => type('remark', '我的新备注'));
    await act(() => type('name', '原组织'));
    await render(false);
    expect(input('addJob')).toBeNull();
    expect([input('name').value, input('remark').value]).toEqual(['原组织', '我的新备注']);
  });
});
