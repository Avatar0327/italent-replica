// F-142（DEC-502②）：表单内核上收的字段投影、空值归一、重读回填、恢复槽键契约。
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/web/src/foundation/client.js';
import { createFormStore, slotContext, type Latest } from '../../apps/web/src/foundation/forms/store.js';
import {
  changedFields,
  isBlank,
  projectFields,
  refillDraft,
  sameValue,
} from '../../apps/web/src/foundation/forms/values.js';
import { slotKey } from '../../apps/web/src/foundation/forms/slot.js';

const conflict = () => new ApiError(409, 'REVISION_CONFLICT', 'refresh', '合成冲突');
const unknown = () => new ApiError(0, 'NETWORK_ERROR', 'unknown', '合成网络中断');

describe('AC-FE-F142 字段投影与空值归一', () => {
  it('空字符串、null、undefined、空数组按同一条规则视为空值', () => {
    for (const blank of ['', null, undefined, []]) expect(isBlank(blank)).toBe(true);
    for (const value of [0, false, ' ', [''], {}]) expect(isBlank(value)).toBe(false);
    expect(sameValue('', null)).toBe(true);
    expect(sameValue(undefined, [])).toBe(true);
    expect(sameValue(0, null)).toBe(false);
    expect(sameValue(false, '')).toBe(false);
    expect(sameValue(['a'], ['a'])).toBe(true);
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false);
  });
  it('对象按键比较，不受键序与空值键影响', () => {
    expect(sameValue({ a: 1, b: null }, { a: 1 })).toBe(true);
    expect(sameValue({ b: [{ y: '', x: 1 }], a: 1 }, { a: 1, b: [{ x: 1 }] })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
  });
  it('投影按字段取记录值，缺失取兜底，再缺为 null', () => {
    const record = { id: 'r1', name: '合成名称', remark: '', extra: '不投影' };
    expect(projectFields(record, ['name', 'remark', 'level', 'owner'], { level: 2 })).toEqual({
      name: '合成名称',
      remark: '',
      level: 2,
      owner: null,
    });
    expect(projectFields(undefined, ['name'])).toEqual({ name: null });
  });
  it('是否改过按打开时的基线比较，空值之间互换不算修改', () => {
    const baseline = { name: '原名', remark: null, tags: [], level: 1 };
    const draft = { name: '原名', remark: '', tags: undefined, level: 2 };
    expect(changedFields(draft, baseline, ['name', 'remark', 'tags', 'level'])).toEqual(['level']);
  });
});

describe('AC-FE-F142 重读回填', () => {
  const latest = { name: '他人改名', remark: '他人备注', subProcesses: [{ id: 's1', days: 3 }] };
  it('没有重读结果时原样返回同一个引用', () => {
    const values = { name: '草稿' };
    expect(refillDraft({ values, latest: undefined, edited: ['name'], submittable: ['name'] })).toBe(values);
  });
  it('未改字段与当前不可提交字段取最新记录，改过且可提交的保留草稿', () => {
    const values = { name: '我的草稿', remark: '旧备注', subProcesses: [{ id: 's1' }] };
    expect(refillDraft({ values, latest, edited: ['name', 'subProcesses'], submittable: ['name', 'remark'] })).toEqual({
      name: '我的草稿',
      remark: '他人备注',
      subProcesses: latest.subProcesses,
    });
  });
  it('草稿里有、最新记录里没有的字段：不可提交时置空，改过且可提交时保留草稿', () => {
    const values = { name: '新组织', addEmployment: 'yes' };
    const latest = { name: '原组织' };
    const hidden = refillDraft({ values, latest, edited: ['name', 'addEmployment'], submittable: ['name'] });
    expect(Object.entries(hidden)).toEqual([
      ['name', '新组织'],
      ['addEmployment', undefined],
    ]);
    const shown = refillDraft({
      values,
      latest,
      edited: ['name', 'addEmployment'],
      submittable: ['name', 'addEmployment'],
    });
    expect(shown).toEqual(values);
  });
  it('冲突重读：内核按最新记录回填未改字段与上次不可提交的字段，保留改过的字段', async () => {
    const store = createFormStore();
    await store.submit('k', {
      values: { name: '我的草稿', remark: '原备注' },
      baseline: { name: '原名', remark: '原备注', owner: '原负责人' },
      editableFields: ['name', 'remark'],
      revision: 3,
      businessId: 'r1',
      patchOnly: true,
      send: async () => {
        throw conflict();
      },
    });
    const read: (id?: string) => Promise<Latest> = async (id) => ({
      id: id!,
      revision: 4,
      values: { name: '他人改名', remark: '他人备注', owner: '他人负责人' },
    });
    await store.reread('k', read);
    expect(store.get('k')?.values).toEqual({ name: '我的草稿', remark: '他人备注', owner: '他人负责人' });
    expect(store.get('k')?.differences?.map((item) => item.field)).toEqual(['name', 'remark']);
  });
  it('转为不可提交的已改字段 settle 后取最新、记为未改，再次重读跟随新的最新记录；结果未知的命令不动', async () => {
    const store = createFormStore();
    const input = {
      values: { name: '我的草稿', stages: '我的阶段' },
      baseline: { name: '原名', stages: '原阶段' },
      editableFields: ['name', 'stages'],
      revision: 3,
      businessId: 'r1',
      patchOnly: true,
    };
    await store.submit('k', { ...input, send: async () => Promise.reject(conflict()) });
    const latest = (revision: number, stages: string) => async (id?: string) => ({
      id: id!,
      revision,
      values: { name: '原名', stages },
    });
    await store.reread('k', latest(4, '他人阶段'));
    expect(store.settle('k', ['name', 'stages'])).toBeUndefined();
    expect(store.settle('k', ['name'])).toMatchObject({
      values: { name: '我的草稿', stages: '他人阶段' },
      editedFields: ['name'],
    });
    expect(store.settle('k', ['name'])).toBeUndefined();
    await store.reread('k', latest(5, '他人两个阶段'));
    expect(store.get('k')?.values).toEqual({ name: '我的草稿', stages: '他人两个阶段' });
    await store.submit('u', { ...input, send: async () => Promise.reject(unknown()) });
    await store.reread('u', latest(4, '他人阶段'));
    expect(store.settle('u', ['name'])).toBeUndefined();
    expect(store.get('u')?.values).toEqual(input.values);
  });
  it('patchOnly 请求体与已编辑字段都按空值归一比较', async () => {
    const store = createFormStore();
    const send = vi.fn(async () => ({ id: 'r1' }));
    await store.submit('k', {
      values: { name: '新名', remark: '', tags: undefined },
      baseline: { name: '原名', remark: null, tags: [] },
      editableFields: ['name', 'remark', 'tags'],
      revision: 1,
      businessId: 'r1',
      patchOnly: true,
      send,
    });
    expect(send.mock.calls[0]).toMatchObject([{ body: { name: '新名' } }]);
    expect(Object.keys((send.mock.calls[0] as unknown as [{ body: object }])[0].body)).toEqual(['name']);
    expect(store.get('k')?.editedFields).toEqual(['name']);
  });
});

describe('AC-FE-F142 恢复槽键', () => {
  it('编辑用原单路径，新建用集合路径', () => {
    expect(slotKey('/api/tenant/org/organizations', 'o-1')).toBe('/api/tenant/org/organizations/o-1');
    expect(slotKey('/api/tenant/org/organizations')).toBe('/api/tenant/org/organizations');
    expect(slotKey('/api/tenant/job/posts', 'a/b')).toBe('/api/tenant/job/posts/a%2Fb');
  });
  it('键里不得带日期、视图、动作或入口', () => {
    for (const bad of [
      '/api/tenant/org/organizations?asOf=2026-10-14',
      '/api/tenant/org/organizations#detail',
      '/api/tenant/org/organizations/2026-10-14',
      '/api/tenant/idp/plans/p1:task',
      '/api/tenant/succession/records#r1@3',
    ])
      expect(() => slotKey(bad)).toThrow();
    expect(() => slotKey('/api/tenant/org/organizations', '')).toThrow();
  });
  it('业务时点等命令上下文存在槽里；未完成时沿用槽里的上下文，完成后不再返回', async () => {
    const store = createFormStore();
    const input = {
      values: { name: '合成' },
      baseline: {},
      editableFields: ['name'],
      revision: 0,
    };
    await store.submit('k', {
      ...input,
      context: { date: '2026-10-01' },
      send: async () => {
        throw unknown();
      },
    });
    expect(store.get('k')?.status).toBe('unknown');
    expect(slotContext(store.get('k'))).toEqual({ date: '2026-10-01' });
    expect(store.get('k')?.values).toEqual({ name: '合成' });
    const other = createFormStore();
    await other.submit('k', {
      ...input,
      context: { date: '2026-10-01' },
      send: async () => {
        throw new ApiError(422, 'VALIDATION_FAILED', 'fields', '合成拒绝');
      },
    });
    await other.submit('k', { ...input, context: { date: '2026-10-09' }, send: async () => ({ id: 'n1' }) });
    expect(other.get('k')?.context).toEqual({ date: '2026-10-01' });
    expect(slotContext(other.get('k'))).toBeUndefined();
  });
});
