/// <reference lib="dom" />
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/web/src/foundation/client.js';
import { queryCommandResult } from '../../apps/web/src/foundation/forms/command-result.js';
import { sharedRecovery } from '../../apps/web/src/foundation/forms/recovery.js';
import { createFormStore, isLocked } from '../../apps/web/src/foundation/forms/store.js';
import { uniqueSuffix } from './support/unique.js';
import { installWebLocks } from './support/web-locks.js';

installWebLocks();
afterEach(() => localStorage.clear());

const input = {
  values: { place: '合成原输入' },
  baseline: { place: '合成基线' },
  editableFields: ['place'],
  revision: 3,
};
const recover = async () => {
  const name = `f537-${uniqueSuffix()}`;
  const recovery = sharedRecovery(name);
  const store = createFormStore({ recovery });
  const state = await store.submit('entry', {
    ...input,
    send: async () => {
      throw new ApiError(500, 'INTERNAL_ERROR', 'unknown', '合成写入异常');
    },
  });
  expect(state.status).toBe('unknown');
  return { store, recovery, id: state.command!.id };
};
const receipt = (id: string) => ({
  commandId: id,
  status: 'not_executed',
  commandType: 'POST /api/tenant/self-service/transfer',
  businessId: null,
  businessType: null,
  revision: null,
  httpStatus: 500,
  completedAt: '2026-11-20T01:02:03.000Z',
});
const client = (read: () => unknown) => ({ request: vi.fn(async () => read()) as never });

it('AC-FE-F537-01 收到未执行，释放锁、保留输入、清恢复记录，用户改正后显式生成新命令', async () => {
  const { store, recovery, id } = await recover();
  const confirm = vi.fn();
  const api = client(() => receipt(id));
  const read = vi.fn(({ id: sentId }: { id: string }) => queryCommandResult(api, sentId, confirm));
  expect(await store.recoverResult('entry', read)).toMatchObject({ status: 'rejected', values: input.values });
  expect(confirm).not.toHaveBeenCalled();
  expect(isLocked(store.get('entry'))).toBe(false);
  await vi.waitFor(() => expect(recovery.load()).toEqual([]));
  const send = vi.fn(async () => ({ id: 'synthetic-business' }));
  expect(send).not.toHaveBeenCalled();
  const next = await store.submit('entry', { ...input, values: { place: '合成改正值' }, send });
  expect(next.status).toBe('done');
  expect(send).toHaveBeenCalledExactlyOnceWith({
    id: expect.not.stringMatching(id),
    revision: 3,
    body: { place: '合成改正值' },
  });
});

it('AC-FE-F537-02 刷新后的恢复槽遇到 404、断网、错号及矛盾回执时一直只读，只接受本人原命令未执行', async () => {
  const { recovery, id } = await recover();
  const reloaded = createFormStore({ recovery });
  const confirm = vi.fn();
  const send = vi.fn();
  for (const read of [
    () => {
      throw new ApiError(404, 'NOT_FOUND', 'not-found', '合成未知结果');
    },
    () => {
      throw new TypeError('合成断网');
    },
    () => receipt(uniqueSuffix()),
    () => ({ ...receipt(id), businessId: uniqueSuffix(), revision: 1 }),
  ]) {
    const state = await reloaded.recoverResult('entry', ({ id }) => queryCommandResult(client(read), id, confirm));
    expect(state).toMatchObject({ status: 'unknown', command: { id } });
    await reloaded.submit('entry', { ...input, send });
    expect(send).not.toHaveBeenCalled();
    expect(recovery.load()).toMatchObject([{ commandId: id }]);
  }
  const state = await reloaded.recoverResult('entry', ({ id }) =>
    queryCommandResult(
      client(() => receipt(id)),
      id,
      confirm,
    ),
  );
  expect(state?.status).toBe('rejected');
  await vi.waitFor(() => expect(recovery.load()).toEqual([]));
  expect(confirm).not.toHaveBeenCalled();
});
