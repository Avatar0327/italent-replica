// @vitest-environment happy-dom
/**
 * F-479 S4 AC-FE-ATT-01～04：通用上传控件（设计 §5.1、§5.1.1 上传恢复）。
 * 接口替身照后端真实形状（apps/web/smoke/attachment-fixtures.ts），期望文案手写自设计 §5.1 文案表。
 */
import { act, createElement as h, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_PURPOSE, AttachmentBackend, pngBytes, receiptOf } from '../../../smoke/attachment-fixtures.js';
import { SessionProvider } from '../Session.js';
import { ImageAttachments, type AttachmentView } from './index.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const session = {
  tenantId: TENANT,
  identityKey: 'employee:合成员工甲',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '测试员工甲',
  source: 'server' as const,
};
const UPLOAD = /^\/api\/tenant\/attachments\/[0-9a-f-]{36}\/upload$/;
const META = /^\/api\/tenant\/attachments\/[0-9a-f-]{36}$/;
const REGISTER = /^\/api\/tenant\/attachments$/;
const REASON_CODE = /[A-Z][A-Z0-9]*_[A-Z0-9_]+/;

let container: HTMLDivElement;
let root: Root | undefined;
let backend: AttachmentBackend;
let changes: AttachmentView[][];
let busy: boolean[];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  backend = new AttachmentBackend(TENANT);
  vi.spyOn(globalThis, 'fetch').mockImplementation(backend.fetch);
  let sequence = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:合成/${++sequence}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  changes = [];
  busy = [];
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

function Host({ initial }: { initial: AttachmentView[] }) {
  const [value, setValue] = useState(initial);
  return h(ImageAttachments, {
    purpose: ATTACHMENT_PURPOSE,
    value,
    onChange: (next: AttachmentView[]) => {
      changes.push(next);
      setValue(next);
    },
    onBusyChange: (next: boolean) => busy.push(next),
    contentPath: (item: AttachmentView) =>
      `/api/tenant/self-service/exit-requests/${OWNER}/attachments/${item.id}/content`,
  });
}
const OWNER = '22222222-2222-4222-8222-222222222222';

async function mount(initial: AttachmentView[] = []) {
  root = createRoot(container);
  await act(async () => root!.render(h(SessionProvider, { session }, h(Host, { initial }))));
  await settle(2);
}

async function choose(files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

const buttons = (name: string) =>
  [...container.querySelectorAll('button')].filter((item) => item.textContent?.replace(/\s/g, '') === name);
async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}
const png = (name: string, fill = 1) => new File([pngBytes(fill) as BlobPart], name, { type: 'image/png' });
const text = () => container.textContent ?? '';

function bound(index: number): AttachmentView {
  return {
    id: `33333333-3333-4333-8333-00000000000${index}`,
    filename: `已绑定${index}.png`,
    contentType: 'image/png',
    byteSize: 32,
    uploadedAt: '2026-11-07T02:00:00.000Z',
  };
}

describe('AC-FE-ATT-01 本地先校验，超限不发请求', () => {
  it('一次选 6 张：整批不发请求，就地显示“总文件数不能超过5个”', async () => {
    await mount();
    await choose([1, 2, 3, 4, 5, 6].map((i) => png(`第${i}张.png`, i)));
    expect(text()).toContain('总文件数不能超过5个');
    expect(backend.calls).toHaveLength(0);
  });

  it('已有 3 张再选 3 张同样超限，不发请求', async () => {
    await mount([bound(1), bound(2), bound(3)]);
    const before = backend.calls.length;
    await choose([png('a.png'), png('b.png'), png('c.png')]);
    expect(text()).toContain('总文件数不能超过5个');
    expect(backend.calledWith('POST', REGISTER)).toHaveLength(0);
    expect(backend.calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
    expect(backend.calls.length - before).toBe(0);
  });

  it('11MB 与 .webp 各自就地提示、不发请求；同批合格的那张照常上传', async () => {
    await mount();
    const big = new File([new Uint8Array(11 * 1024 * 1024) as BlobPart], '过大.png', { type: 'image/png' });
    const webp = new File([new Uint8Array(16) as BlobPart], '动图.webp', { type: 'image/webp' });
    await choose([big, webp, png('合格.png')]);
    expect(text()).toContain('文件大小不能超过10MB');
    expect(text()).toContain('文件格式错误');
    const registered = backend.calledWith('POST', REGISTER);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.body).toMatchObject({ purpose: ATTACHMENT_PURPOSE, filename: '合格.png' });
    expect(changes.at(-1)?.map((item) => item.filename)).toEqual(['合格.png']);
  });

  it('已有 5 张时“上传”置灰，文件选择框也不可用', async () => {
    await mount([1, 2, 3, 4, 5].map(bound));
    const [upload] = buttons('上传');
    expect(upload).toBeDefined();
    expect(upload!.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')!.accept).toBe('.jpg,.jpeg,.png,.gif,.bmp');
  });
});

describe('AC-FE-ATT-02 上传结果未知：先回查元数据，已上传不重传', () => {
  it('上传已提交但响应丢失：点重试先 GET /attachments/:id，已上传就以回执入列，不再 POST upload', async () => {
    await mount();
    backend.inject('POST', UPLOAD, 'lost');
    await choose([png('响应丢失.png')]);
    expect(text()).toContain('上传结果未知，请重试（重试前会先确认是否已上传成功）');
    expect(changes).toHaveLength(0);
    const uploadsBefore = backend.calledWith('POST', UPLOAD).length;
    const metaBefore = backend.calledWith('GET', META).length;

    await click(buttons('重试')[0]!);
    expect(backend.calledWith('GET', META).length).toBe(metaBefore + 1);
    expect(backend.calledWith('POST', UPLOAD).length).toBe(uploadsBefore);
    const [file] = [...backend.files.values()];
    expect(changes.at(-1)).toEqual([
      expect.objectContaining({ id: file!.id, filename: '响应丢失.png', temporary: { revision: 2 } }),
    ]);
    expect(text()).not.toContain('上传结果未知');
  });

  it('上传请求没到服务端：回查为 registered 后用原上传命令 ID、原 If-Match 重发', async () => {
    await mount();
    backend.inject('POST', UPLOAD, 'network');
    await choose([png('没送达.png')]);
    expect(text()).toContain('上传结果未知');
    await click(buttons('重试')[0]!);
    const uploads = backend.calledWith('POST', UPLOAD);
    expect(uploads).toHaveLength(2);
    expect(uploads[1]!.headers.get('idempotency-key')).toBe(uploads[0]!.headers.get('idempotency-key'));
    expect(uploads[1]!.headers.get('if-match')).toBe(uploads[0]!.headers.get('if-match'));
    expect(uploads[1]!.body).toEqual(uploads[0]!.body);
    const metaIndex = backend.calls.findIndex((call) => call.method === 'GET' && META.test(call.path));
    expect(metaIndex).toBeLessThan(backend.calls.indexOf(uploads[1]!));
    expect(changes.at(-1)?.map((item) => item.filename)).toEqual(['没送达.png']);
  });

  it('回查 404（过期或被清理）：提示“附件已失效，请重新选择”并移出待传列表，不自动重新登记', async () => {
    await mount();
    backend.inject('POST', UPLOAD, 'network');
    await choose([png('已过期.png')]);
    for (const file of backend.files.values()) file.status = 'pending_cleanup';
    await click(buttons('重试')[0]!);
    expect(text()).toContain('附件已失效，请重新选择');
    expect(buttons('重试')).toHaveLength(0);
    expect(backend.calledWith('POST', REGISTER)).toHaveLength(1);
    expect(changes).toHaveLength(0);
  });
});

describe('AC-FE-ATT-03 上传中卸载，迟到回调不写状态', () => {
  it('登记请求在途时卸载：请求被中止、无状态写入警告、不回调 onChange；回来后以服务端给的列表为准', async () => {
    const errors = vi.spyOn(console, 'error');
    const warnings = vi.spyOn(console, 'warn');
    let release: (response: Response) => void = () => {};
    backend.inject('POST', REGISTER, () => new Promise<Response>((resolve) => (release = resolve)));
    await mount();
    await choose([png('在途.png')]);
    expect(text()).toContain('附件上传中');
    expect(busy.at(-1)).toBe(true);
    const [call] = backend.calledWith('POST', REGISTER);

    act(() => root!.unmount());
    root = undefined;
    expect(call!.signal?.aborted).toBe(true);
    const late = backend.add({ filename: '在途.png' });
    release(Response.json(receiptOf(late), { status: 201 }));
    await settle();
    expect(changes).toHaveLength(0);
    expect(backend.calledWith('POST', UPLOAD)).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();

    const saved = bound(1);
    backend.carrier.set(`/api/tenant/self-service/exit-requests/${OWNER}/attachments/${saved.id}/content`, {
      bytes: pngBytes(),
      contentType: 'image/png',
    });
    await mount([saved]);
    await settle();
    expect(text()).toContain('已绑定1.png');
    expect(text()).not.toContain('在途.png');
    expect(text()).not.toContain('附件上传中');
    expect(container.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/);
  });

  it('全部完成后 busy 回到 false，提示消失', async () => {
    await mount();
    await choose([png('一张.png')]);
    expect(busy).toContain(true);
    expect(busy.at(-1)).toBe(false);
    expect(text()).not.toContain('附件上传中');
  });
});

describe('AC-FE-ATT-04 后端拒绝显示中文文案，页面无英文原因码', () => {
  it('415（文件头不是位图）→ 文件格式错误', async () => {
    await mount();
    await choose([new File([new TextEncoder().encode('<html>伪装</html>') as BlobPart], '伪装.png')]);
    expect(text()).toContain('文件格式错误');
    expect(text()).not.toMatch(REASON_CODE);
    expect(text()).not.toContain('仅支持');
  });

  it('409 ATTACHMENT_TEMP_LIMIT → 未保存的附件过多，请先保存草稿或删除不需要的图片', async () => {
    backend.seedTemporary(20);
    await mount();
    await choose([png('第21张.png')]);
    expect(text()).toContain('未保存的附件过多，请先保存草稿或删除不需要的图片');
    expect(text()).not.toMatch(REASON_CODE);
  });

  it('429：中文提示，Retry-After 期间“重试”禁用，到期后可重试且沿用原命令 ID', async () => {
    backend.inject('POST', REGISTER, () =>
      Response.json(
        { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
        { status: 429, headers: { 'retry-after': '1' } },
      ),
    );
    await mount();
    await choose([png('限流.png')]);
    expect(text()).toContain('请求过于频繁');
    expect(text()).not.toMatch(REASON_CODE);
    expect(text()).not.toContain('Too many');
    expect(buttons('重试')[0]!.disabled).toBe(true);

    await act(() => new Promise((resolve) => setTimeout(resolve, 1100)));
    await settle(2);
    const retry = buttons('重试')[0]!;
    expect(retry.disabled).toBe(false);
    await click(retry);
    const registers = backend.calledWith('POST', REGISTER);
    expect(registers).toHaveLength(2);
    expect(registers[1]!.headers.get('idempotency-key')).toBe(registers[0]!.headers.get('idempotency-key'));
    expect(changes.at(-1)?.map((item) => item.filename)).toEqual(['限流.png']);
  });
});

describe('设计 §5.1 删除', () => {
  it('临时文件点删除立即 DELETE（带 If-Match）；已绑定文件只从值里移除，不发请求', async () => {
    await mount([bound(1)]);
    await choose([png('临时.png')]);
    const temporary = changes.at(-1)!.find((item) => item.temporary)!;
    const removeTemporary = container.querySelector<HTMLButtonElement>(`[data-attachment="${temporary.id}"] .remove`)!;
    await click(removeTemporary);
    const [deleted] = backend.calledWith('DELETE', META);
    expect(deleted!.path).toBe(`/api/tenant/attachments/${temporary.id}`);
    expect(deleted!.headers.get('if-match')).toBe(String(temporary.temporary!.revision));
    expect(backend.files.get(temporary.id)!.status).toBe('pending_cleanup');
    expect(changes.at(-1)!.map((item) => item.id)).toEqual([bound(1).id]);

    const removeBound = container.querySelector<HTMLButtonElement>(`[data-attachment="${bound(1).id}"] .remove`)!;
    await click(removeBound);
    expect(backend.calledWith('DELETE', META)).toHaveLength(1);
    expect(changes.at(-1)).toEqual([]);
  });
});
