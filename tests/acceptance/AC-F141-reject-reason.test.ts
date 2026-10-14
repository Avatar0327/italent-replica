/// <reference lib="dom" />
/**
 * F-141 ④（DEC-500）：400 / 422 字段校验类拒绝，没有字段明细时显示服务端给出的业务原因，
 * 不再统一显示“请检查表单字段”。409 的现有处理不变；有字段明细时仍由表单把原因回填到字段上。
 * 表单提交内核（F-123）读 ApiError.message 展示拒绝原因，所以修客户端映射即可，不绕开内核。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../apps/web/src/foundation/client.js';
import { ui } from '../../apps/web/src/foundation/messages.js';

afterEach(() => vi.unstubAllGlobals());
const context = { tenantId: 'tenant-a', identityKey: 'person-a' };
const reply = (status: number, error: Record<string, unknown>) =>
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } }),
      ),
  );
const failure = async (): Promise<Error> => {
  try {
    await createApiClient(() => context).request('/api/tenant/example');
  } catch (cause) {
    return cause as Error;
  }
  throw new Error('请求应当失败');
};

describe('AC-F141-reject-reason 字段校验类拒绝显示具体原因（DEC-500④）', () => {
  it.each([400, 422])('%s 无字段明细：显示服务端原因', async (status) => {
    reply(status, { code: 'VALIDATION_FAILED', message: '生效日期早于任职开始日期' });
    expect((await failure()).message).toBe('生效日期早于任职开始日期');
  });

  it('有字段明细：仍用通用提示，具体原因由表单回填到字段', async () => {
    reply(422, { code: 'VALIDATION_FAILED', message: '参数不合法', details: { fieldErrors: { name: ['不能为空'] } } });
    expect((await failure()).message).toBe(ui.invalid);
  });

  it('服务端没给原因：退回通用提示', async () => {
    reply(422, { code: 'VALIDATION_FAILED' });
    expect((await failure()).message).toBe(ui.invalid);
  });

  it('409 现有处理不变：revision 冲突仍提示刷新，业务冲突仍显示服务端原因', async () => {
    reply(409, { code: 'REVISION_CONFLICT', message: '服务端说明' });
    expect((await failure()).message).toBe(ui.refresh);
    reply(409, { code: 'ORG_CODE_TAKEN', message: '组织编码已存在' });
    expect((await failure()).message).toBe('组织编码已存在');
  });
});
