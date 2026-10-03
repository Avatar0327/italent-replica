import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { personnelSession } from './AC-SUB-support.js';
import { tenantApi } from './support/tenant-api.js';
const database = useTestDb();

it('DEC-080 人员子集使用真实 create 与按钮，只校验提交的字段', async () => {
  const s = await personnelSession(database().db);
  const calls: { action: string; fields?: readonly string[]; resource?: string }[] = [];
  const api = tenantApi(database().db, {
    authorize: (request) => {
      calls.push(request);
      return !request.fields?.includes('degree');
    },
  });
  const path = `/api/tenant/personnel${s.path('education')}`;
  const response = await api.request('POST', path, { ...s.as, ifMatch: 0, body: { school: '授权大学' } });
  expect(response.status).toBe(201);
  expect(calls).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: 'object.create', resource: 'TenantBase.Education', fields: ['school'] }),
      expect.objectContaining({ action: 'object.button', resource: 'TenantBase.Education#create#list' }),
    ]),
  );
  const forbidden = await api.request('POST', path, { ...s.as, ifMatch: 0, body: { degree: '学士' } });
  expect(forbidden.status).toBe(403);
});
