/**
 * R3-T04 PR-A 准备度共享字典（DEC-301①；设计 §2.1、§7 配置 CRUD 行）：
 * - 编码 / 名称租户唯一（409 READINESS_DUPLICATE），编码建后不可改（400）；颜色 #RRGGBB；
 * - 写入口 If-Match revision（409）与幂等键（同键同内容重放首次结果、异内容 409）；
 * - 被引用不可删（引用方登记守卫，409 READINESS_IN_USE，数据不变），停用后不可新选用（READINESS_DISABLED），已有引用保留；
 * - 可信端口 ReadinessPort.list 按排序号给出 id / code / name / description / color / sortNo / enabled；
 * - 三种写入都与业务同事务写数据变更日志，删除带快照。
 * 负向用例断言具体响应码，并前后各读一次对比，证明数据未改动。
 */
import { withTenant } from '@italent/db';
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  readinessPort,
  registerReadinessReferenceGuard,
  selectReadiness,
} from '../../apps/api/src/modules/talent-review/readiness-port.js';
import { auditApi } from './AC-AUD-support.js';
import { errorCode } from './support/tenant-api.js';
import { readinessBody, readinessWorld, TR_NOW } from './AC-TR-support.js';

const testDb = useTestDb();
const referenced = new Set<string>();
registerReadinessReferenceGuard(async (_tx, _tenantId, id) => (referenced.has(id) ? 'TEST_REFERRER' : null));

describe('R3-T04 准备度字典', () => {
  it('新建、列表按排序号、详情带 ETag；按启用状态筛选', async () => {
    const w = await readinessWorld(testDb().db, 'tr-crud');
    const later = await w.create(readinessBody({ name: '1~2 年', sortNo: 2, description: '中长期' }));
    const soon = await w.create(readinessBody({ name: '1 年内', sortNo: 1 }));
    const off = await w.create(readinessBody({ name: '推荐后续使用', sortNo: 3, enabled: false }));
    expect(later).toMatchObject({
      revision: 1,
      enabled: true,
      color: '#3366FF',
      description: '中长期',
      createdBy: w.as.user,
    });
    const list = await w.request('GET', '/readiness-levels');
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: { id: string }[]; hasDataPermission: boolean };
    expect(body.hasDataPermission).toBe(true);
    expect(body.items.map((item) => item.id)).toEqual([soon.id, later.id, off.id]);
    const enabled = (await (await w.request('GET', '/readiness-levels?enabled=true')).json()) as {
      items: { id: string }[];
    };
    expect(enabled.items.map((item) => item.id)).toEqual([soon.id, later.id]);
    const detail = await w.request('GET', `/readiness-levels/${soon.id.toUpperCase()}`);
    expect(detail.headers.get('etag')).toBe('"1"');
    expect(await detail.json()).toMatchObject({ id: soon.id, name: '1 年内' });
  });

  it('编码、名称重复 409；编码不可改、颜色不合法、多余字段 400；数据不变', async () => {
    const w = await readinessWorld(testDb().db, 'tr-unique');
    const first = await w.create(readinessBody({ code: 'RN1', name: '1 年内' }));
    for (const body of [readinessBody({ code: 'RN1' }), readinessBody({ name: '1 年内' })]) {
      const response = await w.request('POST', '/readiness-levels', { ifMatch: 0, body });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
        'READINESS_DUPLICATE',
      );
    }
    for (const body of [{ code: 'RN9' }, { color: 'red' }, { unknown: 1 }]) {
      const response = await w.request('PATCH', `/readiness-levels/${first.id}`, { ifMatch: 1, body });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(response)).toBe('VALIDATION_FAILED');
    }
    const second = await w.create(readinessBody({ name: '3~6 个月' }));
    const rename = await w.request('PATCH', `/readiness-levels/${second.id}`, { ifMatch: 1, body: { name: '1 年内' } });
    expect(rename.status).toBe(409);
    expect((await w.read(first.id)).body).toEqual(first);
    expect((await w.read(second.id)).body).toEqual(second);
  });

  it('修改要求当前 revision；同幂等键同内容重放首次结果，异内容 409', async () => {
    const w = await readinessWorld(testDb().db, 'tr-revision');
    const level = await w.create();
    const stale = await w.request('PATCH', `/readiness-levels/${level.id}`, { ifMatch: 7, body: { sortNo: 5 } });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('REVISION_CONFLICT');
    expect((await w.read(level.id)).body).toEqual(level);
    const missing = await w.request('PATCH', `/readiness-levels/${level.id}`, { body: { sortNo: 5 } });
    expect(await errorCode(missing)).toBe('REVISION_REQUIRED');
    const options = { ifMatch: 1, idempotencyKey: 'tr-patch-1', body: { sortNo: 5, description: '改过' } };
    const first = await w.request('PATCH', `/readiness-levels/${level.id}`, options);
    expect(first.status).toBe(200);
    const updated = (await first.json()) as typeof level;
    expect(updated).toMatchObject({ revision: 2, sortNo: 5, description: '改过' });
    const replay = await w.request('PATCH', `/readiness-levels/${level.id}`, options);
    expect([replay.status, await replay.json()]).toEqual([200, updated]);
    const conflict = await w.request('PATCH', `/readiness-levels/${level.id}`, { ...options, body: { sortNo: 6 } });
    expect(await errorCode(conflict)).toBe('IDEMPOTENCY_CONFLICT');
    expect((await w.read(level.id)).body).toEqual(updated);
  });

  it('被引用不可删（数据不变），可以停用；停用后不能新选用；未引用的可删除，删除后详情 404', async () => {
    const w = await readinessWorld(testDb().db, 'tr-delete');
    const level = await w.create();
    referenced.add(level.id);
    const blocked = await w.request('DELETE', `/readiness-levels/${level.id}`, { ifMatch: 1 });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { details: { reason: 'READINESS_IN_USE', referrer: 'TEST_REFERRER' } },
    });
    expect((await w.read(level.id)).body).toEqual(level);
    const select = (id: string) =>
      withTenant(testDb().db, w.as.tenant, (tx) => selectReadiness(tx, w.as.tenant, id)).then(
        (row) => row.code,
        (error: { details?: { reason?: string } }) => error.details?.reason,
      );
    expect(await select(level.id)).toBe(level.code);
    const disabled = await w.request('PATCH', `/readiness-levels/${level.id}`, {
      ifMatch: 1,
      body: { enabled: false },
    });
    expect(disabled.status).toBe(200);
    expect(await select(level.id)).toBe('READINESS_DISABLED');
    referenced.delete(level.id);
    const removed = await w.request('DELETE', `/readiness-levels/${level.id}`, { ifMatch: 2 });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ id: level.id, enabled: false });
    expect((await w.read(level.id)).status).toBe(404);
    expect(await select(level.id)).toBe('READINESS_UNKNOWN');
  });

  it('可信端口按排序号列出全部（含停用）；只读到当前租户', async () => {
    const db = testDb().db;
    const w = await readinessWorld(db, 'tr-port');
    const other = await readinessWorld(db, 'tr-port-other');
    const b = await w.create(readinessBody({ sortNo: 2, enabled: false }));
    const a = await w.create(readinessBody({ sortNo: 1, description: '描述' }));
    await other.create();
    const listed = await withTenant(db, w.as.tenant, (tx) => readinessPort.list(tx, w.as.tenant));
    expect(listed).toEqual([
      { id: a.id, code: a.code, name: a.name, description: '描述', color: '#3366FF', sortNo: 1, enabled: true },
      { id: b.id, code: b.code, name: b.name, description: null, color: '#3366FF', sortNo: 2, enabled: false },
    ]);
    const cross = await other.request('GET', `/readiness-levels/${a.id}`);
    expect(cross.status).toBe(404);
  });

  it('新增 / 修改 / 删除都写数据变更日志，修改只记改动字段，删除带快照', async () => {
    const w = await readinessWorld(testDb().db, 'tr-audit');
    const audit = auditApi(testDb().db, TR_NOW.toISOString());
    const level = await w.create();
    await w.request('PATCH', `/readiness-levels/${level.id}`, { ifMatch: 1, body: { name: '改名' } });
    await w.request('DELETE', `/readiness-levels/${level.id}`, { ifMatch: 2 });
    const objectType = TALENT_REVIEW_OBJECTS.readiness.code;
    const { items } = await audit.dataChanges(w.as, { objectType, limit: '50' });
    expect(items.map((entry) => entry.operation).sort()).toEqual(['create', 'delete', 'update']);
    for (const entry of items) expect(entry).toMatchObject({ app: '人才盘点', objectId: level.id });
    const update = items.find((entry) => entry.operation === 'update')!;
    expect(update.changes.map((change) => change.field)).toEqual(['name']);
    const removed = await audit.dataChange(w.as, items.find((entry) => entry.operation === 'delete')!.id);
    expect(removed.snapshot).toMatchObject({ id: level.id, code: level.code, name: '改名' });
  });
});
