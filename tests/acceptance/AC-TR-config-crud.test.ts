/**
 * R3-T04 PR-B1 盘点分类 / 盘点角色的配置 CRUD（设计 §2.2、§7 配置 CRUD 行；DEC-067、DEC-216）：
 * - 名称（角色另有编码）租户唯一 409；角色编码建后不可改；严格结构，多余字段 400；
 * - 写入口 If-Match revision（409）与幂等键（同键同内容重放首次结果、异内容 409）；
 * - 被引用不可删（引用方登记守卫，409 <对象>_IN_USE，数据不变），停用保留；
 * - 三种写入都与业务同事务写数据变更日志，修改只记改动字段，删除带快照；其他租户读不到。
 * 负向用例断言具体响应码，并前后各读一次对比，证明数据未改动。
 */
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerConfigReferenceGuard } from '../../apps/api/src/modules/talent-review/config-kit.js';
import { auditApi } from './AC-AUD-support.js';
import { configBody, configWorld, CONFIG_KINDS, type ConfigView, TR_NOW } from './AC-TR-config-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();
const referenced = new Set<string>();
for (const kind of ['category', 'role'] as const) {
  registerConfigReferenceGuard(kind, async (_tx, _tenantId, id) => (referenced.has(id) ? 'TEST_REFERRER' : null));
}
const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details: { reason: string } } }).error.details.reason;

describe.each(['category', 'role'] as const)('盘点配置 CRUD（DEC-067 / DEC-216）· %s', (kind) => {
  const { path, duplicate, inUse } = CONFIG_KINDS[kind];

  it('新建、列表按排序号、详情带 ETag；按启用状态筛选；其他租户看不到', async () => {
    const db = testDb().db;
    const w = await configWorld(db, `trc-crud-${kind}`);
    const other = await configWorld(db, `trc-crud-other-${kind}`);
    const later = await w.create(kind, configBody(kind, { sortNo: 2 }));
    const soon = await w.create(kind, configBody(kind, { sortNo: 1 }));
    const off = await w.create(kind, configBody(kind, { sortNo: 3, enabled: false }));
    expect(later).toMatchObject({ revision: 1, enabled: true, createdBy: w.as.user });
    const list = await w.request('GET', path);
    const body = (await list.json()) as { items: { id: string }[]; hasDataPermission: boolean };
    expect(body.hasDataPermission).toBe(true);
    expect(body.items.map((item) => item.id)).toEqual([soon.id, later.id, off.id]);
    const enabled = (await (await w.request('GET', `${path}?enabled=true`)).json()) as { items: { id: string }[] };
    expect(enabled.items.map((item) => item.id)).toEqual([soon.id, later.id]);
    const detail = await w.request('GET', `${path}/${soon.id.toUpperCase()}`);
    expect(detail.headers.get('etag')).toBe('"1"');
    expect(await detail.json()).toMatchObject({ id: soon.id });
    expect((await other.read(kind, soon.id)).status).toBe(404);
    expect(((await (await other.request('GET', path)).json()) as { items: unknown[] }).items).toEqual([]);
  });

  it('名称重复 409、多余字段 400；数据不变', async () => {
    const w = await configWorld(testDb().db, `trc-unique-${kind}`);
    const first = await w.create(kind);
    const dup = await w.request('POST', path, { ifMatch: 0, body: configBody(kind, { name: first.name }) });
    expect([dup.status, await reasonOf(dup)]).toEqual([409, duplicate]);
    const second = await w.create(kind);
    const rename = await w.request('PATCH', `${path}/${second.id}`, { ifMatch: 1, body: { name: first.name } });
    expect([rename.status, await reasonOf(rename)]).toEqual([409, duplicate]);
    const extra = await w.request('POST', path, { ifMatch: 0, body: configBody(kind, { unknown: 1 }) });
    expect([extra.status, await errorCode(extra)]).toEqual([400, 'VALIDATION_FAILED']);
    expect((await w.read(kind, first.id)).body).toEqual(first);
    expect((await w.read(kind, second.id)).body).toEqual(second);
  });

  it('修改要求当前 revision；同幂等键同内容重放首次结果，异内容 409', async () => {
    const w = await configWorld(testDb().db, `trc-revision-${kind}`);
    const item = await w.create(kind);
    const stale = await w.request('PATCH', `${path}/${item.id}`, { ifMatch: 7, body: { sortNo: 5 } });
    expect([stale.status, await errorCode(stale)]).toEqual([409, 'REVISION_CONFLICT']);
    const missing = await w.request('PATCH', `${path}/${item.id}`, { body: { sortNo: 5 } });
    expect(await errorCode(missing)).toBe('REVISION_REQUIRED');
    expect((await w.read(kind, item.id)).body).toEqual(item);
    const options = { ifMatch: 1, idempotencyKey: `trc-patch-${kind}`, body: { sortNo: 5, enabled: false } };
    const first = await w.request('PATCH', `${path}/${item.id}`, options);
    expect(first.status).toBe(200);
    const updated = (await first.json()) as ConfigView;
    expect(updated).toMatchObject({ revision: 2, sortNo: 5, enabled: false });
    const replay = await w.request('PATCH', `${path}/${item.id}`, options);
    expect([replay.status, await replay.json()]).toEqual([200, updated]);
    const conflict = await w.request('PATCH', `${path}/${item.id}`, { ...options, body: { sortNo: 6 } });
    expect(await errorCode(conflict)).toBe('IDEMPOTENCY_CONFLICT');
    expect((await w.read(kind, item.id)).body).toEqual(updated);
  });

  it('被引用不可删（数据不变），可以停用；未引用的可删除，删除后详情 404', async () => {
    const w = await configWorld(testDb().db, `trc-delete-${kind}`);
    const item = await w.create(kind);
    referenced.add(item.id);
    const blocked = await w.request('DELETE', `${path}/${item.id}`, { ifMatch: 1 });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { details: { reason: inUse, referrer: 'TEST_REFERRER' } } });
    expect((await w.read(kind, item.id)).body).toEqual(item);
    const disabled = await w.request('PATCH', `${path}/${item.id}`, { ifMatch: 1, body: { enabled: false } });
    expect(disabled.status).toBe(200);
    referenced.delete(item.id);
    const removed = await w.request('DELETE', `${path}/${item.id}`, { ifMatch: 2 });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ id: item.id, enabled: false });
    expect((await w.read(kind, item.id)).status).toBe(404);
  });

  it('新增 / 修改 / 删除都写数据变更日志，修改只记改动字段，删除带快照', async () => {
    const w = await configWorld(testDb().db, `trc-audit-${kind}`);
    const audit = auditApi(testDb().db, TR_NOW.toISOString());
    const item = await w.create(kind);
    await w.request('PATCH', `${path}/${item.id}`, { ifMatch: 1, body: { name: '改名' } });
    await w.request('DELETE', `${path}/${item.id}`, { ifMatch: 2 });
    const objectType = TALENT_REVIEW_OBJECTS[kind].code;
    const { items } = await audit.dataChanges(w.as, { objectType, limit: '50' });
    expect(items.map((entry) => entry.operation).sort()).toEqual(['create', 'delete', 'update']);
    for (const entry of items) expect(entry).toMatchObject({ app: '人才盘点', objectId: item.id });
    const update = items.find((entry) => entry.operation === 'update')!;
    expect(update.changes.map((change) => change.field)).toEqual(['name']);
    const removed = await audit.dataChange(w.as, items.find((entry) => entry.operation === 'delete')!.id);
    expect(removed.snapshot).toMatchObject({ id: item.id, name: '改名' });
  });
});

describe('盘点角色（设计 §2.2、§3.4；DEC-067）', () => {
  it('编码租户唯一且建后不可改；执行人解析方式限四种', async () => {
    const w = await configWorld(testDb().db, 'trc-role');
    const role = await w.create('role', configBody('role', { resolver: 'designated' }));
    expect(role).toMatchObject({ resolver: 'designated' });
    const dup = await w.request('POST', '/roles', {
      ifMatch: 0,
      body: configBody('role', { code: role.code as string }),
    });
    expect([dup.status, await reasonOf(dup)]).toEqual([409, 'ROLE_DUPLICATE']);
    for (const body of [{ code: 'other' }, { resolver: 'anyone' }]) {
      const response = await w.request('PATCH', `/roles/${role.id}`, { ifMatch: 1, body });
      expect([response.status, await errorCode(response)], JSON.stringify(body)).toEqual([400, 'VALIDATION_FAILED']);
    }
    const bad = await w.request('POST', '/roles', { ifMatch: 0, body: configBody('role', { resolver: 'boss' }) });
    expect(bad.status).toBe(400);
    const changed = await w.request('PATCH', `/roles/${role.id}`, { ifMatch: 1, body: { resolver: 'self' } });
    expect(await changed.json()).toMatchObject({ resolver: 'self', code: role.code });
  });
});
