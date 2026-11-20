/// <reference lib="dom" />
// @vitest-environment happy-dom
// F-110 起 hr-session 撤掉：DEC-464 处理标记改由 F-123 内核的调动存储（transfer/commands.ts）承载，
// 恢复记录只存命令 ID、版本、对象与槽（F-110 有意持久化命令 ID，用于刷新后按原 ID 查询结果），不存载荷。
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { transferCommands, transferEntry, transferSlot } from '../../apps/web/src/transfer/commands.js';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});
const offline = async () => {
  throw new TypeError('合成断网');
};
const payload = { values: { note: '合成调动说明' }, baseline: {}, editableFields: ['note'], revision: 5 };
/** 与 usePinnedCommand 相同的会话作用域：[租户, 身份, 名称]。 */
function scoped(tenant: string, identity = 'identity') {
  const name = (value: string) => JSON.stringify([tenant, identity, value]);
  return { slot: name(transferSlot), entry: name(transferEntry('synthetic-employee')) };
}
async function unknownIn(tenant: string) {
  const { slot, entry } = scoped(tenant);
  transferCommands.pin([slot], entry);
  await transferCommands.submit(entry, { ...payload, send: offline });
  return { slot, entry };
}

it('AC-FE-R1c-11 DEC-464 处理标记按租户 / 身份隔离，不再存暂存索引', async () => {
  const tenant = randomUUID();
  const { slot } = await unknownIn(tenant);
  expect(transferCommands.holder([slot])).toBeDefined();
  expect(transferCommands.holder([scoped(tenant, 'other').slot])).toBeUndefined();
  expect(transferCommands.holder([scoped(randomUUID()).slot])).toBeUndefined();
  expect(Object.keys(localStorage)).toEqual(['italent.commands.pending:transfer']);
});

it('AC-FE-R1c-12 DEC-464 未确认标记禁止新命令，只持久化命令 ID 与对账字段、不存载荷', async () => {
  const { slot, entry } = await unknownIn(randomUUID());
  const send = vi.fn(async () => ({ id: 'synthetic-business' }));
  await transferCommands.submit(entry, { ...payload, send });
  expect(send).not.toHaveBeenCalled();
  const id = transferCommands.get(entry)!.command!.id;
  expect(JSON.parse(localStorage.getItem('italent.commands.pending:transfer')!)).toEqual([
    { key: entry, slots: [slot], commandId: id, revision: 5 },
  ]);
});

it('AC-FE-R1c-12 DEC-464 存储不可用必须在写请求之前失败', async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: () => {},
  });
  const { entry } = scoped(randomUUID());
  const send = vi.fn(async () => ({ id: 'synthetic-business' }));
  expect(await transferCommands.submit(entry, { ...payload, send })).toMatchObject({ status: 'rejected' });
  expect(send).not.toHaveBeenCalled();
});

it('AC-FE-R1c-12 DEC-464 恢复记录损坏时不发出新命令，也不能通过完成回执覆盖存储', async () => {
  localStorage.setItem('italent.commands.pending:transfer', '{');
  const { entry } = scoped(randomUUID());
  const send = vi.fn(async () => ({ id: 'synthetic-business' }));
  expect(await transferCommands.submit(entry, { ...payload, send })).toMatchObject({ status: 'rejected' });
  expect(send).not.toHaveBeenCalled();
  expect(localStorage.getItem('italent.commands.pending:transfer')).toBe('{');
});
