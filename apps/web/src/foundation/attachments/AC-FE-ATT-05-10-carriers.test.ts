// @vitest-environment happy-dom
/**
 * F-479 S5 AC-FE-ATT-05～08、10 的组件层：本人离职表单附件字段、三个载体（申请详情 / 审批详情 / HR 离职详情）。
 * 后端形状照 S2 真实投影：`attachmentRefs` 与 `attachments`（id、filename、contentType、byteSize、uploadedAt）
 * 同权限出现，无字段权两个键都缺席（apps/api/src/modules/attachments/carrier-read.ts）。期望文案手写自设计 §5.2、§5.3。
 */
import { Form } from 'antd';
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentBackend, pngBytes } from '../../../smoke/attachment-fixtures.js';
import { ApprovalFields } from '../../approval/ApprovalDetail.js';
import type { ApprovalDetail } from '../../approval/types.js';
import { ExitFields } from '../../exit/ExitFields.js';
import { detailKeys, type Row } from '../../exit/exit-model.js';
import { fieldValue } from '../../exit/ExitDetail.js';
import { SelfRequestInfo } from '../../self-service/pages/SelfRequest.js';
import { requestFields, selfRequestBody } from '../../self-service/pages/request-model.js';
import { SessionProvider } from '../Session.js';
import { AttachmentRefsInput, attachmentViews, type AttachmentView } from './index.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const EXIT = '44444444-4444-4444-8444-444444444444';
const INSTANCE = '55555555-5555-4555-8555-555555555555';
const session = {
  tenantId: TENANT,
  identityKey: 'employee:合成员工甲',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '测试员工甲',
  source: 'server' as const,
};
const REASON_CODE = /[A-Z][A-Z0-9]*_[A-Z0-9_]+/;

let container: HTMLDivElement;
let root: Root | undefined;
let backend: AttachmentBackend;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  backend = new AttachmentBackend(TENANT);
  vi.spyOn(globalThis, 'fetch').mockImplementation(backend.fetch);
  let sequence = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:合成/${++sequence}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
}
async function mount(node: ReactNode) {
  root = createRoot(container);
  await act(async () => root!.render(h(SessionProvider, { session, children: node })));
  await settle();
}
const text = () => container.textContent ?? '';
const images = () => [...container.querySelectorAll('img')];

/** 后端载体投影里的一项（carrier-read.ts attachmentSummaries 的形状）。 */
function summary(index: number): AttachmentView {
  return {
    id: `33333333-3333-4333-8333-00000000000${index}`,
    filename: `手写${index}.png`,
    contentType: 'image/png',
    byteSize: 1024 * index,
    uploadedAt: '2026-11-07T02:00:00.000Z',
  };
}
/** 已绑定文件的内容只在其载体路由上可读；同一文件换载体读不到（与后端 §3.2 一致）。 */
function serve(carrier: string, owner: string, items: AttachmentView[]) {
  for (const [index, item] of items.entries())
    backend.carrier.set(`/api/tenant/${carrier}/${owner}/attachments/${item.id}/content`, {
      bytes: pngBytes(index + 1),
      contentType: 'image/png',
    });
}
function expectCarrierReads(carrier: string, owner: string, items: AttachmentView[]) {
  const reads = backend.calls.filter((call) => call.path.includes('/attachments/') && call.method === 'GET');
  expect(reads.map((call) => call.path).sort()).toEqual(
    items.map((item) => `/api/tenant/${carrier}/${owner}/attachments/${item.id}/content`).sort(),
  );
  expect(reads.every((call) => call.headers.get('x-tenant-id') === TENANT)).toBe(true);
  expect(images().map((img) => img.getAttribute('src'))).toEqual(items.map((_, index) => `blob:合成/${index + 1}`));
  // 页面不得出现直连内容接口的 src / href（原生请求带不上租户头，§5.4）
  expect(container.querySelector('[src^="/api/"], [href^="/api/"]')).toBeNull();
  expect(text()).not.toMatch(REASON_CODE);
}

describe('AC-FE-ATT-05 本人离职表单：附件字段随字段模式出现，保存体带 ID 数组', () => {
  it('requestFields.exit 含 attachmentRefs；保存体把清空的附件写成空数组（后端拒收 null）', () => {
    expect(requestFields.exit).toContain('attachmentRefs');
    const ids = [summary(1).id, summary(2).id];
    expect(selfRequestBody('exit', { lastWorkDate: '2026-12-01', attachmentRefs: ids }, ['attachmentRefs'])).toEqual({
      attachmentRefs: ids,
    });
    expect(selfRequestBody('exit', { attachmentRefs: null }, ['lastWorkDate', 'attachmentRefs'])).toEqual({
      attachmentRefs: [],
    });
    expect(selfRequestBody('exit', { attachmentRefs: ids }, ['lastWorkDate'])).toEqual({});
  });

  const permission = (editable: string[]) => ({
    objectCode: '',
    dataOperations: { create: true, update: true },
    buttons: [],
    viewableFields: ['lastWorkDate', 'attachmentRefs'],
    editableFields: editable,
  });
  function SelfForm({ editable, values, attachments }: { editable: string[]; values: object; attachments?: object }) {
    const [form] = Form.useForm();
    // 本人表单（black=false）才传 attachments；HR 表单不传，附件字段不得出现（Q-10）
    const props = { black: false, permission: permission(editable), editable, attachments };
    return h(Form, { form, initialValues: values, children: h(ExitFields, props as never) });
  }

  it('可编辑：标签、说明、“上传”按钮；已有两张按本人载体带租户头读成 blob 缩略图', async () => {
    const items = [summary(1), summary(2)];
    serve('self-service/exit-requests', EXIT, items);
    const attachments = { ownerId: EXIT, views: items, readonly: false, onBusyChange: () => {} };
    await mount(
      h(SelfForm, {
        editable: ['lastWorkDate', 'attachmentRefs'],
        values: { attachmentRefs: items.map((item) => item.id) },
        attachments,
      }),
    );
    expect(text()).toContain('手写离职申请附件');
    expect(text()).toContain('请拍照上传手写离职申请');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent?.replace(/\s/g, '') === '上传')).toBe(
      true,
    );
    expectCarrierReads('self-service/exit-requests', EXIT, items);
  });

  it('只读（审批中 / 无编辑权）：只显示缩略图与下载，不出现“上传”与“删除”', async () => {
    const items = [summary(1)];
    serve('self-service/exit-requests', EXIT, items);
    const attachments = { ownerId: EXIT, views: items, readonly: true, onBusyChange: () => {} };
    await mount(h(SelfForm, { editable: ['lastWorkDate'], values: { attachmentRefs: [items[0]!.id] }, attachments }));
    expect(text()).toContain('手写离职申请附件');
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent?.replace(/\s/g, ''));
    expect(labels).toContain('下载');
    expect(labels).not.toContain('上传');
    expect(labels).not.toContain('删除');
    expectCarrierReads('self-service/exit-requests', EXIT, items);
  });

  it('HR 共用 ExitFields 但不传 attachments：没有附件字段', async () => {
    await mount(h(SelfForm, { editable: ['lastWorkDate', 'attachmentRefs'], values: {} }));
    expect(text()).not.toContain('手写离职申请附件');
  });
});

describe('AC-FE-ATT-05 / 08 我的申请详情：按本人载体显示缩略图', () => {
  const record = (items: AttachmentView[]) => ({
    id: EXIT,
    employeeId: '66666666-6666-4666-8666-666666666666',
    revision: 3,
    status: 'in_review',
    lastWorkDate: '2026-12-01',
    attachmentRefs: items.map((item) => item.id),
    attachments: items,
  });

  it('两张：标签“手写离职申请附件”，两张 blob 缩略图，不把 ID 当文本显示', async () => {
    const items = [summary(1), summary(2)];
    serve('self-service/exit-requests', EXIT, items);
    await mount(h(SelfRequestInfo, { kind: 'exit', record: record(items) }));
    expect(text()).toContain('手写离职申请附件');
    expect(text()).toContain('手写1.png');
    expect(text()).not.toContain(items[0]!.id);
    expectCarrierReads('self-service/exit-requests', EXIT, items);
  });

  it('无字段权（两个键都缺席）：不渲染附件区', async () => {
    const { attachmentRefs: _refs, attachments: _items, ...rest } = record([summary(1)]);
    await mount(h(SelfRequestInfo, { kind: 'exit', record: rest }));
    expect(text()).not.toContain('手写离职申请附件');
    expect(images()).toHaveLength(0);
  });
});

describe('AC-FE-ATT-06 / 07 / 08 审批详情：attachmentRefs 按 attachments 展开', () => {
  const detail = (values: Record<string, unknown>) =>
    ({
      id: INSTANCE,
      title: '合成员工的离职申请',
      revision: 2,
      status: 'running',
      approvalType: 'leave',
      actions: ['approve', 'reject'],
      form: { values },
      tasks: [],
      logs: [],
    }) as unknown as ApprovalDetail;

  it('有字段权：一行“手写离职申请附件”，缩略图走审批载体；attachments 不再单列一行', async () => {
    const items = [summary(1), summary(2)];
    serve('approval/instances', INSTANCE, items);
    await mount(
      h(ApprovalFields, {
        detail: detail({ lastWorkDate: '2026-12-01', attachmentRefs: items.map((i) => i.id), attachments: items }),
      }),
    );
    const labels = [...container.querySelectorAll('.approval-field dt')].map((dt) => dt.textContent);
    expect(labels).toHaveLength(2);
    expect(labels.at(-1)).toBe('手写离职申请附件');
    expect(labels).not.toContain('attachments');
    expect(text()).not.toContain(items[0]!.id);
    expectCarrierReads('approval/instances', INSTANCE, items);
  });

  it('新一轮只剩一张：只显示剩下那张', async () => {
    const items = [summary(2)];
    serve('approval/instances', INSTANCE, items);
    await mount(h(ApprovalFields, { detail: detail({ attachmentRefs: [items[0]!.id], attachments: items }) }));
    expect(text()).toContain('手写2.png');
    expect(text()).not.toContain('手写1.png');
    expectCarrierReads('approval/instances', INSTANCE, items);
  });

  it('无字段权 / 节点表单不含该字段：两个键都缺席，不渲染附件区', async () => {
    await mount(h(ApprovalFields, { detail: detail({ lastWorkDate: '2026-12-01' }) }));
    expect(text()).not.toContain('手写离职申请附件');
    expect(images()).toHaveLength(0);
  });
});

describe('AC-FE-ATT-10 HR 离职详情：同一展示组件，地址指向 HR 载体', () => {
  const row = (items?: AttachmentView[]) =>
    ({
      id: EXIT,
      status: 'in_review',
      revision: 4,
      lastWorkDate: '2026-12-01',
      ...(items ? { attachmentRefs: items.map((item) => item.id), attachments: items } : {}),
    }) as unknown as Row;

  it('有字段权：详情项含“手写离职申请附件”，按 HR 载体读成 blob 缩略图', async () => {
    const items = [summary(1), summary(2)];
    serve('employment/exits', EXIT, items);
    expect(detailKeys(row(items))).toContain('attachmentRefs');
    await mount(fieldValue(row(items), 'attachmentRefs'));
    expect(text()).toContain('手写2.png');
    expectCarrierReads('employment/exits', EXIT, items);
  });

  it('无字段权：详情项里没有该键', () => {
    expect(detailKeys(row())).not.toContain('attachmentRefs');
  });
});

describe('AC-FE-ATT-05 / 08 表单字段适配：表单里存 ID 数组，控件里是展示项', () => {
  it('attachmentViews 只收形状正确的项；缺键或非数组得到空列表', () => {
    const good = summary(1);
    expect(attachmentViews([good, { filename: '无编号.png' }, null, 'x'])).toEqual([good]);
    expect(attachmentViews(undefined)).toEqual([]);
  });

  it('删除已绑定的一张：表单值按 ID 去掉那张，不发删除请求，剩下的仍走本人载体', async () => {
    const items = [summary(1), summary(2)];
    serve('self-service/exit-requests', EXIT, items);
    const seen: unknown[] = [];
    function Probe() {
      const [form] = Form.useForm();
      const ids = Form.useWatch('attachmentRefs', form) as unknown;
      seen.push(ids);
      return h(Form, {
        form,
        initialValues: { attachmentRefs: items.map((item) => item.id) },
        children: h(Form.Item, {
          name: 'attachmentRefs',
          children: h(AttachmentRefsInput, {
            purpose: 'exit.handwritten_application',
            carrier: 'selfExit',
            ownerId: EXIT,
            views: items,
          }),
        }),
      });
    }
    await mount(h(Probe));
    const row = [...container.querySelectorAll('[data-attachment]')].find((li) => li.textContent?.includes('手写2'));
    const remove = [...row!.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s/g, '') === '删除');
    await act(async () => remove!.click());
    await settle();
    expect(seen.at(-1)).toEqual([items[0]!.id]);
    expect(text()).not.toContain('手写2.png');
    expect(backend.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });
});
