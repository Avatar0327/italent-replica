/**
 * AC-SC-01（R3-T05 A2，设计 §2.2 #3 / #3a / #4 / #5 / #6、§5.1～§5.3、§7；DEC-305 / DEC-308 / DEC-343 / DEC-311③）：
 * 继任记录写侧——新增（含历史补录）、编辑、批量结束、软删除、继任者候选；区间不重叠
 * （SUCCESSION_DUPLICATE / SUCCESSION_PERIOD_OVERLAP）；命令执行协议（同键重放、同键异内容、缺键）；
 * 计划屏障判定点（本 PR 恒为无屏障，D1 接入；这里验证写入口都经过它）。
 * 错误码沿用统一集合（AGENTS §10）：业务码放 details.reason，如 CONFLICT + reason = SUCCESSION_DUPLICATE。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setSyncBarrier } from '../../apps/api/src/modules/succession/sync-barrier.js';
import {
  OPEN_END,
  type ReadinessSeed,
  type RecordView,
  SC_TODAY,
  type SuccessionWorld,
  successionWorld,
} from './AC-SC-support.js';

const testDb = useTestDb();
type Failure = { error: { code: string; details?: { reason?: string } } };
const errorOf = async (response: Response) => ((await response.json()) as Failure).error;

describe('AC-SC-01 继任记录写侧（设计 §2.2 #3～#6）', () => {
  let w: SuccessionWorld;
  let std: Awaited<ReturnType<SuccessionWorld['standard']>>;
  let level: ReadinessSeed;
  let seq = 0;

  beforeAll(async () => {
    w = await successionWorld(testDb().db, 'sc-write');
    std = await w.standard();
    level = await w.readiness('可接任');
  });
  afterEach(() => setSyncBarrier(undefined));

  /** 每个用例用新的继任者，互不影响。 */
  const successor = () => w.hire(`继任者${++seq}`, { departmentId: std.orgB.id });
  const post = (body: object, options: { idempotencyKey?: string | null } = {}) =>
    w.request('POST', '/records', { body, ...options });
  const orgBody = (employeeId: string, extra: object = {}) => ({
    successionType: 'org',
    targetOrgId: std.orgA.id,
    successorEmployeeId: employeeId,
    readinessId: level.id,
    startDate: '2026-09-01',
    ...extra,
  });
  const positionBody = (employeeId: string, extra: object = {}) => ({
    successionType: 'position',
    targetPositionId: std.keyPosition.id,
    successorEmployeeId: employeeId,
    startDate: '2026-09-01',
    ...extra,
  });
  const created = async (body: object) => {
    const response = await post(body);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as RecordView;
  };
  const rowOf = async (id: string) =>
    w.asTenant(async (tx) => {
      const rows = (await tx.execute(sql`SELECT * FROM succession_records WHERE id = ${id}::uuid`)) as unknown as
        Record<string, unknown>[] | { rows: Record<string, unknown>[] };
      return (Array.isArray(rows) ? rows : rows.rows)[0];
    });
  const audits = async (id: string, action: string) =>
    w.asTenant(async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM audit_events WHERE object_id::text = ${id} AND action = ${action}`,
      )) as unknown as { n: number }[] | { rows: { n: number }[] };
      return (Array.isArray(rows) ? rows : rows.rows)[0]!.n;
    });

  describe('POST /records 新增', () => {
    it('组织继任：201 + ETag，生效状态、嵌套继任者“姓名(邮箱)”照原站、写字段级审计', async () => {
      const s = await successor();
      const response = await post(orgBody(s.id, { backupType: 'deputy' }));
      expect(response.status, await response.clone().text()).toBe(201);
      expect(response.headers.get('etag')).toBe('"1"');
      const view = (await response.json()) as RecordView;
      expect(view).toMatchObject({
        successionType: 'org',
        targetOrgId: std.orgA.id,
        successorEmployeeId: s.id,
        readinessId: level.id,
        backupType: 'deputy',
        startDate: '2026-09-01',
        endDate: null,
        status: 'active',
        sourceKind: 'manual',
        revision: 1,
      });
      expect(view.successor?.employeeId).toBe(s.id);
      expect(view.personInCharge?.employeeId).toBe(std.head.id);
      expect(await audits(view.id, 'succession.record.create')).toBe(1);
      expect((await rowOf(view.id))?.end_date).toBeDefined();
    });

    it('职位继任：目标职位须是关键职位（400 TARGET_NOT_KEY_POSITION），现任派生', async () => {
      const s = await successor();
      const view = await created(positionBody(s.id));
      expect(view.incumbents?.map((p) => p.employeeId)).toEqual([std.incumbent.id]);
      const plain = await w.position(std.orgA.id, '非关键岗', { isKey: false });
      const response = await post(positionBody(s.id, { targetPositionId: plain.id }));
      expect([response.status, (await errorOf(response)).details?.reason]).toEqual([400, 'TARGET_NOT_KEY_POSITION']);
    });

    it('历史补录：开始、结束都在过去，保存即“已结束”；列表默认不含，status=all 才含', async () => {
      const s = await successor();
      const view = await created(orgBody(s.id, { startDate: '2026-03-01', endDate: '2026-06-01', endReason: '补录' }));
      expect(view).toMatchObject({ status: 'ended', endDate: '2026-06-01', endReason: '补录' });
      const row = await rowOf(view.id);
      expect(String(row?.end_date)).toContain('2026-06-01');
      const active = await w.list(`?successorEmployeeId=${s.id}`);
      expect(active.items).toHaveLength(0);
      expect((await w.list(`?successorEmployeeId=${s.id}&status=all`)).items).toHaveLength(1);
    });

    it('日期校验：开始 / 结束晚于今天 400，结束早于开始 400（reason 区分）', async () => {
      const s = await successor();
      const reasons: [object, string][] = [
        [{ startDate: '2026-10-02' }, 'START_DATE_IN_FUTURE'],
        [{ endDate: '2026-10-02' }, 'END_DATE_IN_FUTURE'],
        [{ startDate: '2026-09-10', endDate: '2026-09-01' }, 'END_BEFORE_START'],
      ];
      for (const [extra, reason] of reasons) {
        const response = await post(orgBody(s.id, extra));
        expect([response.status, (await errorOf(response)).details?.reason], reason).toEqual([400, reason]);
      }
    });

    it('目标 / 继任者 / 准备度校验：目标不存在 404，继任者不存在 404，准备度停用 400，已离职继任者 400', async () => {
      const s = await successor();
      const missing = await post(orgBody(s.id, { targetOrgId: crypto.randomUUID() }));
      expect(missing.status).toBe(404);
      const ghost = await post(orgBody(crypto.randomUUID()));
      expect(ghost.status).toBe(404);
      const disabled = await w.readiness('已停用');
      const view = (await (await w.call('GET', `talent-review/readiness-levels/${disabled.id}`)).json()) as {
        revision: number;
      };
      await w.call('PATCH', `talent-review/readiness-levels/${disabled.id}`, {
        ifMatch: view.revision,
        body: { enabled: false },
      });
      const off = await post(orgBody(s.id, { readinessId: disabled.id }));
      expect([off.status, (await errorOf(off)).details?.reason]).toEqual([400, 'READINESS_DISABLED']);
      // 已离职：直接离职业务（最后工作日 2026-09-01，今天 2026-10-01 已是离职状态）
      const gone = await w.hire('离职继任者', {}, '2026-08-01');
      const detail = (await (await w.call('GET', `employment/employees/${gone.id}`)).json()) as { revision: number };
      const leave = await w.call('POST', `employment/employees/${gone.id}/businesses`, {
        ifMatch: detail.revision,
        body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-01', fields: {} },
      });
      expect(leave.status, await leave.clone().text()).toBe(201);
      const left = await post(orgBody(gone.id));
      expect([left.status, (await errorOf(left)).details?.reason]).toEqual([400, 'SUCCESSOR_NOT_ACTIVE']);
    });

    it('载荷：未登记的键 400，类型与目标不匹配 400，缺 Idempotency-Key 400', async () => {
      const s = await successor();
      expect((await post({ ...orgBody(s.id), endSource: 'exit' })).status).toBe(400);
      expect((await post({ ...orgBody(s.id), targetPositionId: std.keyPosition.id })).status).toBe(400);
      const noKey = await post(orgBody(s.id), { idempotencyKey: null });
      expect([noKey.status, (await errorOf(noKey)).code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    });

    it('区间不重叠：与当前生效记录重叠 → 409 SUCCESSION_DUPLICATE；只与历史重叠 → SUCCESSION_PERIOD_OVERLAP；不交叉的历史并存', async () => {
      const s = await successor();
      await created(orgBody(s.id, { startDate: '2026-09-01' }));
      const dup = await post(orgBody(s.id, { startDate: '2026-09-15' }));
      expect([dup.status, (await errorOf(dup)).details?.reason]).toEqual([409, 'SUCCESSION_DUPLICATE']);
      const t = await successor();
      await created(orgBody(t.id, { startDate: '2026-03-01', endDate: '2026-06-01' }));
      const overlap = await post(orgBody(t.id, { startDate: '2026-05-01', endDate: '2026-07-01' }));
      expect([overlap.status, (await errorOf(overlap)).details?.reason]).toEqual([409, 'SUCCESSION_PERIOD_OVERLAP']);
      await created(orgBody(t.id, { startDate: '2026-06-01', endDate: '2026-07-01' })); // 半开区间，首尾相接不重叠
      // 同一目标可有多名继任者
      const u = await successor();
      await created(orgBody(u.id));
    });

    it('幂等：同键同内容重放同一响应且只写一条；同键异内容 409 IDEMPOTENCY_CONFLICT', async () => {
      const s = await successor();
      const body = orgBody(s.id);
      const first = await post(body, { idempotencyKey: `sc-create-${s.id}` });
      const again = await post(body, { idempotencyKey: `sc-create-${s.id}` });
      expect([first.status, again.status]).toEqual([201, 201]);
      expect(((await again.json()) as RecordView).id).toBe(((await first.json()) as RecordView).id);
      expect((await w.list(`?successorEmployeeId=${s.id}`)).total).toBe(1);
      const conflict = await post({ ...body, backupType: 'deputy' }, { idempotencyKey: `sc-create-${s.id}` });
      expect([conflict.status, (await errorOf(conflict)).code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    });
  });

  describe('GET /successor-candidates（DEC-308）', () => {
    it('全租户关键词搜索：含待入职，≤ 30 条；返回 employeeId / name / email / status；q 为空 400', async () => {
      const found = await w.request('GET', '/successor-candidates?q=继任丙');
      expect(found.status, await found.clone().text()).toBe(200);
      const body = (await found.json()) as { items: { employeeId: string; name: string; email: string | null }[] };
      expect(body.items.map((item) => item.employeeId)).toContain(std.successor1.id);
      expect(Object.keys(body.items[0]!).sort()).toEqual(['email', 'employeeId', 'name', 'status']);
      expect((await w.request('GET', '/successor-candidates?q=')).status).toBe(400);
      expect((await w.request('GET', '/successor-candidates?q=a&limit=31')).status).toBe(400);
      const limited = await w.request('GET', '/successor-candidates?q=继任&limit=2');
      expect(((await limited.json()) as { items: unknown[] }).items.length).toBeLessThanOrEqual(2);
    });

    it('排除已离职人员；邮箱关键词也能搜到', async () => {
      const gone = await w.hire('候选离职者', {}, '2026-08-01');
      const detail = (await (await w.call('GET', `employment/employees/${gone.id}`)).json()) as { revision: number };
      await w.call('POST', `employment/employees/${gone.id}/businesses`, {
        ifMatch: detail.revision,
        body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-01', fields: {} },
      });
      const byName = await w.request('GET', '/successor-candidates?q=候选离职者');
      expect(((await byName.json()) as { items: unknown[] }).items).toHaveLength(0);
      const byEmail = await w.request('GET', `/successor-candidates?q=${encodeURIComponent(std.successor1.name)}`);
      expect(((await byEmail.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
    });
  });

  describe('PUT /records/:id 编辑', () => {
    it('白名单字段可改（准备度置空、后备类型、开始 / 结束时间、原因），revision +1，审计 update', async () => {
      const s = await successor();
      const view = await created(orgBody(s.id));
      const response = await w.request('PUT', `/records/${view.id}`, {
        ifMatch: view.revision,
        body: { readinessId: null, backupType: 'deputy', startDate: '2026-08-15' },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const updated = (await response.json()) as RecordView;
      expect(updated).toMatchObject({ readinessId: null, backupType: 'deputy', startDate: '2026-08-15', revision: 2 });
      expect(response.headers.get('etag')).toBe('"2"');
      expect(await audits(view.id, 'succession.record.update')).toBe(1);
    });

    it('目标与继任者不可改（400 FIELD_IMMUTABLE）；未知键 400；缺 If-Match 400；revision 过期 409', async () => {
      const s = await successor();
      const view = await created(orgBody(s.id));
      for (const body of [{ targetOrgId: std.orgB.id }, { successorEmployeeId: std.successor1.id }]) {
        const response = await w.request('PUT', `/records/${view.id}`, { ifMatch: 1, body });
        expect([response.status, (await errorOf(response)).details?.reason]).toEqual([400, 'FIELD_IMMUTABLE']);
      }
      expect((await w.request('PUT', `/records/${view.id}`, { ifMatch: 1, body: { endSource: 'exit' } })).status).toBe(
        400,
      );
      expect((await w.request('PUT', `/records/${view.id}`, { body: { backupType: 'deputy' } })).status).toBe(400);
      const stale = await w.request('PUT', `/records/${view.id}`, { ifMatch: 7, body: { backupType: 'deputy' } });
      expect([stale.status, (await errorOf(stale)).code]).toEqual([409, 'REVISION_CONFLICT']);
    });

    it('结束再恢复：endDate 置空 = 恢复生效；恢复同样查重（与另一条当前生效重叠 → SUCCESSION_DUPLICATE）', async () => {
      const s = await successor();
      const first = await created(orgBody(s.id, { startDate: '2026-08-01' }));
      const ended = await w.request('PUT', `/records/${first.id}`, {
        ifMatch: 1,
        body: { endDate: '2026-09-10', endReason: '调整' },
      });
      expect(((await ended.json()) as RecordView).status).toBe('ended');
      expect(await rowOf(first.id)).toMatchObject({ end_source: 'manual' });
      await created(orgBody(s.id, { startDate: '2026-09-20' }));
      const blocked = await w.request('PUT', `/records/${first.id}`, { ifMatch: 2, body: { endDate: null } });
      expect([blocked.status, (await errorOf(blocked)).details?.reason]).toEqual([409, 'SUCCESSION_DUPLICATE']);
      const t = await successor();
      const only = await created(orgBody(t.id, { startDate: '2026-08-01', endDate: '2026-09-10' }));
      const restored = await w.request('PUT', `/records/${only.id}`, { ifMatch: 1, body: { endDate: null } });
      expect((await restored.json()) as RecordView).toMatchObject({ status: 'active', endDate: null, endReason: null });
      expect(String((await rowOf(only.id))?.end_date)).toContain(OPEN_END);
    });

    it('编辑日期同样校验：结束晚于今天 400；结束早于开始 400；已删除的记录 404', async () => {
      const s = await successor();
      const view = await created(orgBody(s.id));
      const future = await w.request('PUT', `/records/${view.id}`, { ifMatch: 1, body: { endDate: '2026-10-05' } });
      expect([future.status, (await errorOf(future)).details?.reason]).toEqual([400, 'END_DATE_IN_FUTURE']);
      const before = await w.request('PUT', `/records/${view.id}`, { ifMatch: 1, body: { endDate: '2026-08-01' } });
      expect([before.status, (await errorOf(before)).details?.reason]).toEqual([400, 'END_BEFORE_START']);
      const gone = await w.request('DELETE', `/records/${view.id}`, { ifMatch: 1 });
      expect(gone.status).toBe(200);
      expect(
        (await w.request('PUT', `/records/${view.id}`, { ifMatch: 1, body: { backupType: 'deputy' } })).status,
      ).toBe(404);
    });
  });

  describe('POST /records/end 批量结束', () => {
    it('整批原子：全部结束（end_source = manual、原因写入），回执按记录；revision +1', async () => {
      const [a, b] = [await successor(), await successor()];
      const [ra, rb] = [await created(orgBody(a.id)), await created(positionBody(b.id))];
      const response = await w.request('POST', '/records/end', {
        body: {
          items: [
            { id: ra.id, expectedRevision: 1 },
            { id: rb.id, expectedRevision: 1 },
          ],
          endDate: '2026-09-30',
          endReason: '岗位调整',
        },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as { items: RecordView[] };
      expect(body.items.map((item) => [item.id, item.status, item.endDate, item.revision])).toEqual(
        [ra.id, rb.id].map((id) => [id, 'ended', '2026-09-30', 2]),
      );
      expect(await rowOf(ra.id)).toMatchObject({ end_source: 'manual', end_reason: '岗位调整' });
      expect(await audits(ra.id, 'succession.record.update')).toBe(1);
    });

    it('逐条校验且整批回滚：ALREADY_ENDED / END_BEFORE_START / REVISION_CONFLICT 列出 ID，不留半批', async () => {
      const [a, b, c] = [await successor(), await successor(), await successor()];
      const ra = await created(orgBody(a.id, { startDate: '2026-09-20' }));
      const rb = await created(orgBody(b.id, { startDate: '2026-08-01', endDate: '2026-09-01' }));
      const rc = await created(orgBody(c.id));
      const run = (items: object[], endDate = '2026-09-25') =>
        w.request('POST', '/records/end', { body: { items, endDate } });
      const already = await run([
        { id: rc.id, expectedRevision: 1 },
        { id: rb.id, expectedRevision: 1 },
      ]);
      const alreadyError = await errorOf(already);
      expect([already.status, alreadyError.details?.reason]).toEqual([409, 'ALREADY_ENDED']);
      expect(JSON.stringify(alreadyError.details)).toContain(rb.id);
      const early = await run([{ id: ra.id, expectedRevision: 1 }], '2026-09-10');
      const earlyError = await errorOf(early);
      expect([early.status, earlyError.details?.reason]).toEqual([400, 'END_BEFORE_START']);
      expect(JSON.stringify(earlyError.details)).toContain(ra.id);
      const stale = await run([
        { id: rc.id, expectedRevision: 1 },
        { id: ra.id, expectedRevision: 9 },
      ]);
      const staleError = await errorOf(stale);
      expect([stale.status, staleError.code]).toEqual([409, 'REVISION_CONFLICT']);
      expect(JSON.stringify(staleError.details)).toContain(ra.id);
      expect((await rowOf(rc.id))?.revision).toBe(1); // 整批回滚：rc 没被结束
    });

    it('晚于今天 400；批量上限 200（201 条 400）；不存在 / 已删除的记录整批 404', async () => {
      const s = await successor();
      const view = await created(orgBody(s.id));
      const future = await w.request('POST', '/records/end', {
        body: { items: [{ id: view.id, expectedRevision: 1 }], endDate: '2026-10-02' },
      });
      expect([future.status, (await errorOf(future)).details?.reason]).toEqual([400, 'END_DATE_IN_FUTURE']);
      const items = Array.from({ length: 201 }, () => ({ id: crypto.randomUUID(), expectedRevision: 1 }));
      expect((await w.request('POST', '/records/end', { body: { items, endDate: '2026-09-30' } })).status).toBe(400);
      const missing = await w.request('POST', '/records/end', {
        body: {
          items: [
            { id: view.id, expectedRevision: 1 },
            { id: crypto.randomUUID(), expectedRevision: 1 },
          ],
          endDate: '2026-09-30',
        },
      });
      expect(missing.status).toBe(404);
      expect(String((await rowOf(view.id))?.end_date)).toContain(OPEN_END);
    });

    it('同键重放返回原回执；同键异内容 409', async () => {
      const s = await successor();
      const view = await created(orgBody(s.id));
      const body = { items: [{ id: view.id, expectedRevision: 1 }], endDate: '2026-09-30' };
      const key = `sc-end-${s.id}`;
      const first = await w.request('POST', '/records/end', { body, idempotencyKey: key });
      const again = await w.request('POST', '/records/end', { body, idempotencyKey: key });
      expect([first.status, again.status]).toEqual([200, 200]);
      expect(await again.json()).toEqual(await first.json());
      const other = await w.request('POST', '/records/end', {
        body: { ...body, endDate: '2026-09-29' },
        idempotencyKey: key,
      });
      expect(other.status).toBe(409);
    });
  });

  describe('DELETE /records/:id 软删除', () => {
    it('软删除：回执 { id, deleted }、审计整条快照；之后详情 / 列表 / 重复删除都是 404；同键重放返回原回执', async () => {
      const s = await successor();
      const view = await created(orgBody(s.id));
      const key = `sc-del-${s.id}`;
      const deleted = await w.request('DELETE', `/records/${view.id}`, { ifMatch: 1, idempotencyKey: key });
      expect(deleted.status, await deleted.clone().text()).toBe(200);
      expect(await deleted.json()).toMatchObject({ id: view.id, deleted: true });
      expect(await audits(view.id, 'succession.record.delete')).toBe(1);
      expect((await w.request('GET', `/records/${view.id}`)).status).toBe(404);
      expect((await w.list(`?successorEmployeeId=${s.id}&status=all`)).items).toHaveLength(0);
      expect((await w.request('DELETE', `/records/${view.id}`, { ifMatch: 1 })).status).toBe(404);
      const replay = await w.request('DELETE', `/records/${view.id}`, { ifMatch: 1, idempotencyKey: key });
      expect([replay.status, await replay.json()]).toEqual([200, expect.objectContaining({ id: view.id })]);
    });

    it('已删除的区间不参与查重：删除后同一继任者可以重新新增同区间', async () => {
      const s = await successor();
      const view = await created(orgBody(s.id));
      await w.request('DELETE', `/records/${view.id}`, { ifMatch: 1 });
      await created(orgBody(s.id));
    });

    it('缺 If-Match 400；revision 过期 409；已结束的记录也能删', async () => {
      const s = await successor();
      const view = await created(orgBody(s.id, { startDate: '2026-08-01', endDate: '2026-09-01' }));
      expect((await w.request('DELETE', `/records/${view.id}`)).status).toBe(400);
      expect((await w.request('DELETE', `/records/${view.id}`, { ifMatch: 5 })).status).toBe(409);
      expect((await w.request('DELETE', `/records/${view.id}`, { ifMatch: 1 })).status).toBe(200);
    });
  });

  describe('计划屏障判定点（sync-barrier.ts，本 PR 恒为无屏障，D1 接入）', () => {
    it('登记屏障后，新增 / 编辑 / 结束 / 删除都得到 409 TARGET_SYNC_IN_PROGRESS，且不写任何行', async () => {
      const s = await successor();
      const view = await created(orgBody(s.id));
      setSyncBarrier(async () => true);
      const attempts = [
        post(orgBody((await successor()).id)),
        w.request('PUT', `/records/${view.id}`, { ifMatch: 1, body: { backupType: 'deputy' } }),
        w.request('POST', '/records/end', {
          body: { items: [{ id: view.id, expectedRevision: 1 }], endDate: '2026-09-30' },
        }),
        w.request('DELETE', `/records/${view.id}`, { ifMatch: 1 }),
      ];
      for (const response of await Promise.all(attempts)) {
        expect([response.status, (await errorOf(response)).details?.reason]).toEqual([409, 'TARGET_SYNC_IN_PROGRESS']);
      }
      expect(await rowOf(view.id)).toMatchObject({ revision: 1, backup_type: 'principal' });
      setSyncBarrier(undefined);
      expect((await w.request('DELETE', `/records/${view.id}`, { ifMatch: 1 })).status).toBe(200);
    });
  });
});

void SC_TODAY;
