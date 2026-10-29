/** F255A / DEC-673：机构存值、申请来源与字段权限，全部合成数据。 */
import { randomUUID } from 'node:crypto';
import { eq, orgHierarchyLinks, orgVersions, sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { restricted } from './AC-PT-http-support.js';
import { viewsWorld, type ViewsWorld } from './AC-PT-views-support.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';

const database = useTestDb();
const world = (label: string) => viewsWorld(database().db, `f255a-${label}`);
const fields = () => [...MODULE_OBJECTS.employmentRecord.fields, ...MODULE_OBJECTS.employee.fields].map((f) => f.code);
const org = (w: ViewsWorld, name: string, broadType: string, parentId = w.tenantId, sequence = 1) =>
  w.org(name, { broadType, establishedOn: '2024-01-01', parents: { admin: { parentId, sequence } } });
const addRequest = async (w: ViewsWorld, departmentId: string) =>
  w.ok<{ id: string; revision: number }>(
    await w.request('POST', '/part-time-requests', {
      body: { ...w.body({ fields: { departmentId } }), requestType: 'add', employeeId: w.employeeId },
    }),
    201,
  );

async function changeType(w: ViewsWorld, orgId: string, broadType: string) {
  await withTenant(w.db, w.tenantId, async (tx) => {
    const [old] = await tx
      .select()
      .from(orgVersions)
      .where(eq(orgVersions.orgId, orgId))
      .orderBy(sql`version_no DESC`)
      .limit(1);
    const versionId = randomUUID();
    await tx
      .insert(orgVersions)
      .values({ ...old!, id: versionId, previousVersionId: old!.id, versionNo: old!.versionNo + 1, broadType });
    const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.versionId, old!.id));
    await tx.insert(orgHierarchyLinks).values(links.map((link) => ({ ...link, versionId })));
  });
}

const institutions = (w: ViewsWorld, id: string) =>
  withTenant(w.db, w.tenantId, async (tx) =>
    rowsOf<{ institution: string }>(
      await tx.execute(sql`
    SELECT to_jsonb(p)->>'institution_id' AS institution FROM employment_payload_versions p
    WHERE tenant_id=${w.tenantId} AND business_id=${id} ORDER BY version_no`),
    ),
  );

describe('AC-PT-F255A 兼职机构保存时固化', () => {
  it('跳过公司和部门，最近机构优先、部门自身可为机构，无匹配回落租户根', async () => {
    const w = await world('hierarchy');
    const top = await org(w, '合成上层机构', '机构');
    const near = await org(w, '合成最近机构', '机构', top.id);
    const company = await org(w, '合成公司', '公司', near.id);
    const department = await org(w, '合成部门', '部门', company.id);
    for (const [departmentId, institutionId] of [
      [department.id, near.id],
      [near.id, near.id],
      [w.partTimeOrg.id, w.tenantId],
    ]) {
      const record = await w.make({ fields: { departmentId } });
      expect(await w.ok(await w.one(record.id))).toMatchObject({ institutionId });
      expect(await institutions(w, record.id)).toEqual([{ institution: institutionId }]);
    }
  });

  it('组织类型变更不改列表存值；改兼职部门追加新存值，原版本不被覆盖', async () => {
    const w = await world('snapshot');
    const parent = await org(w, '合成机构甲', '机构');
    const department = await org(w, '合成部门甲', '部门', parent.id);
    const other = await org(w, '合成机构乙', '机构', w.tenantId, 2);
    const record = await w.make({ fields: { departmentId: department.id }, endDate: '2026-10-20' });
    await changeType(w, parent.id, '公司');
    for (const view of ['ongoing', 'expiring', 'all'])
      expect((await w.view(view)).items[0]).toMatchObject({ institutionId: parent.id });
    const changed = await w.ok(await w.edit(record.id, { fields: { departmentId: other.id } }, record.revision));
    expect(changed).toMatchObject({ institutionId: other.id });
    expect(await institutions(w, record.id)).toEqual([{ institution: parent.id }, { institution: other.id }]);
    expect((await w.view('all')).items[0]).toMatchObject({ institutionId: other.id });
  });

  it('新增申请和草稿改部门写入机构；延长申请读取目标已存机构，不按后来层级重算', async () => {
    const w = await world('request');
    const a = await org(w, '申请机构甲', '机构');
    const b = await org(w, '申请机构乙', '机构', w.tenantId, 2);
    const request = await addRequest(w, a.id);
    const approval = () => w.view('in_approval', '&statuses=draft');
    expect((await approval()).items[0]).toMatchObject({ institutionId: a.id, requestSource: 'part_time' });
    await w.ok(
      await w.request('PATCH', `/part-time-requests/${request.id}`, {
        ifMatch: request.revision,
        body: { fields: { departmentId: b.id } },
      }),
    );
    expect((await approval()).items[0]).toMatchObject({ institutionId: b.id });
    const record = await w.make({ fields: { departmentId: a.id }, endDate: '2026-10-20' });
    await changeType(w, a.id, '公司');
    const extended = await w.ok<{ id: string }>(
      await w.request('POST', '/part-time-requests', {
        body: { requestType: 'extend', recordId: record.id, endDate: '2026-11-20' },
      }),
      201,
    );
    expect((await approval()).items.find((row) => row.id === extended.id)).toMatchObject({ institutionId: a.id });
  });

  it('机构按存值引用名次双向排序并稳定分页；未开始和已结束视图也返回机构', async () => {
    const w = await world('sort');
    const a = await org(w, '排序机构甲', '机构', w.tenantId, 1);
    const b = await org(w, '排序机构乙', '机构', w.tenantId, 2);
    const first = await w.make({ fields: { departmentId: a.id }, startDate: '2026-11-01' });
    const last = await w.make({ fields: { departmentId: b.id }, endDate: '2026-09-20' });
    expect(w.idsOf(await w.view('all', '&sortBy=institutionId'))).toEqual([first.id, last.id]);
    expect(w.idsOf(await w.view('all', '&sortBy=institutionId&direction=desc&pageSize=1'))).toEqual([last.id]);
    expect((await w.view('not_started')).items[0]).toMatchObject({ institutionId: a.id });
    expect((await w.view('ended')).items[0]).toMatchObject({ institutionId: b.id });
    const qa = await addRequest(w, a.id);
    const qb = await addRequest(w, b.id);
    expect(w.idsOf(await w.view('in_approval', '&statuses=draft&sortBy=institutionId'))).toEqual([qa.id, qb.id]);
  });
});

describe('AC-PT-F255A 申请来源和边界', () => {
  it('来源按业务区分而非发起人，新增/延长/结束均属兼职申请；多选 OR', async () => {
    const w = await world('sources');
    const recordId = await w.seedPartTime();
    const expected = [];
    for (const requestType of ['add', 'extend', 'end'] as const)
      expected.push(await w.seedRequest({ requestType, ...(requestType === 'add' ? {} : { recordId }) }));
    expect(w.idsOf(await w.view('in_approval', '&requestSources=part_time')).sort()).toEqual(expected.sort());
    for (const source of ['transfer', 'org_adjustment'])
      expect(await w.view('in_approval', `&requestSources=${source}`)).toMatchObject({ items: [], total: 0 });
    expect((await w.view('in_approval', '&requestSources=transfer&requestSources=part_time')).total).toBe(3);
    expect((await w.view('in_approval', '&requestSources=transfer&requestSources=org_adjustment')).total).toBe(0);
    expect((await w.view('in_approval', '&requestSources=part_time&kinds=end')).total).toBe(1);
  });

  it('非法来源、非审批视图来源筛选拒绝 400；无权字段不返回且不可作为探针', async () => {
    const w = await world('permission');
    await w.make();
    await w.seedRequest({ requestType: 'add' });
    for (const query of [
      'view=all&requestSources=part_time',
      'view=in_approval&requestSources=hr',
      'view=in_approval&requestSources=part_time&requestSources=invalid',
    ])
      expect((await w.get(`/part-times?${query}`)).status).toBe(400);
    for (const [field, query] of [
      ['institutionId', 'view=all&sortBy=institutionId'],
      ['requestSource', 'view=in_approval&requestSources=part_time'],
    ]) {
      const send = w.getAs(restricted({ fields: [...fields(), 'id', 'revision'].filter((key) => key !== field) }));
      expect((await send(`/part-times?${query}`)).status).toBe(403);
      const body = await w.view(field === 'institutionId' ? 'all' : 'in_approval', '', send);
      expect(body.items[0]).not.toHaveProperty(field!);
    }
    expect(MODULE_OBJECTS.employmentRecord.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'institutionId', system: true }),
        expect.objectContaining({ code: 'requestSource', system: true }),
      ]),
    );
  });

  it('机构派生不接受跨租户部门；来源筛选不扩大范围或泄露其他租户申请', async () => {
    const a = await world('tenant-a');
    const b = await world('tenant-b');
    const before = await a.view('all');
    const response = await a.post({ fields: { departmentId: b.partTimeOrg.id } });
    expect(response.status).toBe(400);
    expect(await a.view('all')).toEqual(before);
    await a.seedRequest({ requestType: 'add' });
    await b.seedRequest({ requestType: 'add' });
    expect((await a.view('in_approval', '&requestSources=part_time')).total).toBe(1);
    expect(
      await a.view('in_approval', '&requestSources=part_time', a.getAs(restricted({ scope: EMPTY_SCOPE }))),
    ).toMatchObject({ items: [], total: 0 });
    expect((await a.view('in_approval', `&requestSources=part_time&employeeIds=${b.employeeId}`)).total).toBe(0);
  });
});
