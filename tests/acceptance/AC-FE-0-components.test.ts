/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { FormOverlay } = await import(resolve('apps/web/src/foundation/FormOverlay.tsx'));
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
  vi.unstubAllGlobals();
});

describe('AC-FE-0-03 最小组件集', () => {
  it('切换记录或刷新 revision 后重建表单，不能把上一条记录的值提交给下一条', async () => {
    const { Input } = requireWeb('antd');
    const render = (recordKey: string, name: string) =>
      h(FormOverlay, {
        open: true,
        recordKey,
        title: '编辑记录',
        mode: 'modal',
        initialValues: { name },
        groups: [
          {
            title: '基本信息',
            fields: [{ name: 'name', label: '名称', control: h(Input), access: { visible: true, editable: true } }],
          },
        ],
        onSubmit: vi.fn(),
        onClose: vi.fn(),
      });
    await act(() => root.render(render('first:1', '第一条')));
    await act(() => root.render(render('second:2', '第二条')));
    expect(document.querySelector<HTMLInputElement>('input')?.value).toBe('第二条');
  });
  it('额外对象权限按需读取；切换租户立即卸载旧授权，不能继承旧按钮', async () => {
    const access = await import(resolve('apps/web/src/foundation/Permissions.tsx'));
    const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init: RequestInit) => {
        if (new Headers(init.headers).get('x-tenant-id') === 'tenant-b')
          return Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
        if (path.endsWith('/me/snapshot'))
          return Response.json({
            session: { tenantId: 'tenant-a', userId: 'user' },
            apps: [],
            scope: [],
            adminMenus: [],
          });
        if (path.includes('/permission/me/objects/'))
          return Response.json({
            objectCode: path.split('/').at(-1),
            dataOperations: {},
            viewableFields: [],
            editableFields: [],
            buttons: [{ buttonCode: 'delete', level: 'detail' }],
          });
        return Response.json({ items: [] });
      }),
    );
    const tree = (tenantId: string) =>
      h(
        SessionProvider,
        { session: { tenantId, identityKey: 'user' } },
        h(access.PermissionsProvider, {}, h(access.Can, { object: 'TenantBase.JobGrade', button: 'delete' }, '可删除')),
      );
    await act(async () => {
      root.render(tree('tenant-a'));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(host.textContent).toBe('可删除');
    await act(async () => {
      root.render(tree('tenant-b'));
    });
    expect(host.textContent).toBe('');
  });
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
  it('表单跳过隐藏与只读字段校验，服务端字段错误落到对应控件，提交中不会重入', async () => {
    const { ApiError } = await import(resolve('apps/web/src/foundation/client.ts'));
    const { Input } = requireWeb('antd');
    let reject!: (reason: unknown) => void;
    const submit = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const field = (name: string, visible: boolean, editable: boolean) => ({
      name,
      label: name,
      access: { visible, editable },
      control: h(Input),
      rules: [{ required: true }],
    });
    await act(() =>
      root.render(
        h(FormOverlay, {
          open: true,
          title: '合成表单',
          recordKey: 'example:1',
          mode: 'modal',
          onSubmit: submit,
          onClose: vi.fn(),
          initialValues: { name: '合成名称', readonly: '只读内容', hidden: '不可见内容' },
          groups: [
            {
              title: '基本信息',
              fields: [field('name', true, true), field('readonly', true, false), field('hidden', false, false)],
            },
          ],
        }),
      ),
    );
    expect(document.body.textContent).toContain('只读内容');
    expect(document.body.textContent).not.toContain('不可见内容');
    const form = document.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({ name: '合成名称' });
    await act(async () => {
      reject(
        new ApiError(422, 'VALIDATION_FAILED', 'fields', '请检查字段', {
          details: { fieldErrors: { name: ['名称已存在'] } },
        }),
      );
    });
    await vi.waitFor(() =>
      expect(document.querySelector('.ant-form-item-explain-error')?.textContent).toBe('名称已存在'),
    );
  });
  it('列表分页清空当前批量选择，空数据范围有独立提示', async () => {
    const { ListPage } = await import(resolve('apps/web/src/foundation/templates.tsx'));
    const selected = vi.fn();
    const page = vi.fn();
    await act(() =>
      root.render(
        h(ListPage, {
          title: '合成列表',
          data: { items: [{ id: 'a', name: '可见值' }], total: 41 },
          rowKey: 'id',
          columns: [{ title: '名称', dataIndex: 'name' }],
          page: { page: 1, pageSize: 20 },
          onPageChange: page,
          selection: { keys: ['a'], onChange: selected, actions: '批量操作' },
        }),
      ),
    );
    await act(() => host.querySelector<HTMLButtonElement>('.ant-pagination-next button')!.click());
    expect(page).toHaveBeenCalledWith({ page: 2, pageSize: 20 });
    expect(selected).toHaveBeenCalledWith([], []);
    await act(() =>
      root.render(
        h(ListPage, {
          title: '合成列表',
          data: { items: [], total: 0, hasDataPermission: false },
          rowKey: 'id',
          columns: [],
          page: { page: 1, pageSize: 20 },
          onPageChange: page,
        }),
      ),
    );
    expect(host.textContent).toContain('当前没有可查看的数据范围');
  });
  it.each([
    { label: '后端满页且未声明尾页', items: [{ id: 'a' }, { id: 'b' }], disabled: false },
    { label: '后端短页', items: [{ id: 'a' }], disabled: true },
    { label: '后端空页', items: [], disabled: true },
    { label: '显式 hasMore=false 优先于满页', items: [{ id: 'a' }, { id: 'b' }], hasMore: false, disabled: true },
    { label: '显式 hasMore=true 优先于短页', items: [{ id: 'a' }], hasMore: true, disabled: false },
    { label: '加载中禁止再次翻页', items: [{ id: 'a' }, { id: 'b' }], loading: true, disabled: true },
  ])('无总数分页：$label', async ({ items, disabled, ...state }) => {
    const { ListPage } = await import(resolve('apps/web/src/foundation/templates.tsx'));
    const change = vi.fn();
    const selected = vi.fn();
    await act(() =>
      root.render(
        h(ListPage, {
          title: '后端分页',
          data: { items, hasMore: state.hasMore },
          rowKey: 'id',
          columns: [],
          page: { page: 2, pageSize: 2 },
          onPageChange: change,
          loading: state.loading,
          selection: { keys: ['a'], onChange: selected, actions: '批量操作' },
        }),
      ),
    );
    const buttons = Array.from(host.querySelectorAll('button'));
    const next = buttons.find((button) => button.textContent === '下一页')!;
    expect(next.disabled).toBe(disabled);
    expect(host.querySelector('.page-total')).toBeNull();
    if (!disabled) {
      await act(() => next.click());
      expect(change).toHaveBeenCalledWith({ page: 3, pageSize: 2 });
      expect(selected).toHaveBeenCalledWith([], []);
    }
  });
});
