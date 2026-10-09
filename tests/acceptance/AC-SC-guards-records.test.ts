/**
 * AC-SC-guards（R3-T05 A1 读侧，设计 §8.2 G-1 / G-2 / V-1 / V-4；DEC-043 / 080 / 121 / 311③）：真实授权器下
 * 准备度选择器与继任记录列表 / 详情——无对象查看权 403；数据范围缺省为空；管理单元内外（职位继任按所属组织）；
 * 字段裁剪（键缺席）与按隐藏字段筛选 403；范围外的嵌套人员照常显示姓名(邮箱)。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorCode } from './support/tenant-api.js';
import { permissionWorldOf, recordOperator } from './AC-SC-permission-support.js';
import { labelOf, type RecordList, type RecordView, type SuccessionWorld, successionWorld } from './AC-SC-support.js';
import type { PermissionWorld } from './AC-PRM-support.js';

const testDb = useTestDb();

describe('AC-SC-guards 继任记录读侧权限（真实授权器）', () => {
  let w: SuccessionWorld;
  let world: PermissionWorld;
  let std: Awaited<ReturnType<SuccessionWorld['standard']>>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    w = await successionWorld(testDb().db, 'sc-guards');
    std = await w.standard();
    world = await permissionWorldOf(w);
    ids.inOrg = await w.insertRecord({
      type: 'org',
      targetId: std.orgA.id,
      successorId: std.successor1.id,
      endReason: null,
    });
    ids.outOrg = await w.insertRecord({ type: 'org', targetId: std.orgB.id, successorId: std.successor2.id });
    // 职位 P 属于 orgA：按职位所属组织判范围
    ids.inPosition = await w.insertRecord({
      type: 'position',
      targetId: std.keyPosition.id,
      successorId: std.successor2.id,
    });
    const outPosition = await w.position(std.orgB.id, 'B部关键岗');
    ids.outPosition = await w.insertRecord({
      type: 'position',
      targetId: outPosition.id,
      successorId: std.successor1.id,
    });
  });

  it('没有 Succession.Record 查看权：准备度、列表、详情都是 403 FORBIDDEN', async () => {
    const operator = await recordOperator(world, { view: false, seeAll: true });
    for (const path of ['/readiness', '/records', `/records/${ids.inOrg}`]) {
      const response = await operator.request('GET', path);
      expect([response.status, await errorCode(response)], path).toEqual([403, 'FORBIDDEN']);
    }
  });

  it('有查看权、数据范围缺省为空：列表为空且 hasDataPermission = false，详情 404；准备度选择器不受范围影响', async () => {
    const operator = await recordOperator(world);
    const list = await operator.request('GET', '/records?status=all');
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: [], total: 0, hasDataPermission: false });
    const detail = await operator.request('GET', `/records/${ids.inOrg}`);
    expect([detail.status, await errorCode(detail)]).toEqual([404, 'NOT_FOUND']);
    expect((await operator.request('GET', '/readiness')).status).toBe(200);
  });

  it('管理单元范围：只含 A 部——A 部的组织继任与 A 部职位的职位继任可见，B 部的不在列表且详情 404', async () => {
    const operator = await recordOperator(world, { orgIds: [std.orgA.id] });
    const list = (await (await operator.request('GET', '/records?status=all')).json()) as RecordList;
    expect(list.items.map((item) => item.id).sort()).toEqual([ids.inOrg, ids.inPosition].sort());
    expect(list.total).toBe(2);
    expect(list.hasDataPermission).toBe(true);
    for (const id of [ids.outOrg, ids.outPosition]) {
      const detail = await operator.request('GET', `/records/${id}`);
      expect([detail.status, await errorCode(detail)], id).toEqual([404, 'NOT_FOUND']);
    }
    const visible = await operator.request('GET', `/records/${ids.inPosition}`);
    expect(visible.status).toBe(200);
    // 按范围外目标筛选：不泄露存在性，返回空
    const filtered = (await (
      await operator.request('GET', `/records?targetOrgId=${std.orgB.id}`)
    ).json()) as RecordList;
    expect(filtered.items).toEqual([]);
    expect(filtered.total).toBe(0);
  });

  it('看全部：四条都可见；范围外的人员（继任者在 B 部）嵌套姓名(邮箱)照常显示（DEC-311③）', async () => {
    const operator = await recordOperator(world, { seeAll: true });
    const list = (await (await operator.request('GET', '/records?status=all')).json()) as RecordList;
    expect(list.items).toHaveLength(4);
    const scoped = await recordOperator(world, { orgIds: [std.orgA.id] });
    const viaScope = (await (await scoped.request('GET', `/records/${ids.inOrg}`)).json()) as RecordView;
    // 继任者 successor1 任职于 B 部（不在该管理单元范围内），姓名与邮箱照原站显示
    expect(viaScope.successor?.label).toBe(labelOf(std.successor1));
  });

  it('字段裁剪：隐藏 endReason / readinessId / incumbents 后列表与详情都没有这些键，其余键值不变', async () => {
    const operator = await recordOperator(world, {
      seeAll: true,
      hidden: ['endReason', 'readinessId', 'incumbents'],
    });
    const list = (await (await operator.request('GET', '/records?status=all')).json()) as RecordList;
    for (const item of list.items) {
      expect('endReason' in item, item.id).toBe(false);
      expect('readinessId' in item, item.id).toBe(false);
      expect('readiness' in item, item.id).toBe(false);
      expect('incumbents' in item, item.id).toBe(false);
      expect(item.successorEmployeeId).toBeTruthy();
    }
    const detail = (await (await operator.request('GET', `/records/${ids.inPosition}`)).json()) as RecordView;
    expect(['endReason', 'readinessId', 'incumbents'].filter((key) => key in detail)).toEqual([]);
    expect(detail.startDate).toBe('2026-09-01');
  });

  it('按不可见字段筛选 403 FILTER_FIELD_HIDDEN：不能借筛选结果还原被裁掉的字段', async () => {
    const operator = await recordOperator(world, { seeAll: true, hidden: ['targetOrgId', 'successorEmployeeId'] });
    for (const query of [`targetOrgId=${std.orgA.id}`, `successorEmployeeId=${std.successor1.id}`]) {
      const response = await operator.request('GET', `/records?${query}`);
      expect([response.status, await errorCode(response)], query).toEqual([403, 'FORBIDDEN']);
    }
    const allowed = await operator.request('GET', '/records?successionType=org');
    expect(allowed.status).toBe(200);
  });
});
