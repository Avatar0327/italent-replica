/// <reference lib="dom" />
// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/web/src/foundation/client.js';
import { queryCommandResult } from '../../apps/web/src/foundation/forms/command-result.js';
import { sessionRecovery } from '../../apps/web/src/foundation/forms/recovery.js';
import { createFormStore, isLocked, type ResultReader } from '../../apps/web/src/foundation/forms/store.js';

// 期望值手写：恢复记录只有对账字段，没有字段原文（派发单第三节第 3 条）。
const secret = '合成敏感说明';
const input = {
  values: { reason: secret },
  baseline: { reason: '原说明' },
  editableFields: ['reason'],
  revision: 3,
  businessId: 'synthetic-business',
  context: { action: 'approve' },
};
const offline = async () => {
  throw new TypeError('合成断网');
};
const name = () => `f110-${randomUUID()}`;
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
async function unknownIn(recoveryName: string) {
  const store = createFormStore({ recovery: sessionRecovery(recoveryName) });
  store.pin(['slot'], 'entry');
  await store.submit('entry', { ...input, send: offline });
  return { store, command: store.get('entry')!.command! };
}
/** F-120 真实接口形状（apps/api/src/modules/command-result/service.ts）。 */
const resultOf = (commandId: string, status: 'succeeded' | 'failed') => ({
  commandId,
  status,
  commandType: 'POST /api/tenant/approval/tasks/:id/approve',
  businessType: status === 'succeeded' ? 'transfer' : null,
  businessId: status === 'succeeded' ? 'synthetic-business' : null,
  revision: status === 'succeeded' ? 4 : null,
  httpStatus: status === 'succeeded' ? 200 : 422,
  completedAt: '2026-11-20T01:02:03.000Z',
});

describe('AC-FE-F110 跨抽屉 / 刷新恢复未确认命令', () => {
  it('AC-FE-F110-01 结果未知只存命令 ID、版本、对象与槽，不存字段原文；新存储（刷新）载入后仍锁定', async () => {
    const recoveryName = name();
    const { command } = await unknownIn(recoveryName);
    const raw = sessionStorage.getItem(`italent.commands.pending:${recoveryName}`)!;
    expect(JSON.parse(raw)).toEqual([
      {
        key: 'entry',
        slots: ['slot'],
        commandId: command.id,
        revision: 3,
        businessId: 'synthetic-business',
        context: { action: 'approve' },
      },
    ]);
    expect(raw).not.toContain(secret);
    const reloaded = createFormStore({ recovery: sessionRecovery(recoveryName) });
    expect(reloaded.holder(['slot'])).toBe('entry');
    expect(reloaded.get('entry')).toMatchObject({ status: 'unknown', restored: true, command: { id: command.id } });
    // 同内容不能换新命令 ID 重提，也不能按原键重放（请求体没存）。
    const send = vi.fn(async () => ({ id: 'synthetic-business' }));
    await reloaded.submit('entry', { ...input, send });
    await reloaded.replay('entry', send);
    reloaded.clear('entry');
    expect(send).not.toHaveBeenCalled();
    expect(reloaded.get('entry')).toMatchObject({ status: 'unknown', command: { id: command.id } });
  });

  it('AC-FE-F110-02 存储写不进去时不发出命令，按被拒处理、输入保留', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    });
    const store = createFormStore({ recovery: sessionRecovery(name()) });
    const send = vi.fn(async () => ({ id: 'synthetic-business' }));
    const result = await store.submit('entry', { ...input, send });
    expect(send).not.toHaveBeenCalled();
    expect(result.status).toBe('rejected');
    expect(result.values).toEqual(input.values);
    expect((result.error as Error).message).toBe('无法保存处理状态，命令未发出，请检查浏览器存储设置后重试。');
  });

  it('AC-FE-F110-03 查询成功：按原命令 ID 查、放开锁并删掉恢复记录', async () => {
    const recoveryName = name();
    const { command } = await unknownIn(recoveryName);
    const reloaded = createFormStore({ recovery: sessionRecovery(recoveryName) });
    const read = vi.fn<ResultReader>(async () => ({ status: 'succeeded' }));
    const result = await reloaded.recoverResult('entry', read);
    expect(read.mock.calls[0]![0].id).toBe(command.id);
    expect(result?.status).toBe('done');
    expect(isLocked(reloaded.get('entry'))).toBe(false);
    expect(sessionStorage.getItem(`italent.commands.pending:${recoveryName}`)).toBeNull();
  });

  it('AC-FE-F110-04 查询确定失败：保留输入、可改正后以新命令 ID 重提', async () => {
    const { store, command } = await unknownIn(name());
    const result = await store.recoverResult('entry', async () => ({ status: 'failed', httpStatus: 422 }));
    expect(result).toMatchObject({ status: 'rejected', values: input.values });
    expect((result!.error as Error).message).toBe('已确认原命令未执行成功，输入已保留，请核对后重新提交。');
    await store.submit('entry', { ...input, send: async () => ({ id: 'synthetic-business' }) });
    expect(store.get('entry')).toMatchObject({ status: 'done' });
    expect(store.get('entry')!.command!.id).not.toBe(command.id);
  });

  it('AC-FE-F110-05 查不到（仍在处理）与查询失败都保持只读，不允许新命令 ID', async () => {
    const { store, command } = await unknownIn(name());
    const pendingResult = await store.recoverResult('entry', async () => ({ status: 'pending' }));
    expect(pendingResult).toMatchObject({ status: 'unknown', resultPending: true });
    const failedQuery = await store.recoverResult('entry', async () => {
      throw new ApiError(503, 'UNAVAILABLE', 'unknown', '合成不可用');
    });
    expect(failedQuery).toMatchObject({ status: 'unknown', reading: false });
    expect(failedQuery?.readError).toBeInstanceOf(ApiError);
    const send = vi.fn(async () => ({ id: 'synthetic-business' }));
    await store.submit('entry', { ...input, send });
    expect(send).not.toHaveBeenCalled();
    expect(store.get('entry')!.command!.id).toBe(command.id);
  });

  it('AC-FE-F110-06 F-120 三分支：200 succeeded / 200 failed / 404，命令 ID 不符按无效回执', async () => {
    const id = randomUUID();
    const client = (reply: () => unknown) => ({ request: vi.fn(async () => reply()) as never });
    const confirm = vi.fn(async () => 'synthetic-business');
    const ok = client(() => resultOf(id, 'succeeded'));
    expect(await queryCommandResult(ok, id, confirm)).toEqual({
      status: 'succeeded',
      businessId: 'synthetic-business',
    });
    expect(ok.request).toHaveBeenCalledWith(`/api/tenant/commands/${id}/result`, { signal: undefined });
    expect(
      await queryCommandResult(
        client(() => resultOf(id, 'failed')),
        id,
        confirm,
      ),
    ).toEqual({
      status: 'failed',
      httpStatus: 422,
    });
    const missing = client(() => {
      throw new ApiError(404, 'NOT_FOUND', 'not-found', '合成不存在');
    });
    expect(await queryCommandResult(missing, id, confirm)).toEqual({ status: 'pending' });
    await expect(
      queryCommandResult(
        client(() => resultOf(randomUUID(), 'succeeded')),
        id,
        confirm,
      ),
    ).rejects.toThrow('原单回执无效，请重新查询。');
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('AC-FE-F110-07 迟到回执按命令 ID 对账：不覆盖后来的命令，也不删后来命令的恢复记录', async () => {
    const recoveryName = name();
    const store = createFormStore({ recovery: sessionRecovery(recoveryName) });
    let late!: (value: { id: string }) => void;
    const first = store.submit('entry', {
      ...input,
      send: () =>
        new Promise((resolve) => {
          late = resolve;
        }),
    });
    // 第一条在途时另一个存储实例（刷新后的页面）查到确定失败并重提了第二条，仍未知。
    const reloaded = createFormStore({ recovery: sessionRecovery(recoveryName) });
    await reloaded.recoverResult('entry', async () => ({ status: 'failed', httpStatus: 503 }));
    await reloaded.submit('entry', { ...input, send: offline });
    const second = reloaded.get('entry')!.command!.id;
    late({ id: 'synthetic-business' });
    await first;
    const records = JSON.parse(sessionStorage.getItem(`italent.commands.pending:${recoveryName}`)!);
    expect(records).toMatchObject([{ key: 'entry', commandId: second }]);
    // 旧页面上的第一条落定为完成，不影响刷新后页面里仍未知的第二条。
    expect(store.get('entry')?.status).toBe('done');
    expect(reloaded.get('entry')).toMatchObject({ status: 'unknown', command: { id: second } });
  });

  it('AC-FE-F110-09 调动结果读回：业务类型或单号不符按无效回执，仍保持只读', async () => {
    const { transferResult } = await import('../../apps/web/src/transfer/commands.js');
    const id = randomUUID();
    const business = randomUUID();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) =>
        path.endsWith('/result')
          ? Response.json({ ...resultOf(id, 'succeeded'), businessType: 'approval', businessId: business })
          : Response.json({ id: business, revision: 2, status: 'in_review' }),
      ),
    );
    const onBusiness = vi.fn();
    await expect(transferResult('synthetic-tenant', id, onBusiness)).rejects.toThrow('原单回执无效，请重新查询。');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) =>
        path.endsWith('/result')
          ? Response.json({ ...resultOf(id, 'succeeded'), businessId: business })
          : Response.json({ id: randomUUID(), revision: 2, status: 'in_review' }),
      ),
    );
    await expect(transferResult('synthetic-tenant', id, onBusiness)).rejects.toThrow('原单回执无效，请重新查询。');
    expect(onBusiness).not.toHaveBeenCalled();
  });
  it('AC-FE-F110-10 回执缺省字段统一成 null：缺 revision 不能被当作版本已推进', async () => {
    const id = randomUUID();
    const { revision: _omitted, httpStatus: _status, ...partial } = resultOf(id, 'succeeded');
    const confirm = vi.fn(async (result: { revision: number | null; httpStatus: number | null }) => {
      expect(result.revision).toBeNull();
      expect(result.httpStatus).toBeNull();
      return undefined;
    });
    const api = { request: vi.fn(async () => partial) as never };
    await expect(queryCommandResult(api, id, confirm)).resolves.toEqual({ status: 'succeeded' });
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
