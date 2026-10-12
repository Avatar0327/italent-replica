/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
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

describe('AC-FE-0-03 最小组件集', () => {
  it('决策注释默认关闭，全局开关打开后显示来源、取舍和 DEC', async () => {
    const notes = await import(resolve('apps/web/src/foundation/DecisionNote.tsx'));
    await act(() =>
      root.render(
        h(notes.DecisionNotesProvider, {}, [
          h(notes.DecisionNoteToggle, { key: 'toggle' }),
          h(notes.DecisionNote, { key: 'note', id: 'foundation' }),
        ]),
      ),
    );
    expect(host.textContent).not.toContain('DEC-456');
    await act(() => host.querySelector('button')!.click());
    expect(host.textContent).toContain('DEC-456');
    expect(host.textContent).toContain('原站做法');
    expect(host.textContent).toContain('我们的取舍');
  });

  it('权限未加载时 Can 不显示，允许查看但不能编辑的字段显示只读值', async () => {
    const access = await import(resolve('apps/web/src/foundation/Permissions.tsx'));
    await act(() => root.render(h(access.Can, { button: 'delete' }, '删除')));
    expect(host.textContent).toBe('');
    await act(() =>
      root.render(
        h(
          access.PermissionField,
          {
            access: { visible: true, editable: false },
            value: '合成名称',
          },
          h('input', { defaultValue: '不应显示' }),
        ),
      ),
    );
    expect(host.textContent).toContain('合成名称');
    expect(host.querySelector('input')).toBeNull();
    await act(() =>
      root.render(
        h(
          access.PermissionField,
          {
            access: { visible: false, editable: true },
            value: '秘密字段',
          },
          h('input'),
        ),
      ),
    );
    expect(host.textContent).toBe('');
  });
});
