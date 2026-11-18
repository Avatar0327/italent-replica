/** F-469：真实 TCP HTTP 删除结果查询；同一套用例在 PGlite / PG16 app_owner 运行。 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createUser, grantMembership, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { createDevIdentityResolver, devIdentityHeaders } from '../../apps/api/src/identity.js';
import { seedTenantWithMember } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const base = '/api/tenant/employment/employment-types';
const secret = randomBytes(32).toString('hex');
let member: Awaited<ReturnType<typeof seedTenantWithMember>>;
let other: typeof member;
let peer: string;
let deny = '';
let server: Server;
let address: string;

beforeAll(async () => {
  const db = database().db;
  member = await seedTenantWithMember(db, 'f469');
  other = await seedTenantWithMember(db, 'f469-other');
  const meta = () => ({ actorUserId: null, commandId: randomUUID() });
  const user = await createUser(db, { email: `f469-${uniqueSuffix()}@example.com`, displayName: '合成成员' }, meta());
  await grantMembership(db, { tenantId: member.tenant.id, userId: user.id, expectedRevision: 0 }, meta());
  peer = user.id;
  const app = createApp({
    db,
    identity: createDevIdentityResolver({ secret }),
    authorize: (q) => !(q.action === deny || (deny === 'button' && q.action === 'object.button')),
  });
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
    const result = await app.request(request.url!, {
      method: request.method,
      headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const responseHeaders: Record<string, string> = {};
    result.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    response.writeHead(result.status, responseHeaders);
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});
function request(method: string, path: string, key = randomUUID(), revision = 1, body?: unknown, as = member) {
  return fetch(`${address}${base}${path}`, {
    method,
    headers: {
      ...devIdentityHeaders(secret, as.user.id),
      'x-tenant-id': as.tenant.id,
      'content-type': 'application/json',
      'idempotency-key': key,
      'if-match': String(revision),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function json(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json();
}
async function create() {
  return json(
    await request('POST', '', randomUUID(), 0, {
      name: '合成待删类别',
      displayOrder: 1,
      effectiveDate: '2020-01-01',
    }),
    201,
  ) as Promise<{ id: string; revision: number }>;
}
const resultPath = (id: string, key: string, revision = 1) => `/${id}/delete-result/${key}?revision=${revision}`;
async function snapshot() {
  return withTenant(database().db, member.tenant.id, (tx) =>
    tx.execute(sql`
    SELECT (SELECT count(*) FROM command_ledger) AS ledger,
      (SELECT count(*) FROM audit_events) AS audit,
      (SELECT count(*) FROM audit_command_failures) AS failures,
      (SELECT string_agg(id::text || ':' || revision || ':' || coalesce(deleted_at::text, ''), ',' ORDER BY id)
       FROM employment_types) AS records`),
  );
}

it('AC-EMP-F469-01 已删：同命令、对象、版本的权威回执；查询只读、不披露业务字段', async () => {
  const row = await create();
  const key = randomUUID();
  expect((await request('DELETE', `/${row.id}`, key)).status).toBe(200);
  const before = await snapshot();
  const response = await request('GET', resultPath(row.id, key));
  expect(await json(response)).toEqual({ commandId: key, id: row.id, revision: 1, status: 'deleted' });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await snapshot()).toEqual(before);
  for (const path of [resultPath(row.id, key, 2), resultPath(randomUUID(), key), resultPath(row.id, randomUUID())])
    expect((await json(await request('GET', path))).status).toBe('unknown');
});
it('AC-EMP-F469-02 明确失败为未删；无回执和同键其他动作失败仍未知，成功台账优先', async () => {
  const row = await create();
  const key = randomUUID();
  expect((await request('DELETE', `/${row.id}`, key, 0)).status).toBe(409);
  expect(await json(await request('GET', resultPath(row.id, key, 0)))).toEqual({
    commandId: key,
    id: row.id,
    revision: 0,
    status: 'not_deleted',
  });
  const wrong = randomUUID();
  expect((await request('POST', `/${row.id}/disable`, wrong, 0)).status).toBe(409);
  expect((await json(await request('GET', resultPath(row.id, wrong, 0)))).status).toBe('unknown');
  expect((await request('DELETE', `/${row.id}`, key)).status).toBe(200);
  expect((await json(await request('GET', resultPath(row.id, key)))).status).toBe('deleted');
});
it('AC-EMP-F469-03 查不到和非本人、跨租户不确认；撤销删除数据操作或按钮权返回 403', async () => {
  const row = await create();
  const key = randomUUID();
  expect((await request('DELETE', `/${row.id}`, key)).status).toBe(200);
  const path = resultPath(row.id, key);
  for (const as of [other, { ...member, user: { ...member.user, id: peer } }])
    expect((await json(await request('GET', path, randomUUID(), 1, undefined, as))).status).toBe('unknown');
  expect((await request('GET', path, randomUUID(), 1, undefined, { ...member, user: other.user })).status).toBe(403);
  const before = await snapshot();
  for (const action of ['object.delete', 'button']) {
    deny = action;
    try {
      expect((await request('GET', path)).status).toBe(403);
    } finally {
      deny = '';
    }
  }
  expect(await snapshot()).toEqual(before);
});
it('AC-EMP-F469-04 参数非法拒绝，缺失版本不能猜测', async () => {
  const id = randomUUID();
  for (const path of [resultPath('bad', 'key'), `/${id}/delete-result/key`, resultPath(id, 'key', -1)])
    expect((await request('GET', path)).status).toBe(400);
});

it('AC-EMP-F469-05 同键成功的其他动作不当删除；未来版本失败不能据此解锁', async () => {
  const row = await create();
  expect((await json(await request('GET', resultPath(row.id, randomUUID())))).status).toBe('unknown');
  const key = randomUUID();
  expect((await request('POST', `/${row.id}/disable`, key)).status).toBe(200);
  expect((await json(await request('GET', resultPath(row.id, key)))).status).toBe('unknown');
  const future = randomUUID();
  expect((await request('DELETE', `/${row.id}`, future, 99)).status).toBe(409);
  expect((await json(await request('GET', resultPath(row.id, future, 99)))).status).toBe('unknown');
});
