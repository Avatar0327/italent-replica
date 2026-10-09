/**
 * AC-SC-01（R3-T05 A1，设计 §2.2 #1 / #2、§5.1、§5.8、§8.4；DEC-343③ / DEC-311③ / DEC-194）：
 * 准备度选择器、继任记录列表与详情——默认只列当前生效、可切已结束 / 全部；asOf 时点；筛选与分页；
 * 嵌套人员“姓名(邮箱)”照原站；现任 / 负责人按 asOf 从任职与组织版本派生；已删除一律不返回。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  labelOf,
  OPEN_END,
  type ReadinessSeed,
  type RecordView,
  SC_TODAY,
  type SuccessionWorld,
  successionWorld,
} from './AC-SC-support.js';

const testDb = useTestDb();
const errorOf = (body: unknown) => (body as { error: { code: string; details?: { reason?: string } } }).error;

describe('AC-SC-01 继任记录读侧（设计 §2.2 #1 / #2）', () => {
  let w: SuccessionWorld;
  let std: Awaited<ReturnType<SuccessionWorld['standard']>>;
  let level: ReadinessSeed;
  const ids = {} as Record<'orgActive' | 'orgEnded' | 'orgDeleted' | 'posActive', string>;

  beforeAll(async () => {
    w = await successionWorld(testDb().db, 'sc-read');
    std = await w.standard();
    level = await w.readiness('可接任');
    await w.readiness('已停用级', {}).then(async (disabled) => {
      const detail = await w.call('GET', `talent-review/readiness-levels/${disabled.id}`);
      const view = (await detail.json()) as { revision: number };
      const response = await w.call('PATCH', `talent-review/readiness-levels/${disabled.id}`, {
        ifMatch: view.revision,
        body: { enabled: false },
      });
      expect(response.status, await response.clone().text()).toBe(200);
    });
    // 组织继任：当前生效 / 已结束 / 已删除 / 未来才开始（asOf 之后）
    ids.orgActive = await w.insertRecord({
      type: 'org',
      targetId: std.orgA.id,
      successorId: std.successor1.id,
      readinessId: level.id,
      backupType: 'deputy',
      startDate: '2026-08-01',
    });
    ids.orgEnded = await w.insertRecord({
      type: 'org',
      targetId: std.orgA.id,
      successorId: std.successor2.id,
      startDate: '2026-06-01',
      endDate: '2026-09-15',
      endReason: '岗位调整',
      endSource: 'manual',
    });
    ids.orgDeleted = await w.insertRecord({
      type: 'org',
      targetId: std.orgA.id,
      successorId: std.incumbent.id,
      startDate: '2026-05-01',
      deleted: true,
    });
    // 职位继任
    ids.posActive = await w.insertRecord({
      type: 'position',
      targetId: std.keyPosition.id,
      successorId: std.successor1.id,
      startDate: '2026-09-20',
    });
  });

  const get = async (path: string) => {
    const response = await w.request('GET', path);
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, response };
  };

  describe('GET /readiness', () => {
    it('只返回启用的准备度，键固定为 id / code / name / color / sort', async () => {
      const { status, body } = await get('/readiness');
      expect(status).toBe(200);
      const items = (body as { items: Record<string, unknown>[] }).items;
      expect(items.map((item) => item.name)).toEqual(['可接任']);
      expect(Object.keys(items[0]!).sort()).toEqual(['code', 'color', 'id', 'name', 'sort']);
      expect(items[0]).toMatchObject({ id: level.id, code: level.code, color: '#3366FF' });
    });
  });

  describe('GET /records 列表', () => {
    it('缺省 status=active 只返回当前生效（DEC-343③）；已结束、已删除不在其中', async () => {
      const result = await w.list();
      expect(result.asOf).toBe(SC_TODAY);
      expect(result.total).toBe(2);
      expect(result.items.map((item) => item.id).sort()).toEqual([ids.orgActive, ids.posActive].sort());
      expect(result.items.every((item) => item.status === 'active')).toBe(true);
    });

    it('status=ended 只返回已结束；status=all 含生效与已结束，仍不含已删除；非法 status 400', async () => {
      expect((await w.list('?status=ended')).items.map((item) => item.id)).toEqual([ids.orgEnded]);
      const all = await w.list('?status=all');
      expect(all.items.map((item) => item.id).sort()).toEqual([ids.orgActive, ids.orgEnded, ids.posActive].sort());
      expect(all.items.map((item) => item.id)).not.toContain(ids.orgDeleted);
      const bad = await get('/records?status=whatever');
      expect([bad.status, (bad.body as { error: { code: string } }).error.code]).toEqual([400, 'VALIDATION_FAILED']);
    });

    it('记录字段：结束日 9999-12-31 对外为 null；已结束带原因与结束来源；来源与后备类型', async () => {
      const all = await w.list('?status=all');
      const byId = new Map(all.items.map((item) => [item.id, item]));
      expect(byId.get(ids.orgActive)).toMatchObject({
        successionType: 'org',
        targetOrgId: std.orgA.id,
        targetPositionId: null,
        successorEmployeeId: std.successor1.id,
        readinessId: level.id,
        backupType: 'deputy',
        startDate: '2026-08-01',
        endDate: null,
        endReason: null,
        sourceKind: 'manual',
        status: 'active',
        revision: 1,
      });
      expect(byId.get(ids.orgEnded)).toMatchObject({
        endDate: '2026-09-15',
        endReason: '岗位调整',
        endSource: 'manual',
        status: 'ended',
      });
      expect(byId.get(ids.posActive)).toMatchObject({
        successionType: 'position',
        targetOrgId: null,
        targetPositionId: std.keyPosition.id,
      });
    });

    it('嵌套人员照原站显示“姓名(邮箱)”；目标、准备度带名称', async () => {
      const all = await w.list('?status=all');
      const byId = new Map(all.items.map((item) => [item.id, item]));
      const orgActive = byId.get(ids.orgActive)!;
      expect(orgActive.successor).toMatchObject({
        employeeId: std.successor1.id,
        name: std.successor1.name,
        label: labelOf(std.successor1),
      });
      expect(orgActive.targetOrg).toEqual({ id: std.orgA.id, name: '继任A部' });
      expect(orgActive.readiness).toEqual({ id: level.id, code: level.code, name: '可接任', color: '#3366FF' });
      expect(byId.get(ids.orgEnded)!.readiness).toBeNull();
      expect(byId.get(ids.posActive)!.targetPosition).toEqual({
        id: std.keyPosition.id,
        name: '关键岗位P',
        orgId: std.orgA.id,
      });
    });

    it('现任 / 负责人按 asOf 派生：组织继任带负责人，职位继任带现任人员', async () => {
      const all = await w.list('?status=all');
      const byId = new Map(all.items.map((item) => [item.id, item]));
      const org = byId.get(ids.orgActive)!;
      expect(org.personInCharge).toMatchObject({ employeeId: std.head.id, label: labelOf(std.head) });
      expect('incumbents' in org).toBe(false);
      const position = byId.get(ids.posActive)!;
      expect(position.incumbents?.map((person) => person.employeeId)).toEqual([std.incumbent.id]);
      expect(position.incumbents![0]!.label).toBe(labelOf(std.incumbent));
      expect('personInCharge' in position).toBe(false);
    });

    it('asOf 时点（§5.8）：已结束记录在结束日之前仍是生效；开始日之前不存在；asOf 晚于今天 400', async () => {
      const past = await w.list('?asOf=2026-09-01');
      expect(past.asOf).toBe('2026-09-01');
      // 9-01：orgActive（8-01 起）与 orgEnded（6-01～9-15）生效，posActive（9-20 起）还不存在
      expect(past.items.map((item) => item.id).sort()).toEqual([ids.orgActive, ids.orgEnded].sort());
      const before = await w.list('?asOf=2026-07-01&status=all');
      expect(before.items.map((item) => item.id)).toEqual([ids.orgEnded]);
      const future = await get('/records?asOf=2026-10-02');
      expect([future.status, errorOf(future.body).code, errorOf(future.body).details?.reason]).toEqual([
        400,
        'VALIDATION_FAILED',
        'AS_OF_IN_FUTURE',
      ]);
      const malformed = await get('/records?asOf=2026-13-40');
      expect(malformed.status).toBe(400);
    });

    it('筛选：类型 / 目标组织 / 目标职位 / 继任者；UUID 大写按小写规范化，非法 UUID 400（DEC-194）', async () => {
      expect((await w.list('?successionType=position')).items.map((item) => item.id)).toEqual([ids.posActive]);
      expect((await w.list(`?targetOrgId=${std.orgA.id.toUpperCase()}`)).items.map((item) => item.id)).toEqual([
        ids.orgActive,
      ]);
      expect((await w.list(`?targetPositionId=${std.keyPosition.id}&status=all`)).items).toHaveLength(1);
      expect(
        (await w.list(`?successorEmployeeId=${std.successor2.id}&status=all`)).items.map((item) => item.id),
      ).toEqual([ids.orgEnded]);
      expect((await get('/records?targetOrgId=not-a-uuid')).status).toBe(400);
      expect((await get('/records?successionType=team')).status).toBe(400);
    });

    it('分页：total 是筛选后的总数，page / pageSize 切片稳定；超界 pageSize 400', async () => {
      const first = await w.list('?status=all&pageSize=2&page=1');
      const second = await w.list('?status=all&pageSize=2&page=2');
      expect([first.total, first.items.length, second.items.length]).toEqual([3, 2, 1]);
      expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
      expect((await get('/records?pageSize=201')).status).toBe(400);
    });
  });

  describe('GET /records/:id 详情', () => {
    it('返回单条（与列表同一投影），带 ETag；已结束的记录也可读', async () => {
      const { status, body, response } = await get(`/records/${ids.orgEnded}`);
      expect(status).toBe(200);
      expect(response.headers.get('etag')).toBe('"1"');
      const view = body as unknown as RecordView;
      expect(view).toMatchObject({ id: ids.orgEnded, status: 'ended', endDate: '2026-09-15', endReason: '岗位调整' });
      expect(view.successor?.label).toBe(labelOf(std.successor2));
      expect(view.personInCharge?.employeeId).toBe(std.head.id);
    });

    it('已删除、不存在、开始日晚于 asOf 的记录 404（NOT_FOUND）；非法或大写 ID 按规范处理', async () => {
      for (const id of [ids.orgDeleted, '00000000-0000-4000-8000-000000000009']) {
        const { status, body } = await get(`/records/${id}`);
        expect([status, (body as { error: { code: string } }).error.code]).toEqual([404, 'NOT_FOUND']);
      }
      expect((await get(`/records/${ids.posActive}?asOf=2026-09-01`)).status).toBe(404);
      expect((await get('/records/abc')).status).toBe(400);
      expect((await get(`/records/${ids.orgActive.toUpperCase()}`)).status).toBe(200);
    });

    it('现任按 asOf 解析：asOf 在入职之前现任为空', async () => {
      const early = await get(`/records/${ids.orgEnded}?asOf=2026-09-01`);
      expect(early.status).toBe(200);
      // 负责人 2026-10-01 才设置、其任职 2026-10-01 才开始：asOf=9-01 时组织版本不存在 → null
      expect((early.body as unknown as RecordView).personInCharge).toBeNull();
      expect(OPEN_END).toBe('9999-12-31');
    });
  });
});
