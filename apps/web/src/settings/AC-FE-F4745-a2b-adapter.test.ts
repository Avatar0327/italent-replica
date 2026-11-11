import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, ApiError } from '../foundation/client.js';
import { dialogBody, dialogPath, snapshotOf, writableKeys } from './object-dialog-model.js';
import { readDialog, saveDialog } from './object-dialog-api.js';
const id = '60000000-0000-4000-8000-000000000479';
const objectCode = 'Demo.Object';
const path = dialogPath(id, objectCode, 'fields');
const api = createApiClient(() => ({ tenantId: 'synthetic-tenant', identityKey: 'synthetic-admin' }));
const row = (fieldCode: string) => ({ fieldCode, system: false, view: false, edit: false });
const reply = (items = [row('Name')], total = items.length) => ({
  profileId: id,
  objectCode,
  revision: 3,
  items,
  total,
  catalogDigest: '0123456789abcdef',
});
afterEach(() => vi.unstubAllGlobals());
describe('AC-FE-F4745-A2b 弹窗契约边界', () => {
  it('空字段集有合法基线；系统字段仅可提交查看；独立编辑值保留', () => {
    expect(snapshotOf(reply([]), id, objectCode, 'fields').rows).toEqual({});
    const snapshot = snapshotOf(reply([{ ...row('Name'), system: true }]), id, objectCode, 'fields');
    expect(writableKeys(snapshot, 'fields')).toEqual(['view:Name']);
    expect(dialogBody('fields', { 'edit:Name': true }, snapshot.values)).toEqual({
      catalogDigest: '0123456789abcdef',
      fields: [{ fieldCode: 'Name', view: false, edit: true }],
    });
  });
  it.each([
    { profileId: 'another' },
    { objectCode: 'Other.Object' },
    { revision: -1 },
    { catalogDigest: '' },
    { total: 0 },
    { items: [row('Name'), row('Name')] },
  ])('拒绝无效读取回执 %j', (change) => {
    expect(() => snapshotOf({ ...reply(), ...change }, id, objectCode, 'fields')).toThrow('返回数据不完整');
  });
  it('重读逐页收齐501字段，各页使用500上限且不带空编码条件', async () => {
    const requests: URL[] = [];
    const items = Array.from({ length: 501 }, (_, index) => row(`Field${index}`));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (raw: string) => {
        const url = new URL(raw, 'http://localhost');
        requests.push(url);
        const offset = Number(url.searchParams.get('offset'));
        return Response.json(reply(items.slice(offset, offset + 500), 501));
      }),
    );
    const latest = await readDialog(api, path, id, objectCode, 'fields');
    expect(Object.keys(latest.rows)).toHaveLength(501);
    expect(requests.map((url) => url.search)).toEqual(['?limit=500&offset=0', '?limit=500&offset=500']);
  });
  it('重读期间跨页revision变化拒绝拼出混合版本', async () => {
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        reads++;
        return Response.json({ ...reply([row(`Field${reads}`)], 2), revision: reads + 2 });
      }),
    );
    await expect(readDialog(api, path, id, objectCode, 'fields')).rejects.toThrow('返回数据不完整');
  });
  it.each(['wrong-receipt', 'read-fails'])('写成功后%s保持结果未知的错误类型', async (scenario) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_raw: string, init?: RequestInit) => {
        if (init?.method === 'PUT')
          return Response.json({ profileId: id, objectCode, revision: scenario === 'wrong-receipt' ? 8 : 4 });
        return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
      }),
    );
    const error = await saveDialog(
      api,
      path,
      id,
      objectCode,
      'fields',
      { id: 'synthetic-command', revision: 3, body: { 'view:Name': true } },
      snapshotOf(reply(), id, objectCode, 'fields').values,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApiError);
  });
});
