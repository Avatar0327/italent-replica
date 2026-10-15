/// <reference lib="dom" />
// @vitest-environment happy-dom
// F-142 第 1 轮 P2：冲突核对后用户继续编辑，动态字段显隐使可提交字段集合变化时，不能用上次提交的草稿覆盖实时输入。
// 场景照组织变更页：改名提交 → 409 → 重读核对 → 输入新备注、把名称改回原名 → “是否新增任职”随之隐藏。
// 第 2 轮 P2：字段转为不可提交并回填最新记录时，内核草稿与已改字段集合要一起更新；不重提再重读、字段恢复可编辑后，
// 旧草稿不能复活。场景照 IDP 流程页：子流程整组随最新记录缺天数转只读（idp/submission.ts）。
// 第 3 轮 P2：最新记录本来没有的字段（组织“是否新增任职”）被 settle 清掉后，控件里的旧选择也要清掉，字段重新出现时不能带回旧值。
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { Input } = requireWeb('antd');
const { useState } = requireWeb('react');
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

const process = { name: '原流程', stages: '阶段一', days: '3' };
let sent: unknown[] = [];
function Proc() {
  form = useCommandForm(slotKey('/api/tenant/idp/processes', 'p-1'));
  const latest = form.state?.latest?.values;
  // 最新记录缺天数时子流程整组只读（不可提交），记录完整后恢复可编辑。
  const stages = { ...field('stages', '子流程'), access: { visible: true, editable: !latest || 'days' in latest } };
  return h(FormOverlay, {
    open: true,
    recordKey: 'p-1',
    title: '编辑流程',
    mode: 'modal',
    submission: form,
    initialValues: process,
    groups: [{ title: '基本信息', fields: [field('name', '流程名称'), stages] }],
    onSubmit: async (values: Record<string, unknown>) => {
      const result = await form.submit({
        values,
        baseline: process,
        editableFields: Object.keys(values),
        revision: 2,
        businessId: 'p-1',
        patchOnly: true,
        send: async (command: { body: unknown }) => {
          sent.push(command.body);
          if (sent.length === 1) throw new ApiError(409, 'REVISION_CONFLICT', 'refresh', '合成冲突');
          return { id: 'p-1' };
        },
      });
      if (result.status !== 'done') throw result.error;
    },
    onClose: vi.fn(),
  });
}
const save = () => act(async () => document.querySelector<HTMLButtonElement>('.ant-btn-primary')!.click());

describe('AC-FE-F142 连续重读', () => {
  it('不重提连续重读：转只读时回填的字段视为未改，恢复可编辑后仍以最新记录为准，不复活旧草稿', async () => {
    sent = [];
    await act(() => root.render(h(SessionProvider, { session }, h(FormCommands, null, h(Proc)))));
    await act(() => type('stages', '阶段一（改名）'));
    await save();
    expect(form.status).toBe('conflict');
    expect(sent).toEqual([{ stages: '阶段一（改名）' }]);
    // 第一次重读：记录缺天数，子流程转只读并回填最新记录。
    await act(() =>
      form.reread(async () => ({ id: 'p-1', revision: 3, values: { name: '原流程', stages: '阶段一' } })),
    );
    expect(input('stages')).toBeNull();
    // 不重提，再次重读：记录完整，服务端已有两个阶段，子流程恢复可编辑。
    const two = { ...process, stages: '阶段一,阶段二' };
    await act(() => form.reread(async () => ({ id: 'p-1', revision: 4, values: two })));
    expect(input('stages').value).toBe('阶段一,阶段二');
    await act(() => form.confirm());
    await act(() => type('name', '新流程'));
    await save();
    expect(form.status).toBe('done');
    // 只改了流程名称：请求体不带子流程，不会让后端删掉服务端新增的阶段。
    expect(sent[1]).toEqual({ name: '新流程' });
  });
});

const organization = { name: '原组织', remark: '原备注' };
function Change() {
  form = useCommandForm(slotKey('/api/tenant/org/organizations', 'o-2'));
  const current = form.state?.latest?.values ?? organization;
  const [name, setName] = useState(organization.name);
  // 照 OrgEditor：名称与当前原单不同才出现“是否新增任职”；组织记录本身没有这个字段。
  const onChange = (event: { target: { value: string } }) => setName(event.target.value);
  const rename = { ...field('name', '名称'), control: h(Input, { onChange }) };
  const choice = name.trim() !== current.name ? [field('addEmployment', '是否新增任职')] : [];
  return h(FormOverlay, {
    open: true,
    recordKey: 'o-2',
    title: '组织变更',
    mode: 'modal',
    submission: form,
    initialValues: organization,
    groups: [{ title: '基本信息', fields: [rename, field('remark', '备注'), ...choice] }],
    onSubmit: async (values: Record<string, unknown>) => {
      const result = await form.submit({
        values,
        baseline: organization,
        editableFields: Object.keys(values),
        revision: 2,
        businessId: 'o-2',
        patchOnly: true,
        send: async (command: { body: unknown }) => {
          sent.push(command.body);
          if (sent.length === 1) throw new ApiError(409, 'REVISION_CONFLICT', 'refresh', '合成冲突');
          return { id: 'o-2' };
        },
      });
      if (result.status !== 'done') throw result.error;
    },
    onClose: vi.fn(),
  });
}

describe('AC-FE-F142 最新记录缺字段', () => {
  it('隐藏后 settle 清掉的选择同步清掉控件值，再次改名字段重新出现时为空，请求体不带旧选择', async () => {
    sent = [];
    await act(() => root.render(h(SessionProvider, { session }, h(FormCommands, null, h(Change)))));
    await act(() => type('name', '新组织'));
    await act(() => type('addEmployment', 'yes'));
    await save();
    expect(sent).toEqual([{ name: '新组织', addEmployment: 'yes' }]);
    await act(() => form.reread(async () => ({ id: 'o-2', revision: 3, values: organization })));
    expect([input('name').value, input('addEmployment').value]).toEqual(['新组织', 'yes']);
    await act(() => form.confirm());
    // 名称改回原名：选择字段隐藏，内核与控件都不再留着“是”。
    await act(() => type('name', '原组织'));
    expect(input('addEmployment')).toBeNull();
    await act(() => type('name', '改名二'));
    expect(input('addEmployment').value).toBe('');
    await save();
    expect(sent[1]).toEqual({ name: '改名二' });
  });
});
