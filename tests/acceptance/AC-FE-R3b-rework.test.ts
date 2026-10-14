import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/web/src/foundation/client.js';
import { createCommandStore } from '../../apps/web/src/evaluation/create-commands.js';
import { validateConditions } from '../../apps/web/src/evaluation/model.js';

const paths = [
  '/api/tenant/evaluation/activities',
  '/api/tenant/survey360/activities',
  '/api/tenant/survey360/questionnaires',
  '/api/tenant/survey360/templates',
  '/api/tenant/survey360/activities/activity-a/objects',
  '/api/tenant/survey360/activities/activity-a/objects/object-a/appraisers',
];
describe('AC-FE-R3b-R2-01 同类创建共用未确认命令入口', () => {
  it.each(paths)('%s 在途及未知均保留命令，后续调用不发送、不创建新 ID', async (path) => {
    const store = createCommandStore();
    let reject!: (reason: unknown) => void;
    const send = vi.fn(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const body = { name: '合成未确认对象' };
    const key = `tenant/identity/${path}`;
    const task = store.run(key, path, body, send);
    const first = store.get(key)!;
    expect(first).toMatchObject({ object: path, summary: body.name, status: 'pending' });
    body.name = '调用方后来修改';
    expect(first.command.body).toEqual({ name: '合成未确认对象' });
    await expect(store.run(key, path, body, send)).rejects.toThrow('结果待确认');
    reject(new ApiError(0, 'NETWORK_ERROR', 'unknown', '合成回执丢失'));
    await expect(task).rejects.toThrow('合成回执丢失');
    expect(store.get(key)).toMatchObject({ status: 'unknown', command: { id: first.command.id } });
    await expect(store.run(key, path, body, send)).rejects.toThrow('结果待确认');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('确认成功或明确拒绝才释放入口，不清除其他对象的未确认记录', async () => {
    const store = createCommandStore();
    const failed = new ApiError(409, 'CONFLICT', 'conflict', '合成明确拒绝');
    await expect(store.run('a', '/objects/a', {}, () => Promise.reject(new Error('未知')))).rejects.toThrow();
    await expect(store.run('b', '/objects/b', {}, () => Promise.reject(failed))).rejects.toThrow();
    expect(store.get('b')).toBeUndefined();
    await store.run('b', '/objects/b', {}, () => Promise.resolve({ id: 'created' }));
    expect(store.get('b')).toBeUndefined();
    expect(store.get('a')?.status).toBe('unknown');
  });
});

describe('AC-FE-R3b-R2-02 条件按类型校验', () => {
  const check = (value1: number | string | null, value2: number | string | null) =>
    validateConditions([{ details: [{ seq: 1, operator: 'between', value1, value2 }] }]);
  it.each([
    [20, 10],
    ['2026-10-20', '2026-10-10'],
  ])('拒绝反向范围 %s 至 %s', (a, b) => {
    expect(() => check(a!, b!)).toThrow('开始值不能大于结束值');
  });
  it.each([
    ['20', 10],
    [2, '10'],
  ])('拒绝混合类型 %s 至 %s', (a, b) => {
    expect(() => check(a!, b!)).toThrow('相同类型');
  });
  it('允许数值边界相等及正向日期，不猜测文本是数字', () => {
    expect(() => check(10, 10)).not.toThrow();
    expect(() => check(2, 10)).not.toThrow();
    expect(() => check('2026-10-01', '2026-10-31')).not.toThrow();
    expect(() => check('20', '10')).not.toThrow();
    expect(() => check(null, 10)).toThrow();
  });
});
