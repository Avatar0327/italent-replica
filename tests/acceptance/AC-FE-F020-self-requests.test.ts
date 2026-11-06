/// <reference lib="dom" />
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const model = await import(resolve('apps/web/src/self-service/pages/model.ts'));
const form = {
  employee: { id: 'self', name: '合成本人', revision: 7 },
  dataOperations: { create: false, update: true },
  fieldModes: { lastWorkDate: 'readonly', reasonCode: 'readonly' },
  updateFieldModes: { lastWorkDate: 'editable', reasonCode: 'readonly' },
  values: { reasonCode: 'personal' },
};
describe('AC-FE-F020 本人申请字段与协议', () => {
  it('两个入口只按对应的 detail 按钮显示', () => {
    const buttons = [{ buttonCode: 'Exit.Self', level: 'detail' }];
    expect(model.selfRequestAllowed?.(buttons, 'exit')).toBe(true);
    expect(model.selfRequestAllowed?.(buttons, 'partTime')).toBe(false);
    expect(model.selfRequestAllowed?.([{ buttonCode: 'Exit.Self', level: 'list' }], 'exit')).toBe(false);
  });
  it('DEC-798 修改态使用 updateFieldModes，新建不能借修改权编辑', () => {
    expect(model.selfRequestAccess?.(form, false)).toMatchObject({
      editableFields: [],
      viewableFields: ['lastWorkDate', 'reasonCode'],
    });
    expect(model.selfRequestAccess?.(form, true)).toMatchObject({ editableFields: ['lastWorkDate'] });
    expect(model.selfRequestAccess?.({ ...form, updateFieldModes: { lastWorkDate: 'readonly' } }, true)).toMatchObject({
      editableFields: [],
      viewableFields: ['lastWorkDate'],
    });
  });
  it('隐藏与只读字段不补回载荷，离职去向可清空', () => {
    expect(
      model.selfRequestBody?.(
        'exit',
        { lastWorkDate: '2026-12-01', reasonCode: 'family', whereaboutsCode: null, employeeId: 'other' },
        ['lastWorkDate', 'whereaboutsCode'],
      ),
    ).toEqual({ lastWorkDate: '2026-12-01', whereaboutsCode: '' });
    expect(
      model.selfRequestBody?.(
        'partTime',
        { serviceType: 'part_time', effectiveDate: '2026-12-01', postId: 'hidden', departmentId: 'dept' },
        ['serviceType', 'effectiveDate', 'departmentId'],
      ),
    ).toEqual({ partTimeType: 'part_time', startDate: '2026-12-01', fields: { departmentId: 'dept' } });
  });
  it('离职默认个人原因仅取服务端可见默认值，已有单不重新补默认值', () => {
    expect(model.selfRequestValues?.('exit', form.values)).toMatchObject({ reasonCode: 'personal' });
    expect(model.selfRequestValues?.('exit', {})).toMatchObject({ reasonCode: undefined });
    expect(
      model.selfRequestValues?.('partTime', {
        serviceType: 'secondment',
        effectiveDate: '2026-12-01',
        fields: { departmentId: 'dept' },
      }),
    ).toMatchObject({ serviceType: 'secondment', effectiveDate: '2026-12-01', departmentId: 'dept' });
  });
  it('离职必填和兼职三项必填、非法日期与结束日期边界有明确错误', () => {
    expect(model.selfRequestErrors?.('exit', {})).toEqual(['lastWorkDate']);
    expect(model.selfRequestErrors?.('partTime', {})).toEqual(['serviceType', 'effectiveDate', 'departmentId']);
    expect(model.selfRequestErrors?.('exit', { lastWorkDate: '2026-02-30' })).toEqual(['lastWorkDate']);
    expect(
      model.selfRequestErrors?.('partTime', {
        serviceType: 'expatriate',
        effectiveDate: '2026-12-01',
        departmentId: 'dept',
        endDate: '2026-11-30',
      }),
    ).toEqual(['endDate']);
    expect(model.selfRequestErrors?.('exit', { lastWorkDate: '2026-12-01' })).toEqual([]);
  });
  it('回执按真实协议校验，创建单据版本不与员工版本混用', () => {
    const receipt = { id: 'draft', employeeId: 'self', revision: 1, status: 'draft', kind: 'exit', fields: {} };
    expect(model.acceptSelfRequest?.(receipt, 'self', 7)).toEqual(receipt);
    expect(() => model.acceptSelfRequest?.({ ...receipt, revision: 8 }, 'self', 8, 'draft')).toThrow();
    expect(() => model.acceptSelfRequest?.({ ...receipt, employeeId: 'other' }, 'self', 7)).toThrow();
    expect(model.acceptSelfRequest?.({ ...receipt, revision: 9 }, 'self', 8, 'draft')).toMatchObject({ revision: 9 });
  });
});

const { createFormStore } = await import(resolve('apps/web/src/foundation/forms/store.ts'));
const { createApiClient } = await import(resolve('apps/web/src/foundation/client.ts'));
afterEach(() => vi.unstubAllGlobals());
for (const kind of ['exit', 'partTime'])
  for (const action of ['create', 'edit', 'submit']) {
    it(`AC-FE-F020 ${kind}/${action} 结果未知同路径同内容同版本同键重放`, async () => {
      const collection = `/api/tenant/self-service/${kind === 'exit' ? 'exit' : 'part-time'}-requests`;
      const target = action === 'submit' ? '/draft/submit' : '/draft';
      const path = collection + (action === 'create' ? '' : target);
      const api = createApiClient(() => ({ tenantId: 'tenant', identityKey: 'identity' }));
      const store = createFormStore();
      const calls: { path: string; body: string; revision: string | null; key: string | null }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          if (init.method === 'GET') return Response.json({ id: 'draft', revision: 9 });
          const headers = new Headers(init.headers);
          calls.push({
            path: url,
            body: String(init.body),
            revision: headers.get('if-match'),
            key: headers.get('idempotency-key'),
          });
          if (calls.length === 1) throw new TypeError('合成回执丢失');
          return Response.json({ id: 'draft', employeeId: 'self', revision: 9, status: 'draft' });
        }),
      );
      const values =
        kind === 'exit'
          ? { lastWorkDate: '2026-12-01' }
          : { serviceType: 'part_time', effectiveDate: '2026-12-01', departmentId: 'department' };
      const pending = store.submit(path, {
        values,
        baseline: {},
        editableFields: Object.keys(values),
        revision: 8,
        send: (sent: { body: object }) =>
          model.recoverSelfRequest?.(path, () =>
            api.request(path, {
              method: action === 'edit' ? 'PATCH' : 'POST',
              command: {
                ...sent,
                body: action === 'submit' ? {} : model.selfRequestBody?.(kind, sent.body, Object.keys(values)),
              },
            }),
          ),
      });
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1);
        expect(model.pendingReplay?.(path)).toBeDefined();
      });
      expect(store.get(path)?.status).toBe('submitting');
      expect(model.pendingReplay?.(path)).toBeDefined();
      // 原命令未完成，关闭/重开使用同一槽仍不能建第二条命令。
      store.clear(path);
      expect(store.get(path)?.status).toBe('submitting');
      await model.replaySelfRequest?.(path, () => api.request(path));
      expect((await pending).status).toBe('done');
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(calls[0]);
      expect(calls[0]?.revision).toBe('8');
    });
    it(`AC-FE-F020 ${kind}/${action} 409重读后改回原值使用新版本与新键`, async () => {
      const store = createFormStore();
      const sent: { revision: number; id: string; body: unknown }[] = [];
      const input = (value: string) => ({
        values: { lastWorkDate: value },
        baseline: { lastWorkDate: '2026-12-01' },
        editableFields: ['lastWorkDate'],
        revision: 1,
        businessId: 'draft',
        patchOnly: true,
        send: async (command: { revision: number; id: string; body: unknown }) => {
          sent.push({ ...command, body: model.selfRequestBody?.('exit', command.body, ['lastWorkDate']) });
          if (sent.length === 1) throw { status: 409, code: 'REVISION_CONFLICT' };
          return { id: 'draft' };
        },
      });
      expect((await store.submit(kind + action, input('2026-12-02'))).status).toBe('conflict');
      await store.reread(kind + action, async () => ({
        id: 'draft',
        revision: 2,
        values: { lastWorkDate: '2026-12-03' },
      }));
      store.confirm(kind + action);
      expect((await store.submit(kind + action, input('2026-12-01'))).status).toBe('done');
      expect(sent[1]?.body).toEqual({ lastWorkDate: '2026-12-01' });
      expect(sent[1]?.revision).toBe(2);
      expect(sent[1]?.id).not.toBe(sent[0]?.id);
    });
  }

it.each([409, 503, 'network'])('AC-FE-F020 P2-1 未知后重放 %s，确定409交还内核并显式重提', async (replayResult) => {
  const path = `/api/tenant/self-service/exit-requests/replay-${replayResult}`;
  const api = createApiClient(() => ({ tenantId: 'tenant', identityKey: 'identity' }));
  const store = createFormStore();
  const writes: { path: string; body: string; revision: string | null; key: string | null }[] = [];
  const reads: string[] = [];
  const conflictAttempt = replayResult === 409 ? 2 : 3;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'GET') {
        reads.push(url);
        return Response.json({ id: 'draft', revision: 9, values: { lastWorkDate: '2026-12-03' } });
      }
      const headers = new Headers(init.headers);
      writes.push({
        path: url,
        body: String(init.body),
        revision: headers.get('if-match'),
        key: headers.get('idempotency-key'),
      });
      if (writes.length === 1 || (writes.length === 2 && replayResult === 'network'))
        throw new TypeError('合成网络错误');
      if (writes.length === 2 && replayResult === 503) return new Response(null, { status: 503 });
      if (writes.length === conflictAttempt)
        return Response.json({ error: { code: 'REVISION_CONFLICT', message: '请核对最新版本' } }, { status: 409 });
      return Response.json({ id: 'draft' });
    }),
  );
  const input = {
    values: { lastWorkDate: '2026-12-02' },
    baseline: { lastWorkDate: '2026-12-01' },
    editableFields: ['lastWorkDate'],
    businessId: 'draft',
    revision: 8,
    patchOnly: true,
    send: (sent: { body: object }) =>
      model.recoverSelfRequest(path, () => api.request(path, { method: 'PATCH', command: sent })),
  };
  const submitted = store.submit(path, input);
  await vi.waitFor(() => expect(model.pendingReplay(path)).toBeDefined());
  await model.replaySelfRequest(path, () => api.request(path));
  if (replayResult !== 409) {
    expect(store.get(path)?.status).toBe('submitting');
    expect(model.pendingReplay(path)).toBeDefined();
    expect(writes[1]).toEqual(writes[0]);
    await model.replaySelfRequest(path, () => api.request(path));
  }
  await vi.waitFor(() => expect(store.get(path)?.status).toBe('conflict'));
  expect((await submitted).status).toBe('conflict');
  expect(model.pendingReplay(path)).toBeUndefined();
  expect(writes[conflictAttempt - 1]).toEqual(writes[0]);
  await store.reread(path, () => api.request(path));
  expect(reads).toHaveLength(conflictAttempt);
  expect(store.get(path)?.differences).toEqual([
    { field: 'lastWorkDate', before: '2026-12-01', latest: '2026-12-03', mine: '2026-12-02' },
  ]);
  expect((await store.submit(path, input)).status).toBe('conflict');
  expect(writes).toHaveLength(conflictAttempt);
  store.confirm(path);
  expect((await store.submit(path, input)).status).toBe('done');
  expect(writes.at(-1)).toMatchObject({ path, body: writes[0]!.body, revision: '9' });
  expect(writes.at(-1)!.key).not.toBe(writes[0]!.key);
});
