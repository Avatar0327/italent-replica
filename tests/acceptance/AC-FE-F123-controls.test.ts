/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { FormLock, LockedField, useFormLock } = await import(resolve('apps/web/src/foundation/forms/FormLock.tsx'));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
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

it('AC-FE-F123 提交锁与业务 disabled/readOnly 取并集，锁定时旧回调也不能变更值', async () => {
  const change = vi.fn();
  let callback!: (value: string) => void;
  function Control({ disabled, readOnly }: { disabled: boolean; readOnly: boolean }) {
    const lock = useFormLock(disabled, readOnly);
    callback = lock.guard(change);
    return h('input', { disabled: lock.disabled });
  }
  const render = (locked: boolean, disabled = false, readOnly = false) =>
    act(() => root.render(h(FormLock, { locked }, h(Control, { disabled, readOnly }))));
  await render(false);
  const stale = callback;
  callback('可编辑');
  expect(change).toHaveBeenCalledTimes(1);
  for (const flags of [
    [true, false, false],
    [false, true, false],
    [false, false, true],
  ]) {
    await render(...(flags as [boolean, boolean, boolean]));
    expect(host.querySelector('input')!.disabled).toBe(true);
    callback('锁内修改');
    stale('锁前缓存的回调');
    expect(change).toHaveBeenCalledTimes(1);
  }
  await render(false);
  callback('解锁修改');
  expect(change).toHaveBeenCalledTimes(2);
});

it('AC-FE-F123 表单入口保护普通子控件，显式 disabled=false 不能覆盖提交锁', async () => {
  const change = vi.fn();
  const ownChange = vi.fn();
  let props!: { disabled: boolean; onChange(value: string): void; value: string };
  function Control(value: typeof props) {
    props = value;
    return h('input', { disabled: value.disabled });
  }
  const render = (locked: boolean) =>
    act(() =>
      root.render(
        h(
          FormLock,
          { locked },
          h(LockedField, { value: '用户草稿', onChange: change }, h(Control, { disabled: false, onChange: ownChange })),
        ),
      ),
    );
  await render(false);
  expect(props.value).toBe('用户草稿');
  const before = props.onChange;
  await render(true);
  expect(props.disabled).toBe(true);
  props.onChange('锁内');
  before('旧回调');
  expect(change).not.toHaveBeenCalled();
  expect(ownChange).not.toHaveBeenCalled();
  await render(false);
  props.onChange('解锁');
  expect(change).toHaveBeenCalledWith('解锁');
  expect(ownChange).toHaveBeenCalledWith('解锁');
  expect(ownChange).toHaveBeenCalledTimes(1);
});

it('AC-FE-F123 共用控件仍继承旧 Form 的业务禁用，不能被默认 false 解锁', async () => {
  const { Form } = requireWeb('antd');
  const change = vi.fn();
  let callback!: () => void;
  function Control() {
    const lock = useFormLock(false);
    callback = lock.guard(change);
    return h('input', { disabled: lock.disabled });
  }
  await act(() => root.render(h(Form, { disabled: true }, h(Control))));
  expect(host.querySelector('input')!.disabled).toBe(true);
  callback();
  expect(change).not.toHaveBeenCalled();
});
