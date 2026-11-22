import { expect, it } from 'vitest';
import { parseSourceSignContext, parseSourceSignReceipt, sourceSignKey, sourceSignPath } from './source-sign-model.js';

const id = '12345678-1234-4123-8123-123456789000';
const taskId = '12345678-1234-4123-8123-123456789001';
const source = { kind: 'offer', id } as const;

it('来源适配只接受同一来源的有效版本及回执，两个场景独立定位', () => {
  const context = { sourceId: id, revision: 3, canInitiate: true, items: [] };
  expect(parseSourceSignContext(context, source)).toMatchObject({ revision: 3, canInitiate: true });
  expect(() => parseSourceSignContext({ ...context, revision: 0 }, source)).toThrow();
  expect(() => parseSourceSignContext({ ...context, sourceId: taskId }, source)).toThrow();
  expect(parseSourceSignReceipt({ sourceId: id, taskId }, source)).toEqual({ sourceId: id, taskId });
  expect(() => parseSourceSignReceipt({ sourceId: taskId, taskId }, source)).toThrow();
  expect(sourceSignPath(source)).toBe(`/api/tenant/offers/${id}`);
  expect(sourceSignPath({ kind: 'entry', id })).toBe(`/api/tenant/employment/pending-entries/${id}`);
});

it('命令槽按租户、会话用户、身份、来源类型和来源 ID 隔离', () => {
  const session = { tenantId: 'ZZ_F505_TENANT', identityKey: 'ZZ_F505_IDENTITY', userId: 'ZZ_F505_USER' };
  const keys = [
    sourceSignKey(session, source),
    sourceSignKey({ ...session, tenantId: 'ZZ_F505_OTHER_TENANT' }, source),
    sourceSignKey({ ...session, identityKey: 'ZZ_F505_OTHER_IDENTITY' }, source),
    sourceSignKey({ ...session, userId: 'ZZ_F505_OTHER_USER' }, source),
    sourceSignKey(session, { kind: 'entry', id }),
    sourceSignKey(session, { ...source, id: taskId }),
  ];
  expect(new Set(keys).size).toBe(keys.length);
});
