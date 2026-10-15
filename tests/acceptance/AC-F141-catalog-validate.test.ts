/**
 * F-141 第 2 轮：目录页表单提交时，antd 会把没填的字段以 undefined 带进 values；顺序号没填不是错误
 * （任职分类、任职级别的顺序号都是可选），只有填了不合法的值才拒绝。
 */
import { describe, expect, it, vi } from 'vitest';
import { qualificationResources } from '../../apps/web/src/qualification/resources.js';
import { commandRequestBody, saveResource, validateValues } from '../../apps/web/src/talent/catalog/api.js';

const classes = () => qualificationResources.find((r) => r.key === 'category-classes')!;

describe('AC-F141-catalog-validate 目录页表单校验', () => {
  it('没填顺序号（undefined / null）通过；填了非法值仍拒绝', () => {
    expect(() => validateValues(classes(), { name: '分类甲', code: 'A', displayOrder: undefined })).not.toThrow();
    expect(() => validateValues(classes(), { name: '分类甲', code: 'A', displayOrder: null })).not.toThrow();
    expect(() => validateValues(classes(), { name: '分类甲', code: 'A', displayOrder: -1 })).toThrow();
    expect(() => validateValues(classes(), { name: '分类甲', code: 'A', displayOrder: 1.5 })).toThrow();
    expect(() => validateValues(classes(), { name: '分类甲', code: 'A', displayOrder: 2_000_000 })).toThrow();
    expect(() => validateValues(classes(), { name: '分类甲', code: 'A', displayOrder: 3 })).not.toThrow();
  });
});

describe('AC-F141-catalog-validate 内核命令体 → 请求体', () => {
  const levels = qualificationResources.find((r) => r.key === 'levels')!;
  const standards = qualificationResources.find((r) => r.key === 'standards')!;
  const original = { id: 'a', revision: 3 };

  it('编辑：可清空且已有值的字段，清空（undefined）发显式 null；其余 undefined 不发', () => {
    expect(
      commandRequestBody(levels, original, ['layerId'], { layerId: undefined, name: '新名', code: undefined }),
    ).toEqual({
      layerId: null,
      name: '新名',
    });
  });

  it('新建：undefined 一律不发；创建空标准提交空格集合，已给的明细不覆盖', () => {
    expect(commandRequestBody(levels, null, ['layerId'], { name: '级别', layerId: undefined })).toEqual({
      name: '级别',
    });
    expect(commandRequestBody(standards, null, [], { name: '标准' })).toEqual({ name: '标准', details: [] });
    expect(commandRequestBody(standards, null, [], { name: '标准', details: [{ id: 'x' }] })).toEqual({
      name: '标准',
      details: [{ id: 'x' }],
    });
    expect(commandRequestBody(standards, original, [], { name: '标准乙' })).toEqual({ name: '标准乙' });
  });
});

describe('AC-F141-catalog-validate 保存请求', () => {
  it('内核固定的命令只保留 ID 与版本，请求体用转换后的（清空发 null），幂等键不变', async () => {
    const levels = qualificationResources.find((r) => r.key === 'levels')!;
    const request = vi.fn(async (_path: string, _options: unknown) => ({ id: 'a', revision: 4 }));
    const kernel = { id: 'command-1', revision: 3, body: { layerId: undefined } };
    await saveResource({ request } as never, levels, { layerId: null }, { id: 'a', revision: 3 }, kernel);
    const options = request.mock.calls[0]![1] as {
      method: string;
      command: { id: string; revision: number; body: unknown };
    };
    expect(options.method).toBe('PATCH');
    expect(options.command).toEqual({ id: 'command-1', revision: 3, body: { layerId: null } });
  });
});
