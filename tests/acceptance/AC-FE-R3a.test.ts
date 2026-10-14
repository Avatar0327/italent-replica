import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../apps/web/src/foundation/client.js';
import {
  listResource,
  saveResource,
  writablePatch,
  validateValues,
  newStandardCells,
} from '../../apps/web/src/talent/catalog/api.js';
import { talentResources } from '../../apps/web/src/talent/catalog/resources.js';
import { qualificationResources } from '../../apps/web/src/qualification/resources.js';

it('AC-FE-R3a 生成级别与指标网格，去重且不推算能力标准', () => {
  expect(newStandardCells(['L1', 'L2'], ['T1', 'T1'])).toEqual([
    { levelId: 'L1', targetId: 'T1' },
    { levelId: 'L2', targetId: 'T1' },
  ]);
});

describe('AC-FE-R3a 基础配置表单与接口契约', () => {
  it('可清空引用显式发送 null；未填写、未授权与未变化字段不生成清空命令', () => {
    const original = { id: 'a', revision: 3, layerId: 'layer', name: '原名称' };
    expect(writablePatch({ layerId: undefined }, original, ['layerId'], ['layerId'])).toEqual({ layerId: null });
    expect(writablePatch({ layerId: undefined, name: '新名称' }, original, ['layerId', 'name'], ['layerId'])).toEqual({
      layerId: null,
      name: '新名称',
    });
    expect(writablePatch({}, original, ['layerId'], ['layerId'])).toEqual({});
    expect(writablePatch({ layerId: undefined }, null, ['layerId'], ['layerId'])).toEqual({});
    expect(writablePatch({ layerId: undefined }, original, [], ['layerId'])).toEqual({});
    expect(writablePatch({ layerId: undefined }, { id: 'a', revision: 1 }, ['layerId'], ['layerId'])).toEqual({});
    expect(writablePatch({ layerId: undefined }, { ...original, layerId: null }, ['layerId'], ['layerId'])).toEqual({});
  });
  it('编辑仅提交当前可编辑且实际改变的字段，不回填裁剪字段或覆盖明细', () => {
    expect(
      writablePatch(
        { name: '新名称', enabled: false, details: [], type: 'potential' },
        { id: 'a', revision: 3, name: '旧名称', enabled: false },
        ['name', 'enabled'],
      ),
    ).toEqual({ name: '新名称' });
  });
  it('空白名称、非法编码与非法顺序号在提交前拒绝', () => {
    const dimension = talentResources.find((r) => r.key === 'dimensions')!;
    expect(() => validateValues(dimension, { name: '  ', code: 'A' })).toThrow();
    expect(() => validateValues(dimension, { name: '指标', code: '1 bad' })).toThrow();
    const level = qualificationResources.find((r) => r.key === 'levels')!;
    expect(() => validateValues(level, { name: '级别', displayOrder: -1 })).toThrow();
  });
  it('标准编辑不发送建后不可改的类别、级别范围，保留未编辑明细', () => {
    const standard = qualificationResources.find((r) => r.key === 'standards')!;
    expect(standard.fields.filter((f) => f.createOnly).map((f) => f.key)).toEqual(['categoryId', 'levelIds']);
    expect(
      writablePatch({ name: '标准乙' }, { id: 'a', revision: 4, name: '标准甲', details: [{ id: 'cell' }] }, ['name']),
    ).toEqual({ name: '标准乙' });
  });
  it('分页向服务端传递页码；不把当前页长度伪装成总条数', async () => {
    const request = vi.fn().mockResolvedValue({ items: [{ id: 'a' }], hasDataPermission: true });
    const result = await listResource({ request }, talentResources[0]!, { page: 2, pageSize: 20 });
    expect(request.mock.calls[0]![0]).toContain('page=2&pageSize=20');
    expect(result.total).toBeUndefined();
    expect(result.hasMore).toBe(false);
  });
  it('写请求携带 revision 和幂等键；409 不自动重试', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: { code: 'REVISION_CONFLICT' } }), { status: 409 }));
    vi.stubGlobal('fetch', fetcher);
    try {
      const api = createApiClient(() => ({ tenantId: 'tenant', identityKey: 'one' }));
      await expect(
        saveResource(api, qualificationResources[0]!, { name: '新名' }, { id: 'a', revision: 7 }),
      ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      const init = fetcher.mock.calls[0]![1] as RequestInit;
      expect(new Headers(init.headers).get('if-match')).toBe('7');
      expect(new Headers(init.headers).get('idempotency-key')).toBeTruthy();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
