import { describe, expect, it } from 'vitest';
import { terminationDefault } from '../../smoke/exit-termination-fixtures.js';
import { parseTerminationReceipt } from './termination-model.js';

// 旧解析器忽略第三参数仍可运行，使负例按业务断言失败。
const verifyReceipt: (raw: unknown, revision: number, sent: Readonly<Record<string, boolean>>) => { id: string } =
  parseTerminationReceipt;

describe('AC-FE-F419 P2-1 保存回执须证明与实际发送值一致', () => {
  const sent: Record<string, boolean> = { ...terminationDefault.value, inter_org_transfer: false };
  const receipt = { ...terminationDefault, source: 'tenant', revision: 5, value: sent };

  it('拒绝信封正确但一个可编辑开关与发送值相反的回执', () => {
    const wrong = { ...receipt, value: { ...sent, inter_org_transfer: true } };
    expect(() => verifyReceipt(wrong, 4, sent)).toThrow();
  });

  it('拒绝缺一个键的回执，即使按预置补齐后会与发送值相等', () => {
    const value = { ...sent };
    delete value.regularization;
    expect(() => verifyReceipt({ ...receipt, value }, 4, sent)).toThrow();
  });

  it('完整相同值按实际命令 revision 核对，不要求键的排列顺序一致', () => {
    const value = Object.fromEntries(Object.entries(sent).reverse());
    expect(verifyReceipt({ ...receipt, value }, 4, sent)).toEqual({ id: terminationDefault.key });
  });

  it.each([
    { value: { ...sent, part_time_add: false } },
    { value: { ...sent, transfer: 'true' } },
    { value: { ...sent, extra: true } },
    { key: 'exit.other' },
    { source: 'system' },
    { revision: 4 },
    { systemVersion: 0 },
    { overridable: 'true' },
  ])('保留固定项、布尔值、完整键集和信封校验：%j', (change) => {
    expect(() => verifyReceipt({ ...receipt, ...change }, 4, sent)).toThrow();
  });
});
