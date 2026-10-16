/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { Button, Input } = requireWeb('antd');
const { FormOverlay } = await import(resolve('apps/web/src/foundation/FormOverlay.tsx'));
const { useCommandForm } = await import(resolve('apps/web/src/foundation/forms/useCommandForm.tsx'));
const { createFormStore } = await import(resolve('apps/web/src/foundation/forms/store.ts'));
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
const text = (element: Element) => element.textContent?.replace(/\s/g, '');
const buttons = (mode: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(`.ant-${mode}-footer button`));
const base = {
  open: true,
  recordKey: 'synthetic:1',
  title: '合成表单',
  initialValues: { name: '合成名称' },
  groups: [
    {
      title: '基本信息',
      fields: [{ name: 'name', label: '名称', control: h(Input), access: { visible: true, editable: true } }],
    },
  ],
};

for (const mode of ['modal', 'drawer'] as const) {
  describe(`AC-FE-0-03 DEC-545 FormOverlay ${mode}`, () => {
    it('旧调用标题、根类名、宽度、关闭与两按钮底栏保持不变', async () => {
      const close = vi.fn();
      await act(() => root.render(h(FormOverlay, { ...base, mode, onSubmit: vi.fn(), onClose: close })));
      expect(buttons(mode).map(text)).toEqual(['取消', '保存']);
      expect(document.querySelector(`.ant-${mode}-title`)?.textContent).toBe(base.title);
      expect(document.querySelector(`.ant-${mode}-title`)?.children).toHaveLength(0);
      expect(document.querySelectorAll('.form-overlay')).toHaveLength(mode === 'drawer' ? 1 : 0);
      const panel = document.querySelector<HTMLElement>(
        mode === 'modal' ? '.ant-modal' : '.ant-drawer-content-wrapper',
      );
      expect(panel?.style.width).toBe(mode === 'modal' ? '800px' : '560px');
      expect(document.querySelector<HTMLButtonElement>(`.ant-${mode}-close`)).not.toBeNull();
      await act(() => buttons(mode)[0]!.click());
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('工具区在标题后、关闭按钮保留、根类名追加，禁用暂存位于取消与保存之间', async () => {
      const submit = vi.fn(async () => {});
      const extra = vi.fn();
      const close = vi.fn();
      await act(() =>
        root.render(
          h(FormOverlay, {
            ...base,
            mode,
            titleExtra: h(Button, { onClick: extra }, '配置表单'),
            footerExtra: h(Button, { disabled: true, onClick: extra }, '暂存'),
            className: 'synthetic-overlay',
            onSubmit: submit,
            onClose: close,
          }),
        ),
      );
      expect(buttons(mode).map(text)).toEqual(['取消', '暂存', '保存']);
      expect(buttons(mode)[1]!.disabled).toBe(true);
      const title = document.querySelector(`.ant-${mode}-title`)!;
      expect(text(title)).toBe('合成表单配置表单');
      const customRoot = document.querySelector('.synthetic-overlay')!;
      expect(customRoot).not.toBeNull();
      expect(customRoot.contains(document.querySelector(`.ant-${mode}-footer`))).toBe(true);
      if (mode === 'drawer') expect(customRoot.classList.contains('form-overlay')).toBe(true);
      await act(() => buttons(mode)[1]!.click());
      expect(extra).not.toHaveBeenCalled();
      await act(() => title.querySelector<HTMLButtonElement>('button')!.click());
      expect(extra).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
      await act(() => document.querySelector<HTMLButtonElement>(`.ant-${mode}-close`)!.click());
      expect(close).toHaveBeenCalledTimes(1);
      await act(async () => buttons(mode)[2]!.click());
      expect(submit).toHaveBeenCalledExactlyOnceWith({ name: '合成名称' });
    });

    it.each(['unknown', 'conflict'])('附加节点不触发提交，提交中及 %s 内核锁保留', async (status) => {
      const store = createFormStore();
      const extra = vi.fn();
      const close = vi.fn();
      let reject!: (reason: unknown) => void;
      const send = vi.fn(() => new Promise<{ id: string }>((_resolve, fail) => (reject = fail)));
      const submit = vi.fn();
      function Harness() {
        const command = useCommandForm('synthetic/record', store);
        return h(FormOverlay, {
          ...base,
          mode,
          submission: command,
          titleExtra: h(Button, { onClick: extra }, '配置表单'),
          footerExtra: h(Button, { onClick: extra }, '附加操作'),
          onClose: close,
          onSubmit: async (values: Record<string, unknown>) => {
            submit(values);
            const result = await command.submit({ values, baseline: {}, editableFields: ['name'], revision: 1, send });
            if (result.status !== 'done') throw result.error;
          },
        });
      }
      await act(() => root.render(h(Harness)));
      await act(() => buttons(mode)[1]!.click());
      expect(extra).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
      await act(async () => buttons(mode)[2]!.click());
      expect(submit).toHaveBeenCalledTimes(1);
      expect(buttons(mode)[2]!.disabled).toBe(true);
      expect(buttons(mode)[2]!.classList.contains('ant-btn-loading')).toBe(true);
      expect(buttons(mode)[0]!.disabled).toBe(true);
      expect(buttons(mode)[1]!.disabled).toBe(false);
      expect(document.querySelector(`.ant-${mode}-close`)).toBeNull();
      expect(document.querySelector<HTMLInputElement>('input')!.disabled).toBe(true);
      await act(() => buttons(mode)[0]!.click());
      expect(close).not.toHaveBeenCalled();
      await act(async () => {
        reject(status === 'unknown' ? new Error('合成网络中断') : { status: 409, code: 'REVISION_CONFLICT' });
      });
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        status === 'unknown' ? '结果待确认' : '版本冲突',
      );
      expect(buttons(mode)[2]!.disabled).toBe(true);
      expect(buttons(mode)[2]!.classList.contains('ant-btn-loading')).toBe(false);
      expect(buttons(mode)[0]!.disabled).toBe(false);
      expect(buttons(mode)[1]!.disabled).toBe(false);
      expect(document.querySelector<HTMLInputElement>('input')!.disabled).toBe(true);
      await act(async () => {
        buttons(mode)[1]!.click();
        buttons(mode)[2]!.click();
        document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(extra).toHaveBeenCalledTimes(2);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
}
