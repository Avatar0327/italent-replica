import { describe, expect, it, vi } from 'vitest';
import { createFormStore } from '../../apps/web/src/foundation/forms/store.js';
import { ApiError, type Command } from '../../apps/web/src/foundation/client.js';

const rejected = (status: number, code = 'VALIDATION_FAILED') => new ApiError(status, code, 'fields', '合成拒绝');
const input = () => ({
  values: { name: '我的名称', welcome: '我的欢迎语', readonly: '不可提交' },
  baseline: { name: '原名', welcome: '原欢迎语', readonly: '原只读' },
  editableFields: ['name', 'welcome'],
  revision: 3,
  businessId: 'original',
});

describe('AC-FE-F123 表单提交内核', () => {
  it('只提交有编辑权的字段，携带生效日期与原 revision', async () => {
    const store = createFormStore();
    const send = vi.fn<(command: Command) => Promise<{ id: string }>>(async () => ({ id: 'original' }));
    await store.submit('a', { ...input(), effectiveDate: '2026-10-13', send });
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      revision: 3,
      body: { name: '我的名称', welcome: '我的欢迎语', effectiveDate: '2026-10-13' },
    });
    expect(send.mock.calls[0]?.[0]?.body).toEqual({
      name: '我的名称',
      welcome: '我的欢迎语',
      effectiveDate: '2026-10-13',
    });
    expect(store.get('a')).toMatchObject({ status: 'done', businessId: 'original' });
  });
  it('提交中连续点击只生成一个命令', async () => {
    const store = createFormStore();
    let finish!: (value: { id: string }) => void;
    const send = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          finish = resolve;
        }),
    );
    const first = store.submit('a', { ...input(), send });
    await store.submit('a', { ...input(), send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.get('a')?.status).toBe('submitting');
    finish({ id: 'original' });
    await first;
  });
  it.each([400, 409, 422])('%s 明确拒绝保留输入，改正后使用新命令', async (status) => {
    const store = createFormStore();
    await store.submit('a', {
      ...input(),
      send: async () => {
        throw rejected(status);
      },
    });
    const prior = store.get('a');
    expect(prior).toMatchObject({ status: 'rejected', values: input().values });
    await store.submit('a', { ...input(), values: { name: '已修正' }, send: async () => ({ id: 'original' }) });
    expect(store.get('a')?.command?.id).not.toBe(prior?.command?.id);
  });
  it.each([new TypeError('断网'), rejected(503), new DOMException('超时', 'AbortError')])(
    '结果未知重开仍锁定，禁止清除与新命令，原单读取不推断命令成功',
    async (error) => {
      const store = createFormStore();
      const send = vi.fn(async () => {
        throw error;
      });
      await store.submit('a', { ...input(), send });
      const command = store.get('a')?.command;
      store.clear('a');
      await store.submit('a', { ...input(), send });
      expect(store.get('a')).toMatchObject({ status: 'unknown', command });
      expect(send).toHaveBeenCalledTimes(1);
      await store.reread('a', async (id) => ({ id: id!, revision: 4, values: { name: '服务端名称' } }));
      expect(store.get('a')).toMatchObject({ status: 'unknown', latest: { id: 'original' } });
    },
  );
  it('REVISION_CONFLICT 显式重读，只刷新变化且未编辑字段，核对后才能重提', async () => {
    const store = createFormStore();
    await store.submit('a', {
      ...input(),
      values: { name: '我的名称', welcome: '原欢迎语' },
      send: async () => {
        throw rejected(409, 'REVISION_CONFLICT');
      },
    });
    const send = vi.fn<(command: Command) => Promise<{ id: string }>>(async () => ({ id: 'original' }));
    await store.submit('a', { ...input(), send });
    expect(send).not.toHaveBeenCalled();
    await store.reread('a', async () => ({
      id: 'original',
      revision: 4,
      values: { name: '他人名称', welcome: '新欢迎语' },
    }));
    expect(store.get('a')).toMatchObject({
      status: 'conflict',
      values: { name: '我的名称', welcome: '新欢迎语' },
      differences: [
        { field: 'name', before: '原名', latest: '他人名称', mine: '我的名称' },
        { field: 'welcome', before: '原欢迎语', latest: '新欢迎语', mine: '原欢迎语' },
      ],
    });
    store.confirm('a');
    await store.submit('a', { ...input(), values: store.get('a')!.values, send });
    expect(send.mock.calls[0]?.[0]).toMatchObject({ revision: 4 });
  });
  it('不同租户身份表单不共享命令；错误原单回执不能解除锁', async () => {
    const store = createFormStore();
    await store.submit('tenant/a', {
      ...input(),
      send: async () => {
        throw new Error('断网');
      },
    });
    expect(store.get('tenant/b')).toBeUndefined();
    await store.reread('tenant/a', async () => ({ id: 'wrong', revision: 4, values: {} }));
    expect(store.get('tenant/a')?.latest).toBeUndefined();
    expect(store.get('tenant/a')?.status).toBe('unknown');
  });
  it('连续冲突必须重新读；冲突确认后的 422 改正仍带最新 revision', async () => {
    const store = createFormStore();
    const conflict = async () => {
      throw rejected(409, 'REVISION_CONFLICT');
    };
    await store.submit('a', { ...input(), send: conflict });
    await store.reread('a', async () => ({ id: 'original', revision: 4, values: input().baseline }));
    store.confirm('a');
    await store.submit('a', {
      ...input(),
      send: async () => {
        throw rejected(422);
      },
    });
    const send = vi.fn<(command: Command) => Promise<{ id: string }>>(conflict);
    await store.submit('a', { ...input(), send });
    expect(send.mock.calls[0]?.[0].revision).toBe(4);
    store.confirm('a');
    expect(store.get('a')?.status).toBe('conflict');
    expect(store.get('a')?.latest).toBeUndefined();
  });
  it('冲突重读失败不丢草稿，也不能确认重提', async () => {
    const store = createFormStore();
    await store.submit('a', {
      ...input(),
      send: async () => {
        throw rejected(409, 'REVISION_CONFLICT');
      },
    });
    await store.reread('a', async () => {
      throw new Error('读取失败');
    });
    store.confirm('a');
    expect(store.get('a')).toMatchObject({ status: 'conflict', values: input().values });
    expect(store.get('a')?.readError).toBeInstanceOf(Error);
  });
  it('连续重读不能把上次自动回填当成人工编辑；服务端改回原值也要回填', async () => {
    const store = createFormStore();
    await store.submit('a', {
      ...input(),
      values: { name: '我的名称', welcome: '原欢迎语' },
      send: async () => {
        throw rejected(409, 'REVISION_CONFLICT');
      },
    });
    for (const welcome of ['第一次新欢迎语', '第二次新欢迎语', '原欢迎语']) {
      await store.reread('a', async () => ({ id: 'original', revision: 4, values: { name: '他人名称', welcome } }));
      expect(store.get('a')?.values).toEqual({ name: '我的名称', welcome });
    }
  });
});
