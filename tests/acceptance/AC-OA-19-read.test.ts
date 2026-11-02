/**
 * R2-T08 BE-10d：AC-OA-19 列表三项筛选、明细分区与列、空分区不返回（设计 §10、§9.3 路由 12～14）。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { expectError } from './AC-OA-head-support.js';
import { itemsWorld, newOrg, rename, stop } from './AC-OA-items-support.js';
import { orgName, reader, setItemResult } from './AC-OA-read-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

describe('AC-OA-19 列表：三项筛选、列与分页（路由 12）', () => {
  it('按审批主体组织 / 生效日期区间 / 审批状态筛选，默认按创建时间倒序，总数与筛选一致', async () => {
    const w = await itemsWorld(testDb().db, 'oa19');
    const r = reader(w);
    const other = await w.org(`主体二${uniqueSuffix()}`);
    w.setNow('2026-10-01T01:00:00.000Z');
    const first = await w.created(w.head({ effectiveDate: '2026-11-01' }));
    w.setNow('2026-10-02T01:00:00.000Z');
    const second = await w.created(w.head({ effectiveDate: '2026-12-01', approvalSubjectOrgId: other }));
    w.setNow('2026-10-03T01:00:00.000Z');
    const third = await w.created(w.head({ effectiveDate: '2027-01-01' }));
    await w.setStatus(third.id, 1);

    const all = await r.list();
    expect(all.items.map((row) => row.id)).toEqual([third.id, second.id, first.id]);
    expect(all).toMatchObject({ total: 3, page: 1, pageSize: 50 });

    const bySubject = await r.list(`approvalSubjectOrgId=${other}`);
    expect(bySubject.items.map((row) => row.id)).toEqual([second.id]);
    expect(bySubject.total).toBe(1);

    const byDate = await r.list('effectiveFrom=2026-11-15&effectiveTo=2027-01-01');
    expect(byDate.items.map((row) => row.id)).toEqual([third.id, second.id]);

    const reviewing = await r.list('approvalStatus=reviewing');
    expect(reviewing.items.map((row) => row.id)).toEqual([third.id]);
    // 草稿 / 已暂存都对应审批状态 0（DEC-526④）
    expect((await r.list('approvalStatus=draft')).total).toBe(2);
    expect((await r.list('approvalStatus=staged')).total).toBe(2);

    const paged = await r.list('page=2&pageSize=2');
    expect(paged).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(paged.items.map((row) => row.id)).toEqual([first.id]);

    await expectError(await r.listRes('approvalStatus=unknown'), 400, 'VALIDATION_FAILED');
    await expectError(await r.listRes('effectiveFrom=2026-13-01'), 400, 'VALIDATION_FAILED');
    await expectError(await r.listRes('approvalSubjectOrgId=not-a-uuid'), 400, 'VALIDATION_FAILED');
  });

  it('列：编号、主题、生效日期、主体组织名、调整范围、状态文案、执行备注、申请人、创建时间', async () => {
    const w = await itemsWorld(testDb().db, 'oa19');
    const r = reader(w);
    w.setNow('2026-10-05T02:00:00.000Z');
    const view = await w.created(w.head({ adjustmentRange: [w.a, w.b] }));
    const [row] = (await r.list()).items;
    const [subjectName, aName, bName] = [await orgName(w, w.subject), await orgName(w, w.a), await orgName(w, w.b)];
    expect(row).toEqual({
      id: view.id,
      code: view.code,
      subject: view.subject,
      effectiveDate: '2026-11-01',
      approvalSubjectOrgId: w.subject,
      approvalSubjectOrgName: subjectName,
      adjustmentRange: [
        { orgId: w.a, name: aName, label: `${aName}（包含下级）` },
        { orgId: w.b, name: bName, label: `${bName}（包含下级）` },
      ],
      approvalStatus: 0,
      approvalStatusLabel: '已暂存',
      executionStatus: 1,
      executionStatusLabel: '未执行',
      executionNote: null,
      createdBy: w.hr.id,
      createdByName: expect.any(String),
      createdAt: '2026-10-05T02:00:00.000Z',
    });
    expect(row!.createdByName).not.toBe('');
  });
});

describe('AC-OA-19 详情与明细分区（路由 13 / 14）', () => {
  it('详情：头 + 审批实例 ID + 各分区行数；没有明细时分区不返回', async () => {
    const w = await itemsWorld(testDb().db, 'oa19');
    const r = reader(w);
    const empty = await w.created(w.head());
    const emptyDetail = await r.detail(empty.id);
    expect(emptyDetail).toMatchObject({
      id: empty.id,
      code: empty.code,
      subject: empty.subject,
      content: '调整说明',
      effectiveDate: '2026-11-01',
      approvalSubjectOrgId: w.subject,
      approvalSubjectOrgName: await orgName(w, w.subject),
      approvalStatus: 0,
      approvalStatusLabel: '已暂存',
      executionStatus: 1,
      revision: 1,
      approvalInstanceId: null,
    });
    expect(emptyDetail.sections).toEqual({});

    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    await w.item(view.id, newOrg(w.a));
    await w.item(view.id, newOrg(w.a, { isStaged: true }));
    const detail = await r.detail(view.id);
    expect(detail.sections).toEqual({ org: { count: 2, hiddenRowCount: 0 } });
  });

  it('明细列：新建 = 名称 / 编码 / 简称；变更 = 组织 / 原上级（基线）/ 新上级；停用 = 是否分批 / 转移至（转移随 11d 开放）', async () => {
    const w = await itemsWorld(testDb().db, 'oa19');
    const r = reader(w);
    const c = await w.org(`丙${uniqueSuffix()}`, w.a);
    const view = await w.created(w.head({ adjustmentRange: [w.a, w.b] }));
    const created = await w.item(view.id, newOrg(w.a, { code: `C${uniqueSuffix()}`, shortName: '简称' }));
    const moved = await w.item(view.id, rename(w.b, { name: undefined, parent: { orgId: w.a } }));
    const stopped = await w.item(view.id, stop(c));
    const staged = await w.item(view.id, newOrg(w.a, { isStaged: true }));
    const [createId, moveId, stopId, stagedId] = [created, moved, stopped, staged].map((v) => v.items.at(-1)!.id);
    await setItemResult(w, createId!, 2, 'BASELINE_CHANGED');

    const body = await r.items(view.id);
    expect(body).toMatchObject({ adjustmentId: view.id, section: 'org', hiddenRowCount: 0 });
    const byId = new Map(body.items.map((item) => [item.id, item]));
    expect(body.items.map((item) => item.id)).toEqual([createId, moveId, stopId, stagedId]);

    expect(byId.get(createId!)).toMatchObject({
      adjustType: 1,
      adjustTypeLabel: '新建',
      name: created.items.at(-1)!.name,
      code: created.items.at(-1)!.code,
      shortName: '简称',
      parentOrgId: w.a,
      parentOrgName: await orgName(w, w.a),
      isStaged: false,
      stagedLabel: null,
      executionResult: 2,
      executionResultLabel: '失败',
      executionReason: 'BASELINE_CHANGED',
      executionMessage: '合成失败说明',
    });
    expect(byId.get(moveId!)).toMatchObject({
      adjustType: 2,
      adjustTypeLabel: '变更',
      targetOrgId: w.b,
      targetOrgName: await orgName(w, w.b),
      originalParentOrgId: w.tenant.id,
      originalParentOrgName: await orgName(w, w.tenant.id),
      parentOrgId: w.a,
      parentOrgName: await orgName(w, w.a),
      executionResult: null,
      executionResultLabel: null,
    });
    expect(byId.get(stopId!)).toMatchObject({
      adjustType: 3,
      adjustTypeLabel: '停用',
      targetOrgId: c,
      targetOrgName: await orgName(w, c),
      transferToOrgId: null,
      transferToOrgName: null,
    });
    expect(byId.get(stopId!)).toHaveProperty('batchTransfer');
    expect(byId.get(stagedId!)).toMatchObject({ isStaged: true, stagedLabel: '暂存（未执行）' });
  });

  it('只有组织分区：其它分区、未知分区一律 404；不存在的申请单 404', async () => {
    const w = await itemsWorld(testDb().db, 'oa19');
    const r = reader(w);
    const view = await w.created(w.head());
    for (const section of ['transfer', 'position', 'establishment', 'partTime', 'nope']) {
      await expectError(await r.itemsRes(view.id, section), 404, 'NOT_FOUND');
    }
    await expectError(await r.detailRes(randomUUID()), 404, 'NOT_FOUND');
    await expectError(await r.itemsRes(randomUUID()), 404, 'NOT_FOUND');
  });
});
