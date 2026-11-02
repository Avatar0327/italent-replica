// @vitest-environment happy-dom
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../foundation/Session.js';
import { ApprovalDetail } from './ApprovalDetail.js';
import type { ApprovalDetail as Detail } from './types.js';

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let posts: { path: string; body: Record<string, unknown> }[];
let reject: boolean;
const dateRequired = '提前转正 / 延期转正须填写转正日期';
/**
 * 形状照 assessment-approval-adapter.ts snapshot：form.values = ASSESSMENT_FORM_FIELDS；经理评价节点可编辑
 * managerRating / regularizationOpinion / regularizationDate（presets.ts，with_approve，考核类型不在 APPROVAL_EDIT_REQUIRED）。
 */
function fixture(editable = ['managerRating', 'regularizationOpinion', 'regularizationDate']): Detail {
  const values = {
    assessmentName: '合成试用中考核',
    assessmentDate: '2026-10-20',
    selfEvaluation: '合成自评',
    managerRating: null,
    regularizationOpinion: null,
    regularizationDate: null,
  };
  return {
    id: '70000000-0000-4000-8000-000000000297',
    taskId: '50000000-0000-4000-8000-000000000297',
    title: '试用中考核申请',
    revision: 3,
    status: 'running',
    approvalType: 'probation_assessment',
    actions: ['approve'],
    recordsHidden: false,
    form: {
      values,
      edit: {
        taskId: '50000000-0000-4000-8000-000000000298',
        mode: 'with_approve',
        fields: editable.map((key) => ({
          key,
          required: false,
          value: values[key as keyof typeof values],
        })),
      },
    },
    tasks: [],
    logs: [],
  };
}
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')];
const button = (text: string) => buttons().find((node) => node.textContent?.replace(/\s/g, '') === text)!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const control = (label: string) => dialog().querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
async function click(text: string) {
  expect(button(text), `按钮 ${text}`).toBeDefined();
  await act(async () => {
    button(text).click();
    await settle();
  });
}
async function fill(label: string, value: string) {
  const node = control(label);
  expect(node, `控件 ${label}`).not.toBeNull();
  await act(async () => {
    const proto = node.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  });
}
async function render(detail: Detail) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ path, body: JSON.parse(String(init.body)) });
        // 后端 assessment.ts mergedPatch → assessmentOpinionViolation：400 VALIDATION_FAILED，details.reason
        if (reject)
          return Response.json(
            {
              error: {
                code: 'VALIDATION_FAILED',
                message: dateRequired,
                details: { reason: 'ASSESSMENT_DATE_REQUIRED' },
              },
            },
            { status: 400 },
          );
        return Response.json({ ...detail, revision: detail.revision + 1 });
      }
      return Response.json(path.includes('/approval/') ? detail : { items: [] });
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
  reject = false;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('AC-FE-F297 考核审批编辑：转正意见 / 转正日期联动', () => {
  it('按 editableFields 给经理评价、转正意见、转正日期配控件，选项取考核字典', async () => {
    await render(fixture());
    await click('同意');
    expect(control('经理评价').tagName).toBe('SELECT');
    expect(control('转正意见').tagName).toBe('SELECT');
    expect([...control('转正意见').querySelectorAll('option')].map((node) => node.textContent)).toEqual([
      '请选择',
      '正常转正',
      '提前转正',
      '延期转正',
      '不通过',
      '延期试用',
    ]);
    expect(control('转正日期').getAttribute('type')).toBe('date');
    expect(dialog().textContent).not.toContain(dateRequired);
  });
  it('选提前转正：转正日期标为必填并提示，空着不提交；填了才提交', async () => {
    await render(fixture());
    await click('同意');
    await fill('经理评价', 'exceeds');
    await fill('转正意见', 'early');
    expect(control('转正日期').getAttribute('aria-required')).toBe('true');
    expect(dialog().querySelector('[role="note"]')?.textContent).toContain(dateRequired);
    await click('保存');
    expect(posts).toHaveLength(0);
    await fill('转正日期', '2026-11-01');
    await click('保存');
    expect(posts.map(({ body }) => body.fields)).toEqual([
      { managerRating: 'exceeds', regularizationOpinion: 'early', regularizationDate: '2026-11-01' },
    ]);
  });
  it('清空意见取消必填与错误提示，可不填日期提交', async () => {
    await render(fixture());
    await click('同意');
    await fill('转正意见', 'delayed');
    await click('保存');
    expect(posts).toHaveLength(0);
    // antd 错误文案有入场动画，happy-dom 下以字段校验态为准
    expect(control('转正日期').getAttribute('aria-invalid')).toBe('true');
    await fill('转正意见', '');
    expect(control('转正日期').getAttribute('aria-required')).toBe('false');
    expect(dialog().querySelector('[role="note"]')).toBeNull();
    expect(control('转正日期').getAttribute('aria-invalid')).not.toBe('true');
    await click('保存');
    expect(posts[0]?.body.fields).toEqual({
      managerRating: null,
      regularizationOpinion: null,
      regularizationDate: null,
    });
  });
  it('自定义节点开放考核日期：按 edit.fields 给可编辑的日期控件并随提交发送（P2-5）', async () => {
    await render(fixture(['assessmentDate', 'managerRating']));
    await click('同意');
    expect(control('考核日期').getAttribute('type')).toBe('date');
    expect(control('考核日期').value).toBe('2026-10-20');
    await fill('考核日期', '2026-10-25');
    await fill('经理评价', 'meets');
    await click('保存');
    expect(posts.map(({ body }) => body.fields)).toEqual([{ assessmentDate: '2026-10-25', managerRating: 'meets' }]);
  });
  it('后端以 ASSESSMENT_DATE_REQUIRED 拒绝：保留输入、显示原因、可修正后重提', async () => {
    reject = true;
    await render(fixture());
    await click('同意');
    await fill('转正意见', 'normal');
    await fill('经理评价', 'meets');
    await click('保存');
    expect(posts).toHaveLength(1);
    expect(dialog().textContent).toContain(dateRequired);
    expect(control('转正意见').value).toBe('normal');
    expect(control('经理评价').value).toBe('meets');
    expect(button('保存').disabled).toBe(false);
  });
});
