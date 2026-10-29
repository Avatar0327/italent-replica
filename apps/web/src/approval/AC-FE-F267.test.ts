// @vitest-environment happy-dom
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../foundation/Session.js';
import { ApprovalDetail } from './ApprovalDetail.js';
import { approvalRequest } from './api.js';
import type { ApprovalDetail as Detail } from './types.js';

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let posts: { path: string; body: Record<string, unknown>; revision: string | null; commandId: string | null }[];
let responseStatus: number;
let responseCode: string;
let errorDetails: unknown;
// F-291 约定夹具，与 approval 现有冒烟详情形状一致；不进入运行时。
function fixture(mode: 'with_approve' | 'separate' | 'none' = 'with_approve', required = true): Detail {
  return {
    id: crypto.randomUUID(),
    taskId: '50000000-0000-4000-8000-000000000001',
    title: '合成员工的延长兼职申请',
    revision: 4,
    status: 'running',
    approvalType: 'part_time_extend',
    actions: mode === 'separate' ? ['approve', 'edit'] : ['approve'],
    recordsHidden: false,
    form: {
      values: { endDate: '2026-12-01', originalEndDate: '2026-11-01', requestRemark: '原备注' },
      ...(mode === 'none'
        ? {}
        : {
            edit: {
              taskId: '50000000-0000-4000-8000-000000000002',
              mode,
              fields: [
                { key: 'endDate', required, value: '2026-12-15' },
                { key: 'requestRemark', required: false, value: '节点当前备注' },
              ],
            },
          }),
    },
    tasks: [],
    logs: [],
  };
}
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')];
const button = (text: string) => buttons().find((node) => node.textContent?.replace(/\s/g, '') === text)!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const input = (label: string) => dialog().querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
async function click(text: string) {
  expect(button(text), `按钮 ${text}`).toBeDefined();
  await act(async () => {
    button(text).click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
async function fill(label: string, value: string) {
  const node = input(label);
  expect(node, `控件 ${label}`).not.toBeNull();
  await act(async () => {
    const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function render(detail: Detail) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const headers = new Headers(init.headers);
        posts.push({
          path,
          body: JSON.parse(String(init.body)),
          revision: headers.get('if-match'),
          commandId: headers.get('idempotency-key'),
        });
        if (responseStatus === 0) throw new TypeError('合成断网');
        return new Response(
          JSON.stringify(
            responseStatus === 200
              ? { ...detail, revision: detail.revision + 1 }
              : { error: { code: responseCode, message: '本节点不可编辑此字段', details: errorDetails } },
          ),
          { status: responseStatus },
        );
      }
      return new Response(JSON.stringify(path.includes('/approval/') ? detail : { items: [] }));
    }),
  );
  await act(async () => {
    root.render(
      h(SessionProvider, {
        session: {
          tenantId: 'synthetic-tenant',
          identityKey: 'synthetic-user',
          tenantName: '合成租户',
          timezone: 'Asia/Shanghai',
          displayName: '合成用户',
          source: 'server',
        },
        children: h(ApprovalDetail, { row: detail, layout: 'page', onClose() {}, onChanged() {} }),
      }),
    );
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  posts = [];
  responseStatus = 200;
  responseCode = 'FORBIDDEN';
  errorDetails = { reason: 'APPROVAL_FIELD_NOT_EDITABLE', fields: ['endDate'] };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('AC-FE-F267 审批编辑表单', () => {
  it('同意按节点当前值渲染业务字段，在意见上方，发往详情任务并提交 fields 和 comment', async () => {
    const detail = fixture();
    await render(detail);
    await click('同意');
    expect(input('新结束日期')?.value).toBe('2026-12-15');
    expect(input('延长备注')?.value).toBe('节点当前备注');
    expect(dialog().textContent!.indexOf('新结束日期')).toBeLessThan(dialog().textContent!.indexOf('审批意见'));
    await fill('新结束日期', '2026-12-31');
    await fill('延长备注', '合成延长备注');
    const comment = dialog().querySelector<HTMLTextAreaElement>('#comment')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(comment, '合成意见');
      comment.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('保存');
    expect(posts.map(({ path, body }) => ({ path, body }))).toEqual([
      {
        path: `/api/tenant/approval/tasks/${detail.form.edit!.taskId}/approve`,
        body: { fields: { endDate: '2026-12-31', requestRemark: '合成延长备注' }, comment: '合成意见' },
      },
    ]);
  });
  it('必填为空不提交，必填来源为详情 required', async () => {
    await render(fixture());
    await click('同意');
    await fill('新结束日期', '');
    await click('保存');
    expect(posts).toHaveLength(0);
    expect(dialog().textContent).toContain('请填写');
  });
  it('同一日期字段 required=false 时允许清空', async () => {
    await render(fixture('with_approve', false));
    await click('同意');
    await fill('新结束日期', '');
    await click('保存');
    expect(posts[0]?.body).toEqual({ fields: { endDate: null, requestRemark: '节点当前备注' }, comment: null });
  });
  it('没有 edit 时保留仅意见弹窗与旧请求体', async () => {
    await render(fixture('none'));
    await click('同意');
    expect(dialog().querySelectorAll('input')).toHaveLength(0);
    expect(dialog().querySelectorAll('textarea')).toHaveLength(1);
    await click('保存');
    expect(posts[0]?.body).toEqual({ comment: null });
  });
  it('separate 有编辑入口且走 edit，只提交 fields；同意不混入业务字段', async () => {
    const detail = fixture('separate');
    await render(detail);
    await click('编辑');
    expect(input('新结束日期')?.value).toBe('2026-12-15');
    expect(dialog().textContent).not.toContain('审批意见');
    await fill('延长备注', '独立编辑');
    await click('保存');
    expect(posts[0]).toMatchObject({
      path: `/api/tenant/approval/tasks/${detail.form.edit!.taskId}/edit`,
      body: { fields: { endDate: '2026-12-15', requestRemark: '独立编辑' } },
    });
    await click('同意');
    expect(input('新结束日期')).toBeNull();
    await click('保存');
    expect(posts[1]?.body).toEqual({ comment: null });
  });
  it('403 明确拒绝后保留输入、展示原因并允许修正', async () => {
    responseStatus = 403;
    await render(fixture());
    await click('同意');
    await fill('新结束日期', '2026-12-31');
    await fill('延长备注', '保留输入');
    await click('保存');
    expect(posts).toHaveLength(1);
    expect(input('新结束日期').value).toBe('2026-12-31');
    expect(input('延长备注').value).toBe('保留输入');
    expect(dialog().textContent).toContain('本节点不可编辑此字段');
    expect(button('保存').disabled).toBe(false);
  });
  it('未知字段只读显示当前值，不把它或详情其他值写入 fields', async () => {
    const detail = fixture();
    detail.form.edit!.fields.push({ key: 'futureField', required: false, value: '合成未知值' });
    await render(detail);
    await click('同意');
    expect(dialog().textContent).toContain('合成未知值');
    expect(input('futureField')).toBeNull();
    await click('保存');
    expect(posts[0]?.body).toEqual({ fields: { endDate: '2026-12-15', requestRemark: '节点当前备注' }, comment: null });
  });
});

describe('AC-FE-F267 字段复用和恢复边界', () => {
  it('新增的六类字段复用兼职控件，partTimeType 保留接口键名', async () => {
    const detail = fixture();
    detail.approvalType = 'part_time_add';
    const values = {
      partTimeType: 'part_time',
      endDate: '2026-12-15',
      departmentId: 'synthetic-org',
      directManagerId: 'synthetic-manager',
      postId: 'synthetic-post',
      levelId: 'synthetic-level',
    };
    detail.form.edit!.fields = Object.entries(values).map(([key, value]) => ({
      key,
      value,
      required: ['partTimeType', 'departmentId'].includes(key),
    }));
    // F-291 新增节点还下发该键；本片控件范围之外，沿 DEC-655 只读兜底且不回传。
    detail.form.edit!.fields.push({ key: 'isDepartmentHead', required: false, value: false });
    await render(detail);
    await click('同意');
    for (const label of ['兼职类型', '结束日期', '兼职部门', '兼职直线经理', '兼职职务', '职级'])
      expect(input(label), label).not.toBeNull();
    expect(dialog().querySelectorAll('[role="combobox"]')).toHaveLength(5);
    expect(dialog().textContent).toContain('是否部门负责人');
    expect(input('是否部门负责人')).toBeNull();
    await click('保存');
    expect(posts[0]?.body).toEqual({ fields: values, comment: null });
  });
  it('结束使用结束日期和结束备注，不沿用延长文案', async () => {
    const detail = fixture();
    detail.approvalType = 'part_time_end';
    await render(detail);
    await click('同意');
    await fill('结束日期', '2026-12-31');
    await fill('结束备注', '合成结束理由');
    await click('保存');
    expect(posts[0]?.body).toEqual({ fields: { endDate: '2026-12-31', requestRemark: '合成结束理由' }, comment: null });
  });
  it.each([400, 409, 422])('%i 明确业务拒绝保留输入且不锁死', async (status) => {
    responseStatus = status;
    responseCode = status === 409 ? 'CONFLICT' : 'VALIDATION_FAILED';
    if (status === 409) errorDetails = { reason: 'APPROVAL_EDIT_MODE' };
    if (status === 400) errorDetails = { reason: 'APPROVAL_FIELD_REQUIRED', field: 'endDate' };
    if (status === 422) errorDetails = [{ path: ['fields', 'endDate'], message: '合成日期校验原因' }];
    await render(fixture());
    await click('同意');
    await fill('新结束日期', '2026-12-31');
    await click('保存');
    expect(input('新结束日期').value).toBe('2026-12-31');
    expect(button('保存').disabled).toBe(false);
    expect(dialog().textContent).toContain(status === 422 ? '合成日期校验原因' : '本节点不可编辑此字段');
  });
  it('结果未知关闭重开仍锁定输入，不产生第二条命令', async () => {
    responseStatus = 0;
    await render(fixture());
    await click('同意');
    await fill('延长备注', '未知草稿');
    await click('保存');
    expect(dialog().textContent).toContain('结果待确认');
    await click('取消');
    await click('同意');
    expect(input('延长备注').value).toBe('未知草稿');
    expect(input('延长备注').disabled).toBe(true);
    expect(button('保存').disabled).toBe(true);
    await click('回查原单');
    expect(button('保存').disabled).toBe(true);
    expect(posts).toHaveLength(1);
  });
  it('冲突重读保留改过字段，未改字段取最新，确认后带新 revision 提交', async () => {
    responseStatus = 409;
    responseCode = 'REVISION_CONFLICT';
    const detail = fixture();
    await render(detail);
    await click('同意');
    await fill('延长备注', '保留我的备注');
    await click('保存');
    detail.revision = 5;
    detail.form.edit!.fields[0]!.value = '2027-01-01';
    detail.form.edit!.fields[1]!.value = '服务端新备注';
    await click('重读最新版本');
    expect(input('新结束日期').value).toBe('2027-01-01');
    expect(input('延长备注').value).toBe('保留我的备注');
    await click('已核对差异，继续编辑');
    responseStatus = 200;
    await click('保存');
    expect(posts.map((post) => post.revision)).toEqual(['4', '5']);
    expect(posts[1]?.commandId).not.toBe(posts[0]?.commandId);
    expect(posts[1]?.body).toEqual({ fields: { endDate: '2027-01-01', requestRemark: '保留我的备注' }, comment: null });
  });
  it('请求投影剔除未下发字段；其他动作不带业务字段', () => {
    const detail = fixture();
    expect(approvalRequest(detail, 'approve', detail.taskId, { endDate: '2026-12-31', secret: '不提交' }).body).toEqual(
      { comment: null, fields: { endDate: '2026-12-31' } },
    );
    detail.actions.push('reject');
    expect(approvalRequest(detail, 'reject', detail.taskId, { endDate: '2026-12-31', comment: '驳回' }).body).toEqual({
      comment: '驳回',
    });
  });
  it('actions 不含 edit 或缺少 separate 元数据时没有编辑入口', async () => {
    const detail = fixture('with_approve');
    detail.actions.push('edit');
    await render(detail);
    expect(button('编辑')).toBeUndefined();
    const withoutAction = fixture('separate');
    withoutAction.actions = ['approve'];
    await render(withoutAction);
    expect(button('编辑')).toBeUndefined();
  });
});
