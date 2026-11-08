// @vitest-environment happy-dom
/**
 * F-479 S4 AC-FE-ATT-11：登记结果未知的恢复（设计 §5.1.1“登记恢复”）。
 * 登记请求网络失败后，回查 `GET /api/tenant/commands/<登记命令 ID>/result`：
 * succeeded → 不再登记，直接以 businessId 上传；failed → 确定失败文案，重试换新键；404 → 原键原体重发，拿到确定结果前不换键。
 * 结果接口与台账的行为照 command-result/service.ts 与 commands.ts（替身见 apps/web/smoke/attachment-fixtures.ts）。
 */
import { act, createElement as h, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_PURPOSE, AttachmentBackend, pngBytes } from '../../../smoke/attachment-fixtures.js';
import { SessionProvider } from '../Session.js';
import { ImageAttachments, type AttachmentView } from './index.js';

const TENANT = '44444444-4444-4444-8444-444444444444';
const session = {
  tenantId: TENANT,
  identityKey: 'employee:合成员工乙',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '测试员工乙',
  source: 'server' as const,
};
const REGISTER = /^\/api\/tenant\/attachments$/;
const UPLOAD = /^\/api\/tenant\/attachments\/([0-9a-f-]{36})\/upload$/;
const RESULT = /^\/api\/tenant\/commands\/[^/]+\/result$/;

let container: HTMLDivElement;
let root: Root | undefined;
let backend: AttachmentBackend;
let changes: AttachmentView[][];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  backend = new AttachmentBackend(TENANT);
  vi.spyOn(globalThis, 'fetch').mockImplementation(backend.fetch);
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:合成/1');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  changes = [];
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
function Host() {
  const [value, setValue] = useState<AttachmentView[]>([]);
  return h(ImageAttachments, {
    purpose: ATTACHMENT_PURPOSE,
    value,
    onChange: (next: AttachmentView[]) => {
      changes.push(next);
      setValue(next);
    },
  });
}
async function mountAndChoose(name: string) {
  root = createRoot(container);
  await act(async () => root!.render(h(SessionProvider, { session, children: h(Host) })));
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File([pngBytes(7) as BlobPart], name, { type: 'image/png' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}
const retryButton = () =>
  [...container.querySelectorAll('button')].find((item) => item.textContent?.replace(/\s/g, '') === '重试');
async function retry() {
  await act(async () => retryButton()!.click());
  await settle();
}
const keyOf = (call: { headers: Headers }) => call.headers.get('idempotency-key');
const text = () => container.textContent ?? '';

describe('AC-FE-ATT-11 登记结果未知的恢复', () => {
  it('结果接口 succeeded：不再登记，以 businessId 为附件 ID、revision 为 If-Match 直接上传', async () => {
    backend.inject('POST', REGISTER, 'lost');
    await mountAndChoose('已登记.png');
    expect(text()).toContain('上传结果未知，请重试（重试前会先确认是否已上传成功）');
    expect(backend.calledWith('POST', UPLOAD)).toHaveLength(0);
    const [file] = [...backend.files.values()];

    await retry();
    const [register] = backend.calledWith('POST', REGISTER);
    const [result] = backend.calledWith('GET', RESULT);
    expect(result!.path).toBe(`/api/tenant/commands/${encodeURIComponent(keyOf(register!)!)}/result`);
    expect(backend.calledWith('POST', REGISTER)).toHaveLength(1);
    const uploads = backend.calledWith('POST', UPLOAD);
    expect(uploads).toHaveLength(1);
    expect(UPLOAD.exec(uploads[0]!.path)![1]).toBe(file!.id);
    expect(uploads[0]!.headers.get('if-match')).toBe('1');
    expect(backend.files.size).toBe(1);
    expect(changes.at(-1)).toEqual([expect.objectContaining({ id: file!.id, filename: '已登记.png' })]);
  });

  it('结果接口 failed：按 httpStatus 显示确定失败文案；用户再点重试时用新键登记', async () => {
    backend.seedTemporary(20);
    backend.inject('POST', REGISTER, 'lost');
    await mountAndChoose('超出临时上限.png');
    await retry();
    expect(backend.calledWith('GET', RESULT)).toHaveLength(1);
    expect(backend.calledWith('POST', REGISTER)).toHaveLength(1);
    expect(text()).toContain('未保存的附件过多，请先保存草稿或删除不需要的图片');
    expect(text()).not.toContain('上传结果未知');

    for (const file of backend.files.values()) file.status = 'pending_cleanup';
    await retry();
    const registers = backend.calledWith('POST', REGISTER);
    expect(registers).toHaveLength(2);
    expect(keyOf(registers[1]!)).not.toBe(keyOf(registers[0]!));
    expect(registers[1]!.body).toEqual(registers[0]!.body);
    expect(changes.at(-1)?.map((item) => item.filename)).toEqual(['超出临时上限.png']);
  });

  it('结果接口 404：原键原体重发登记；重发仍未知时继续回查，确定前始终不换键', async () => {
    backend.inject('POST', REGISTER, 'network', 2);
    await mountAndChoose('未送达.png');
    await retry();
    expect(backend.calledWith('GET', RESULT)).toHaveLength(1);
    expect(backend.calledWith('POST', REGISTER)).toHaveLength(2);
    expect(text()).toContain('上传结果未知');

    await retry();
    const registers = backend.calledWith('POST', REGISTER);
    expect(backend.calledWith('GET', RESULT)).toHaveLength(2);
    expect(registers).toHaveLength(3);
    expect(new Set(registers.map(keyOf)).size).toBe(1);
    for (const call of registers) expect(call.body).toEqual(registers[0]!.body);
    expect(backend.files.size).toBe(1);
    expect(backend.calledWith('POST', UPLOAD)).toHaveLength(1);
    expect(changes.at(-1)?.map((item) => item.filename)).toEqual(['未送达.png']);
  });

  it('首次其实已提交、回查 404 时原键重发：台账重放同一回执，不新增附件', async () => {
    backend.inject('POST', REGISTER, 'lost');
    backend.inject('GET', RESULT, () =>
      Response.json({ error: { code: 'NOT_FOUND', message: '没有找到' } }, { status: 404 }),
    );
    await mountAndChoose('台账重放.png');
    await retry();
    expect(backend.calledWith('POST', REGISTER)).toHaveLength(2);
    expect(backend.files.size).toBe(1);
    expect(changes.at(-1)).toEqual([expect.objectContaining({ id: [...backend.files.keys()][0] })]);
  });
});
