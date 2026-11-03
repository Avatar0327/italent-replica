import { expect, it, vi } from 'vitest';
import { commandRequestBody, saveResource } from '../../apps/web/src/talent/catalog/api.js';
import { qualificationResources } from '../../apps/web/src/qualification/resources.js';

const resource = qualificationResources.find((item) => item.key === 'levels')!;
const original = { id: 'synthetic-row', revision: 1 };
const command = { id: 'synthetic-command', revision: 3, body: { name: '新名称' } };

it.each([{ id: original.id }, { id: original.id, revision: 3 }, { id: 'other', revision: 4 }])(
  'AC-QL F-475 回执缺版本、未推进实际提交版本或串单时不能判保存成功：%j',
  async (receipt) => {
    const request = vi.fn().mockResolvedValue(receipt);
    await expect(saveResource({ request }, resource, command.body, original, command)).rejects.toThrow();
  },
);

it('AC-QL F-475 接受实际提交版本后的真实对象回执', async () => {
  const receipt = { ...original, revision: 4, name: '新名称' };
  const request = vi.fn().mockResolvedValue(receipt);
  await expect(saveResource({ request }, resource, command.body, original, command)).resolves.toEqual(receipt);
  expect(request.mock.calls[0]![1].command.revision).toBe(3);
});

it('AC-QL F475 P2-1 序列化不得在内核裁剪后补入等级明细', () => {
  const scheme = qualificationResources.find((item) => item.key === 'grade-schemes')!;
  expect(commandRequestBody(scheme, null, [], { name: '合成受限方案' })).toEqual({ name: '合成受限方案' });
});
