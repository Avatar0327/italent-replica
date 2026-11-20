import { describe, expect, it, vi } from 'vitest';
import { createFormStore, isLocked } from '../../apps/web/src/foundation/forms/store.js';

async function pending(deletion = true) {
  const store = createFormStore();
  const input = {
    values: { reason: '合成删除说明' },
    baseline: { reason: '原说明' },
    editableFields: ['reason'],
    revision: 3,
    businessId: 'original',
    deletion,
  };
  const send = vi.fn(async () => {
    throw new TypeError('合成断网');
  });
  await store.submit('slot', { ...input, send });
  const command = store.get('slot')!.command!;
  const receipt = { commandId: command.id, id: 'original', revision: 3, status: 'deleted' };
  return { store, input, send, command, receipt };
}
describe('AC-FE-F469 删除结果受控确认', () => {
  it.each(['deleted', 'not_deleted'])('%s 权威结果解锁，未删保留输入并允许显式新命令', async (status) => {
    const { store, receipt, input, command } = await pending();
    const read = vi.fn(async () => ({ ...receipt, status }));
    const result = await store.recoverDeletion('slot', read);
    expect(read).toHaveBeenCalledWith(command, 'original');
    expect(result?.status).toBe(status === 'deleted' ? 'done' : 'rejected');
    expect(isLocked(store.get('slot'))).toBe(false);
    expect(result?.values).toEqual(input.values);
    if (status === 'not_deleted') {
      await store.submit('slot', { ...input, send: async () => ({ id: 'original' }) });
      expect(store.get('slot')?.command?.id).not.toBe(command.id);
    } else {
      store.clear('slot');
      expect(store.get('slot')).toBeUndefined();
    }
  });
  it('未知、404、403、无效和不匹配回执仍锁住原命令，不能清除或新建', async () => {
    const { store, receipt, command, input, send } = await pending();
    for (const raw of [
      null,
      {},
      { ...receipt, commandId: 'other' },
      { ...receipt, id: 'other' },
      { ...receipt, revision: 4 },
      { ...receipt, status: 'unknown' },
      { ...receipt, status: 'bad' },
      403,
      404,
    ]) {
      await store.recoverDeletion('slot', async () => {
        if (typeof raw === 'number') throw { status: raw };
        return raw;
      });
      store.clear('slot');
      await store.submit('slot', { ...input, send });
      expect(store.get('slot')).toMatchObject({ status: 'unknown', command });
      expect(isLocked(store.get('slot'))).toBe(true);
    }
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('查询期间去重；不能重放、重读或提交覆盖在途查询', async () => {
    const { store, receipt, command, input, send } = await pending();
    let finish!: (value: unknown) => void;
    const read = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const querying = store.recoverDeletion('slot', read);
    await store.recoverDeletion('slot', read);
    await store.replay('slot', send);
    await store.submit('slot', { ...input, send });
    const reread = vi.fn(async () => ({ id: 'original', revision: 4, values: {} }));
    await store.reread('slot', reread);
    expect(store.get('slot')).toMatchObject({ status: 'unknown', reading: true, command });
    expect(read).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(reread).not.toHaveBeenCalled();
    finish(receipt);
    await querying;
    expect(store.get('slot')?.status).toBe('done');
  });
  it('非删除命令和别的槽不能调用删除确认解除锁', async () => {
    const { store, receipt } = await pending(false);
    const read = vi.fn(async () => receipt);
    expect(await store.recoverDeletion('slot', read)).toBeUndefined();
    expect(await store.recoverDeletion('other', read)).toBeUndefined();
    expect(store.get('slot')?.status).toBe('unknown');
    expect(read).not.toHaveBeenCalled();
  });
});
