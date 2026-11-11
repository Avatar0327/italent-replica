/** F-326 S2：真实应用 HTTP 入口、命令事务及变量管理边界。全部租户造数经 withTenant。 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { permissionAdmins, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { world } from './AC-EXIT-F316-support.js';
import { createPermissionAuthorizer } from '../../apps/api/src/modules/permission/authorizer.js';
import * as approvalContext from '../../apps/api/src/modules/approval/context.js';
import { AppError } from '../../apps/api/src/errors.js';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const base = '/api/tenant/approval/variables';
const now = new Date('2026-10-06T01:00:00Z');
let x: Awaited<ReturnType<typeof world>>;
let stranger: Awaited<ReturnType<typeof world>>;
let api: ReturnType<typeof tenantApi>;
let server: Server;
let address: string;
let external: string;
let departed: string;

beforeAll(async () => {
  x = await world(database().db, 'f326s2');
  stranger = await world(x.db, 'f326s2-other');
  external = (await x.otherUser()).id;
  const left = await x.person('合成已离职');
  departed = left.userId;
  const employee = await x.session.getEmployee(left.employeeId);
  await x.session.business(
    left.employeeId,
    { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-02' },
    employee.revision,
  );
  api = tenantApi(x.db, { clock: () => now });
  // TCP 请求仍经真实 createApp 的身份、JSON、limitBody、路由与命令链。
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(key, value);
    }
    const result = await api.app.request(request.url!, {
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
  if (server)
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

function input(over: Record<string, unknown> = {}) {
  return {
    scope: 'public',
    codeSuffix: `V${uniqueSuffix()}`,
    name: '合成变量',
    dataType: 'string',
    defaultValue: '初值',
    usageScopes: ['process'],
    enable: false,
    ...over,
  };
}
function request(method: string, path = '', body?: unknown, revision = 0, key = randomUUID()) {
  return api.request(method, `${base}${path}`, {
    ...x.tenantAs(x.processAdmin.id),
    body,
    ifMatch: revision,
    idempotencyKey: key,
  });
}
async function body(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json();
}
async function create(over: Record<string, unknown> = {}) {
  return body(await request('POST', '', input(over)), 201);
}
async function stored() {
  return withTenant(x.db, x.tenantId, async (tx) =>
    rowsOf(
      await tx.execute(sql`
    SELECT id, code, name, default_value, status, revision FROM approval_variables ORDER BY id`),
    ),
  );
}
async function counts(key: string) {
  return withTenant(
    x.db,
    x.tenantId,
    async (tx) =>
      rowsOf(
        await tx.execute(sql`
    SELECT (SELECT count(*)::int FROM command_ledger WHERE command_id=${key}) AS ledger,
      (SELECT count(*)::int FROM audit_events WHERE command_id=${key}) AS audit,
      (SELECT count(*)::int FROM approval_outbox WHERE command_id=${key}) AS outbox`),
      )[0],
  );
}
async function rejectUnchanged(
  method: string,
  path: string,
  value: unknown,
  revision: number,
  status: number,
  reason?: string,
) {
  const before = await stored();
  const response = await body(await request(method, path, value, revision), status);
  if (reason) expect(response.error.details.reason).toBe(reason);
  expect(await stored()).toEqual(before);
  return response;
}

describe('AC-APV-F326-02 / 03 编码与默认值', () => {
  it.each(['2', '19', 'ee'])('应用后缀 %s 可保存，公共前缀单独处理', async (codeSuffix) => {
    const result = await create({ scope: 'application', appId: 'transfer', usageScopes: [], codeSuffix });
    expect(result.code).toBe(`B.${codeSuffix}`);
    expect(result.appId).toBe('transfer');
  });
  it('公共编码前缀、重复编码与保留字段', async () => {
    expect((await create({ codeSuffix: 'HTCtoTind0' })).code).toBe('Global.B.HTCtoTind0');
    for (const codeSuffix of ['2x', 'has-dash', 'Global.B.X', 'B.X'])
      await rejectUnchanged('POST', '', input({ codeSuffix }), 0, 400);
    await rejectUnchanged(
      'POST',
      '',
      input({ scope: 'application', appId: 'transfer', usageScopes: [], codeSuffix: 'x-y' }),
      0,
      400,
    );
    await rejectUnchanged('POST', '', input({ codeSuffix: 'HTCtoTind0' }), 0, 409);
    for (const extra of [
      { origin: 'auto' },
      { updatedBy: x.processAdmin.id },
      { status: 'enabled' },
      { originSlot: 'approver' },
    ])
      await rejectUnchanged('POST', '', input(extra), 0, 400);
  });
  it.each([
    ['string', '字符串\t\n😀', 100],
    ['integer', Number.MAX_SAFE_INTEGER, '42'],
    ['decimal', '-123.4500', 12.3],
    ['datetime', '2026-10-06T09:00:00+08:00', '2026-02-30T00:00:00Z'],
    ['boolean', false, 'false'],
  ])('%s 默认值保留类型、拒绝错误形态', async (dataType, value, invalid) => {
    const created = await create({ dataType, defaultValue: value, enable: true });
    expect(created.defaultValue).toEqual(dataType === 'datetime' ? new Date(String(value)).toISOString() : value);
    expect(created.status).toBe('enabled');
    const saved = await body(
      await request('PATCH', `/${created.id}`, { defaultValue: created.defaultValue }, created.revision),
    );
    expect(saved.defaultValue).toEqual(created.defaultValue);
    await rejectUnchanged('PATCH', `/${created.id}`, { defaultValue: invalid }, saved.revision, 400);
  });
  it.each(
    ['public', 'application'].flatMap((scope) =>
      [
        { date: '0000-01-01T00:00:00+01:00', utc: '-000001-12-31T23:00:00.000Z' },
        { date: '9999-12-31T23:59:59-01:00', utc: '+010000-01-01T00:59:59.000Z' },
      ].map((boundary) => ({ scope, ...boundary })),
    ),
  )('AC-APV-F326-03 $scope UTC 年份边界 $date 可原样回传编辑', async ({ scope, date, utc }) => {
    let value = await create({
      scope,
      ...(scope === 'application' ? { appId: 'transfer', usageScopes: [] } : {}),
      dataType: 'datetime',
      defaultValue: date,
    });
    expect(value.defaultValue).toBe(utc);
    for (const action of [null, 'enable', 'disable'] as const) {
      if (action) value = await body(await request('POST', `/${value.id}/${action}`, {}, value.revision));
      const read = await body(await request('GET', `/${value.id}`));
      const saved = await body(
        await request('PATCH', `/${value.id}`, { name: '边界时间', defaultValue: read.defaultValue }, read.revision),
      );
      expect(saved.defaultValue).toBe(utc);
      expect(saved.revision).toBe(read.revision + 1);
      value = saved;
    }
    const rejected = await rejectUnchanged(
      'PATCH',
      `/${value.id}`,
      { defaultValue: '+010001-01-01T00:00:00.000Z' },
      value.revision,
      400,
    );
    expect(rejected.error.details.reason).toBe('DEFAULT_VALUE_TYPE');
    const changed = await body(
      await request('PATCH', `/${value.id}`, { defaultValue: '2026-01-01T08:00:00+08:00' }, value.revision),
    );
    expect(changed.defaultValue).toBe('2026-01-01T00:00:00.000Z');
  });
  it.each(['123', 'false', 'null', '"带引号"', '[1,2]'])(
    'AC-APV-F326-03 字符串 %s 不被 JSON 二次解码',
    async (text) => {
      const value = await create({ defaultValue: text });
      expect(value.defaultValue).toBe(text);
      expect((await body(await request('GET', `/${value.id}`))).defaultValue).toBe(text);
      const changed = await body(await request('PATCH', `/${value.id}`, { defaultValue: '0' }, value.revision));
      expect(changed.defaultValue).toBe('0');
    },
  );
  it('人员资格、UUID 规范化、多人上限与最少回显字段', async () => {
    for (const id of [external, departed, stranger.workOwner.userId, randomUUID()])
      await rejectUnchanged('POST', '', input({ dataType: 'person', defaultValue: id }), 0, 400);
    const person = await create({ dataType: 'person', defaultValue: x.workOwner.userId.toUpperCase(), enable: true });
    expect(person.defaultValue).toBe(x.workOwner.userId);
    expect(person.people).toEqual([expect.objectContaining({ userId: x.workOwner.userId, name: '工作交接人' })]);
    expect(Object.keys(person.people[0]).sort()).toEqual(['code', 'departmentId', 'departmentName', 'name', 'userId']);
    const group = await create({ dataType: 'persons', defaultValue: [x.workOwner.userId, x.hrbp.userId] });
    expect(group.defaultValue).toEqual([x.workOwner.userId, x.hrbp.userId]);
    for (const value of [
      [],
      [x.workOwner.userId, x.workOwner.userId.toUpperCase()],
      Array.from({ length: 101 }, () => randomUUID()),
    ])
      await rejectUnchanged('PATCH', `/${group.id}`, { defaultValue: value }, group.revision, 400);
  });
  it('公共范围非空，应用无范围和描述，应用标识有效', async () => {
    for (const over of [
      { usageScopes: [] },
      { usageScopes: ['unknown'] },
      { usageScopes: ['process', 'process'] },
      { appId: 'transfer' },
      { scope: 'application', appId: 'missing', usageScopes: [] },
      { scope: 'application', appId: 'transfer', usageScopes: ['process'] },
      { scope: 'application', appId: 'transfer', usageScopes: [], description: '不应接收' },
    ])
      await rejectUnchanged('POST', '', input(over), 0, 400);
    const empty = await create({ dataType: 'person', defaultValue: null });
    await rejectUnchanged('POST', `/${empty.id}/enable`, {}, empty.revision, 409, 'APPROVAL_VARIABLE_EMPTY');
    await rejectUnchanged(
      'POST',
      '',
      input({ dataType: 'persons', defaultValue: null, enable: true }),
      0,
      409,
      'APPROVAL_VARIABLE_EMPTY',
    );
  });
});

describe('AC-APV-F326-04 / 05 / 06 状态、并发、台账与审计', () => {
  it('状态迁移、编辑只读字段、无删除入口', async () => {
    let value = await create();
    await rejectUnchanged('POST', `/${value.id}/disable`, {}, value.revision, 409);
    for (const action of ['enable', 'disable', 'enable']) {
      const previous = value.revision;
      value = await body(await request('POST', `/${value.id}/${action}`, {}, value.revision));
      expect(value.status).toBe(action === 'enable' ? 'enabled' : 'disabled');
      expect(value.revision).toBe(previous + 1);
      await rejectUnchanged('POST', `/${value.id}/${action}`, {}, value.revision, 409);
    }
    for (const edit of [
      { code: 'Global.B.Other' },
      { codeSuffix: 'Other' },
      { scope: 'application' },
      { appId: 'transfer' },
      { dataType: 'integer' },
      { updatedAt: now.toISOString() },
      { origin: 'manual' },
    ])
      await rejectUnchanged('PATCH', `/${value.id}`, edit, value.revision, 400);
    await rejectUnchanged('DELETE', `/${value.id}`, {}, value.revision, 404);
    const enabled = await create({ dataType: 'person', defaultValue: x.workOwner.userId, enable: true });
    await rejectUnchanged(
      'PATCH',
      `/${enabled.id}`,
      { defaultValue: null },
      enabled.revision,
      409,
      'APPROVAL_VARIABLE_EMPTY',
    );
    const disabled = await body(await request('POST', `/${enabled.id}/disable`, {}, enabled.revision));
    const cleared = await body(await request('PATCH', `/${enabled.id}`, { defaultValue: null }, disabled.revision));
    expect(cleared.defaultValue).toBeNull();
  });
  it('四个写入口可同键重放、异内容冲突，409 重读后可改回原值', async () => {
    const initial = input();
    const key = randomUUID();
    let value = await body(await request('POST', '', initial, 0, key), 201);
    expect(await body(await request('POST', '', initial, 0, key), 201)).toEqual(value);
    expect((await body(await request('POST', '', { ...initial, name: '冲突' }, 0, key), 409)).error.code).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
    for (const [method, suffix, edit] of [
      ['PATCH', '', { name: '新名称' }],
      ['POST', '/enable', {}],
      ['POST', '/disable', {}],
    ] as const) {
      const command = randomUUID();
      const prior = value.revision;
      const path = `/${value.id}${suffix}`;
      value = await body(await request(method, path, edit, prior, command));
      expect(await body(await request(method, path, edit, prior, command))).toEqual(value);
      const conflict = await rejectUnchanged(method, path, edit, prior, 409);
      expect(conflict.error.code).toBe('REVISION_CONFLICT');
      const read = await body(await request('GET', `/${value.id}`));
      expect(read.revision).toBe(value.revision);
      const changed = method === 'PATCH' ? { name: '合成变量' } : {};
      const nextSuffix = suffix === '/enable' ? '/disable' : suffix === '/disable' ? '/enable' : '';
      value = await body(await request(method, `/${value.id}${nextSuffix}`, changed, read.revision));
      if (method === 'POST') value = await body(await request('POST', `/${value.id}${suffix}`, {}, value.revision));
    }
  });
  it('AC-APV-F326-06 outbox 失败时变量、字段审计和台账一起回滚', async () => {
    let value = await create();
    for (const [method, path, data, revision] of [
      ['POST', '', input(), 0],
      ['PATCH', `/${value.id}`, { name: '必须回滚' }, value.revision],
      ['POST', `/${value.id}/enable`, {}, value.revision],
    ] as const) {
      const key = randomUUID();
      const before = await stored();
      const spy = vi
        .spyOn(approvalContext, 'emitOutbox')
        .mockRejectedValueOnce(new AppError('SERVICE_UNAVAILABLE', '合成事件写入失败'));
      try {
        await body(await request(method, path, data, revision, key), 503);
      } finally {
        spy.mockRestore();
      }
      expect(await stored()).toEqual(before);
      expect(await counts(key)).toEqual({ ledger: 0, audit: 0, outbox: 0 });
    }
    value = await body(await request('POST', `/${value.id}/enable`, {}, value.revision));
    const before = await stored();
    const key = randomUUID();
    const spy = vi
      .spyOn(approvalContext, 'emitOutbox')
      .mockRejectedValueOnce(new AppError('SERVICE_UNAVAILABLE', '合成事件写入失败'));
    try {
      await body(await request('POST', `/${value.id}/disable`, {}, value.revision, key), 503);
    } finally {
      spy.mockRestore();
    }
    expect(await stored()).toEqual(before);
    expect(await counts(key)).toEqual({ ledger: 0, audit: 0, outbox: 0 });
  });
  it('并发编辑只有一份提交，失败不入台账，创建并启用记两条完整审计', async () => {
    const key = randomUUID();
    const initial = input({ dataType: 'persons', defaultValue: [x.workOwner.userId, x.hrbp.userId], enable: true });
    const value = await body(await request('POST', '', initial, 0, key), 201);
    expect(await counts(key)).toEqual({ ledger: 1, audit: 2, outbox: 2 });
    const results = await Promise.all(
      ['甲', '乙'].map((name) => request('PATCH', `/${value.id}`, { name }, value.revision)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const read = await body(await request('GET', `/${value.id}`));
    const updateKey = randomUUID();
    const updated = await body(
      await request('PATCH', `/${value.id}`, { defaultValue: [x.hrbp.userId] }, read.revision, updateKey),
    );
    expect(updated.updatedBy).toBe(x.processAdmin.id);
    expect(updated.updatedAt).toBe(now.toISOString());
    const audit = await withTenant(x.db, x.tenantId, async (tx) =>
      rowsOf(
        await tx.execute(sql`
      SELECT action, object_type, before, after FROM audit_events WHERE command_id=${updateKey}`),
      ),
    );
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'approval.public_variable.update',
        object_type: 'approval-public-variable',
        before: expect.objectContaining({ defaultValue: [x.workOwner.userId, x.hrbp.userId] }),
        after: expect.objectContaining({ defaultValue: [x.hrbp.userId] }),
      }),
    ]);
    const invalidKey = randomUUID();
    await body(await request('PATCH', `/${value.id}`, { defaultValue: [external] }, updated.revision, invalidKey), 400);
    expect(await counts(invalidKey)).toEqual({ ledger: 0, audit: 0, outbox: 0 });
  });
});

describe('AC-APV-F326-07 / 08 列表与管理权限', () => {
  it('按应用、状态、关键字过滤，分页稳定且总数匹配', async () => {
    const name = `列表_${uniqueSuffix()}`;
    const a = await create({ name, scope: 'application', appId: 'transfer', usageScopes: [] });
    const b = await create({ name, scope: 'application', appId: 'transfer', usageScopes: [], enable: true });
    await create({ name, scope: 'application', appId: 'staff', usageScopes: [] });
    await create({ name });
    const query = `?scope=application&appId=transfer&status=active&q=${name}`;
    const list = await body(await request('GET', query));
    expect(list.total).toBe(2);
    expect(new Set(list.items.map((row: { id: string }) => row.id))).toEqual(new Set([a.id, b.id]));
    const one = await body(await request('GET', `${query}&offset=0&limit=1`));
    const two = await body(await request('GET', `${query}&offset=1&limit=1`));
    expect([one.items[0].id, two.items[0].id]).toEqual(list.items.map((row: { id: string }) => row.id));
    await body(await request('POST', `/${b.id}/disable`, {}, b.revision));
    expect((await body(await request('GET', query))).items.map((row: { id: string }) => row.id)).toEqual([a.id]);
    expect(
      (await body(await request('GET', query.replace('active', 'disabled')))).items.map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual([b.id]);
    expect((await body(await request('GET', '?scope=public&q=不存在的合成名称'))).items).toEqual([]);
    for (const query of [
      '?scope=bad',
      '?scope=public&limit=201',
      '?scope=public&offset=-1',
      '?scope=application',
      '?scope=public&status=bad',
    ])
      await body(await request('GET', query), 400);
  });
  it.each(['tenant_admin', 'system_admin', 'matrix_admin'])('AC-APV-F326-07 %s 的真实授权与撤权重放', async (role) => {
    const user = await x.otherUser();
    await withTenant(x.db, x.tenantId, (tx) =>
      tx.insert(permissionAdmins).values({ tenantId: x.tenantId, userId: user.id, role }),
    );
    const real = tenantApi(x.db, { authorize: createPermissionAuthorizer(x.db), clock: () => now });
    const calls: { method: string; path: string; body: unknown; ifMatch: number; idempotencyKey: string }[] = [];
    const call = async (method: string, path: string, input: unknown, revision: number) => {
      const spec = { method, path, body: input, ifMatch: revision, idempotencyKey: randomUUID() };
      calls.push(spec);
      return body(
        await real.request(method, `${base}${path}`, { ...x.tenantAs(user.id), ...spec }),
        path === '' ? 201 : 200,
      );
    };
    let value = await call('POST', '', input({ scope: 'application', appId: 'transfer', usageScopes: [] }), 0);
    value = await call('PATCH', `/${value.id}`, { name: '管理员修改' }, value.revision);
    value = await call('POST', `/${value.id}/enable`, {}, value.revision);
    value = await call('POST', `/${value.id}/disable`, {}, value.revision);
    await body(await real.request('GET', `${base}/${value.id}`, x.tenantAs(user.id)));
    await body(await real.request('GET', `${base}?scope=application&appId=transfer`, x.tenantAs(user.id)));
    await withTenant(x.db, x.tenantId, (tx) =>
      tx.execute(sql`UPDATE permission_admins SET status='revoked'
      WHERE tenant_id=${x.tenantId} AND user_id=${user.id}::uuid`),
    );
    const before = await stored();
    for (const spec of calls) {
      const denied = await real.request(spec.method, `${base}${spec.path}`, { ...x.tenantAs(user.id), ...spec });
      const result = await body(denied, 403);
      expect(result).not.toHaveProperty('id');
    }
    expect(await stored()).toEqual(before);
  });
  it('AC-APV-F326-07 前置检查通过后命令守卫仍重新验权', async () => {
    let checks = 0;
    const guarded = tenantApi(x.db, { authorize: (req) => req.action === 'admin.process_matrix' && ++checks === 1 });
    const key = randomUUID();
    const before = await stored();
    await body(
      await guarded.request('POST', base, {
        ...x.tenantAs(x.processAdmin.id),
        body: input(),
        ifMatch: 0,
        idempotencyKey: key,
      }),
      403,
    );
    expect(checks).toBeGreaterThan(1);
    expect(await stored()).toEqual(before);
    expect(await counts(key)).toEqual({ ledger: 0, audit: 0, outbox: 0 });
  });
  it('全部管理接口拒绝无能力账号，租户隔离及撤权后的命令重放', async () => {
    const key = randomUUID();
    const data = input();
    const created = await body(await request('POST', '', data, 0, key), 201);
    const denied = tenantApi(x.db, { authorize: () => false });
    for (const [method, path, value] of [
      ['GET', '?scope=public', undefined],
      ['GET', `/${created.id}`, undefined],
      ['POST', '', data],
      ['PATCH', `/${created.id}`, { name: '拒绝' }],
      ['POST', `/${created.id}/enable`, {}],
      ['POST', `/${created.id}/disable`, {}],
    ] as const) {
      const res = await denied.request(method, `${base}${path}`, {
        ...x.tenantAs(x.processAdmin.id),
        body: value,
        ifMatch: 1,
        idempotencyKey: key,
      });
      await body(res, 403);
    }
    await body(await api.request('GET', `${base}/${created.id}`, stranger.tenantAs(stranger.processAdmin.id)), 404);
    await body(
      await api.request('PATCH', `${base}/${created.id}`, {
        ...stranger.tenantAs(stranger.processAdmin.id),
        ifMatch: 1,
        body: { name: '越租户' },
      }),
      404,
    );
    expect((await body(await request('GET', `/${created.id}`))).name).toBe(data.name);
    for (const path of ['/not-a-uuid', '/not-a-uuid/enable'])
      await body(
        await request(path.endsWith('enable') ? 'POST' : 'GET', path, path.endsWith('enable') ? {} : undefined),
        400,
      );
  });
});

describe('AC-APV-F326-20 / 28 TCP 请求体与文本边界', () => {
  // 通过 tenantApi 生成真实签名请求头后转发 TCP，避免测试自造身份协议。
  async function tcp(method: string, path: string, raw: string, revision = 0) {
    let signed: HeadersInit | undefined;
    const original = api.app.request.bind(api.app);
    api.app.request = ((url, init) => {
      signed = init?.headers;
      return Promise.resolve(new Response('{}'));
    }) as typeof api.app.request;
    try {
      await request(method, path, {}, revision);
    } finally {
      api.app.request = original;
    }
    return fetch(`${address}${base}${path}`, { method, headers: signed, body: raw });
  }
  it('32766 中文字新建及编辑成功，超一字 / 128KiB+1 拒绝且无写入', async () => {
    const description = '中'.repeat(32766);
    const value = await body(await tcp('POST', '', JSON.stringify(input({ description }))), 201);
    expect(value.description).toBe(description);
    const edited = await body(
      await tcp('PATCH', `/${value.id}`, JSON.stringify({ description: '文'.repeat(32766) }), value.revision),
    );
    expect(edited.description.length).toBe(32766);
    const before = await stored();
    await body(await tcp('POST', '', JSON.stringify(input({ description: `${description}中` }))), 400);
    await body(await tcp('POST', '', ' '.repeat(128 * 1024 - 1) + '{}'), 413);
    await body(await tcp('PATCH', `/${value.id}`, ' '.repeat(128 * 1024 - 1) + '{}', edited.revision), 413);
    await body(await tcp('POST', `/${value.id}/enable`, ' '.repeat(32 * 1024 - 1) + '{}', edited.revision), 413);
    expect(await stored()).toEqual(before);
  });
  it('未配对代理与控制字符拒绝，合法多行和表情成功', async () => {
    const before = await stored();
    const failed = await body(await tcp('POST', '', JSON.stringify(input({ description: '说明\uD800' }))), 400);
    expect(failed.error.details.reason).toBe('TEXT_MALFORMED');
    expect(await stored()).toEqual(before);
    const created = await create({ description: '说明\t\n\r😀' });
    for (const [name, reason] of [
      ['\uDC00', 'TEXT_MALFORMED'],
      ['名称\t', 'TEXT_CONTROL_CHAR'],
      ['中'.repeat(101), 'TEXT_TOO_LONG'],
    ])
      await rejectUnchanged('PATCH', `/${created.id}`, { name }, created.revision, 400, reason);
    const result = await body(
      await tcp('PATCH', `/${created.id}`, JSON.stringify({ name: '说明\uDC00' }), created.revision),
      400,
    );
    expect(result.error.details.reason).toBe('TEXT_MALFORMED');
    expect((await body(await request('GET', `/${created.id}`))).revision).toBe(created.revision);
  });
});
