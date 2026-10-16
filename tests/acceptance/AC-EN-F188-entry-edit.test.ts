/**
 * F-188 待入职对齐（DEC-546② R2e8 验收结论；docs/02_业务建模/34 EN-R8 / R14）：
 * 行内“编辑”= PATCH /pending-entries/:id { effectiveDate, probation }：计划入职日期允许过去日期、保持原入职状态、
 * 不同步 Offer；“是否有试用期”必填并随待入职记录落库（改期 / 编辑换日期替换记录时带到新记录）；删除不可恢复。
 * 用例名里的“截图 NN”是 R2e8 spec 的截图编号。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  addHire,
  addPending,
  businessRevision,
  entryAction,
  entryActionRows,
  entryRecords,
  entryWorld,
  hireBody,
  type EntryWorld,
} from './AC-EN-BE2a-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const NORMAL = 0;
const CANCELLED = 1;
const POSTPONED = 2;

interface ViewItem {
  readonly id: string;
  readonly revision: number;
  readonly effectiveDate: string;
  readonly entryStatus: number | null;
  readonly probation: boolean | null;
}

async function view(w: EntryWorld, name = 'all'): Promise<ViewItem[]> {
  const response = await w.session.request('GET', `/pending-entries?view=${name}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ViewItem[] }).items;
}

async function edit(w: EntryWorld, recordId: string, body: object, revision?: number) {
  return w.session.request('PATCH', `/pending-entries/${recordId}`, {
    ifMatch: revision ?? (await businessRevision(w, recordId)),
    body,
  });
}

/** 编辑成功并返回列表里的现存唯一一项（编辑 / 改期会替换记录，ID 可能变化）。 */
async function editOk(w: EntryWorld, recordId: string, body: object) {
  const response = await edit(w, recordId, body);
  expect(response.status, await response.clone().text()).toBe(200);
  const items = [...(await view(w, 'all')), ...(await view(w, 'cancelled'))];
  expect(items).toHaveLength(1);
  return { item: items[0]!, response };
}

describe('F-188 编辑待入职：计划入职日期可改到过去，状态保持原值', () => {
  it('截图 07：改到过去日期成功，入职状态仍为正常；列表是新日期，新旧 ID 由日志串起', async () => {
    const w = await entryWorld(testDb().db, 'f188-past');
    const { recordId } = await addPending(w, '2026-10-10');
    const { item } = await editOk(w, recordId, { effectiveDate: '2026-09-20', probation: true });
    expect(item).toMatchObject({ effectiveDate: '2026-09-20', entryStatus: NORMAL, probation: true });
    expect(item.id).not.toBe(recordId);
    expect(await entryActionRows(w)).toMatchObject([
      {
        action: 'edit',
        fromDate: '2026-10-10',
        toDate: '2026-09-20',
        businessId: item.id,
        previousBusinessId: recordId,
      },
    ]);
  });

  it('截图 08：先改到未来日期、再改回原日期，都成功，状态一直正常', async () => {
    const w = await entryWorld(testDb().db, 'f188-roundtrip');
    const { recordId } = await addPending(w, '2026-10-10');
    const first = await editOk(w, recordId, { effectiveDate: '2026-10-25', probation: false });
    expect(first.item).toMatchObject({ effectiveDate: '2026-10-25', entryStatus: NORMAL });
    const second = await editOk(w, first.item.id, { effectiveDate: '2026-10-10', probation: false });
    expect(second.item).toMatchObject({ effectiveDate: '2026-10-10', entryStatus: NORMAL });
    expect(await entryActionRows(w)).toHaveLength(2);
  });

  it('原来是延期的记录，编辑换日期后仍是延期', async () => {
    const w = await entryWorld(testDb().db, 'f188-keep-postponed');
    const { recordId } = await addPending(w, '2026-10-10');
    expect((await entryAction(w, recordId, 'postpone', { effectiveDate: '2026-10-20' })).status).toBe(200);
    const [postponed] = await view(w);
    const { item } = await editOk(w, postponed!.id, { effectiveDate: '2026-10-22', probation: true });
    expect(item).toMatchObject({ effectiveDate: '2026-10-22', entryStatus: POSTPONED });
  });

  it('原来是取消的记录，编辑换日期后仍是取消（恢复只走 postpone）', async () => {
    const w = await entryWorld(testDb().db, 'f188-keep-cancelled');
    const { recordId } = await addPending(w, '2026-10-10');
    expect((await entryAction(w, recordId, 'cancel', { reason: 'personal' })).status).toBe(200);
    const { item } = await editOk(w, recordId, { effectiveDate: '2026-10-12', probation: false });
    expect(item).toMatchObject({ effectiveDate: '2026-10-12', entryStatus: CANCELLED });
    expect(await view(w, 'all')).toEqual([]);
  });

  it('日期不变、只改试用期：记录 ID 不变，revision +1，不写改期日志', async () => {
    const w = await entryWorld(testDb().db, 'f188-same-date');
    const { recordId } = await addPending(w, '2026-10-10');
    const [before] = await view(w);
    const { item } = await editOk(w, recordId, { effectiveDate: '2026-10-10', probation: true });
    expect(item).toMatchObject({ id: recordId, effectiveDate: '2026-10-10', entryStatus: NORMAL, probation: true });
    expect(item.revision).toBe(before!.revision + 1);
    expect(await entryActionRows(w)).toEqual([]);
  });
});

describe('F-188 是否有试用期：必填、落库、随替换记录保留', () => {
  it('截图 06：不带 probation 返回 400；带 probation=false 保存后读回 false，之后 postpone / 编辑换日期仍保留', async () => {
    const w = await entryWorld(testDb().db, 'f188-probation');
    const { recordId } = await addPending(w, '2026-10-10');
    for (const body of [
      { effectiveDate: '2026-10-11' },
      { probation: true },
      { effectiveDate: '2026-10-11', probation: 'no' },
    ])
      expect((await edit(w, recordId, body)).status).toBe(400);
    expect((await view(w))[0]).toMatchObject({ id: recordId, effectiveDate: '2026-10-10', probation: null });

    const saved = await editOk(w, recordId, { effectiveDate: '2026-10-10', probation: false });
    expect(saved.item.probation).toBe(false);
    expect((await entryAction(w, saved.item.id, 'postpone', { effectiveDate: '2026-10-20' })).status).toBe(200);
    const [postponed] = await view(w);
    expect(postponed).toMatchObject({ effectiveDate: '2026-10-20', entryStatus: POSTPONED, probation: false });
    const replaced = await editOk(w, postponed!.id, { effectiveDate: '2026-10-21', probation: false });
    expect(replaced.item).toMatchObject({ effectiveDate: '2026-10-21', probation: false });
  });

  it('请求体严格：多余字段 400；记录之外的任职字段不能借编辑改', async () => {
    const w = await entryWorld(testDb().db, 'f188-strict');
    const { recordId } = await addPending(w, '2026-10-10');
    const body = { effectiveDate: '2026-10-11', probation: true };
    for (const extra of [{ remark: '备注' }, { fields: { place: '新地点' } }, { employType: 'intern' }])
      expect((await edit(w, recordId, { ...body, ...extra })).status).toBe(400);
    expect((await edit(w, recordId, { ...body, effectiveDate: '10-11' })).status).toBe(400);
    expect((await view(w))[0]).toMatchObject({ id: recordId, effectiveDate: '2026-10-10' });
  });

  it('添加待入职带 probation 能落库；不带时列表为 null', async () => {
    const w = await entryWorld(testDb().db, 'f188-add');
    const withValue = await w.session.employee('带试用期合成员工');
    const added = await addHire(
      w.session,
      withValue,
      hireBody(w.org.id, '2026-10-10', { pendingEntry: true, probation: true }),
    );
    expect(added.status, await added.clone().text()).toBe(201);
    const without = await w.session.employee('未填试用期合成员工');
    expect((await addHire(w.session, without, hireBody(w.org.id, '2026-10-11', { pendingEntry: true }))).status).toBe(
      201,
    );
    const items = await view(w);
    expect(items.map((item) => [item.effectiveDate, item.probation])).toEqual([
      ['2026-10-10', true],
      ['2026-10-11', null],
    ]);
  });

  it('办理入职后不再保留待入职试用期；办理入职 body 仍必填 probation', async () => {
    const w = await entryWorld(testDb().db, 'f188-complete');
    const { recordId } = await addPending(w, '2026-10-10');
    await editOk(w, recordId, { effectiveDate: '2026-10-10', probation: true });
    expect((await entryAction(w, recordId, 'complete', {})).status).toBe(400);
    expect((await entryAction(w, recordId, 'complete', { probation: false })).status).toBe(200);
    expect(await probationRows(w)).toEqual([]);
  });
});

async function probationRows(w: EntryWorld) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const result =
      await tx.execute(sql`SELECT business_id AS "businessId", probation FROM employment_pending_entry_probation
      WHERE tenant_id=${w.session.tenant.id}`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Record<string, unknown>[];
  });
}

describe('F-188 权限与并发', () => {
  it('没有 effectiveDate 字段写权限：403，没有任何写入；If-Match 过期 409', async () => {
    const w = await entryWorld(testDb().db, 'f188-perm');
    const { recordId } = await addPending(w, '2026-10-10');
    const denied = tenantApi(w.db, {
      clock: () => new Date('2026-10-01T01:00:00.000Z'),
      authorize: (request) => !(request.action === 'object.update' && request.fields?.includes('effectiveDate')),
    });
    const revision = await businessRevision(w, recordId);
    const response = await denied.request('PATCH', `/api/tenant/employment/pending-entries/${recordId}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: revision,
      idempotencyKey: randomUUID(),
      body: { effectiveDate: '2026-10-20', probation: true },
    });
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await entryActionRows(w)).toEqual([]);
    expect(await probationRows(w)).toEqual([]);
    expect((await view(w))[0]).toMatchObject({ id: recordId, effectiveDate: '2026-10-10', revision, probation: null });

    const stale = await edit(w, recordId, { effectiveDate: '2026-10-20', probation: true }, revision + 5);
    expect(stale.status).toBe(409);
    expect((await view(w))[0]).toMatchObject({ id: recordId, effectiveDate: '2026-10-10' });
  });

  it('已办理入职的记录不能编辑（409 NOT_PENDING_ENTRY）', async () => {
    const w = await entryWorld(testDb().db, 'f188-hired');
    const { recordId } = await addPending(w, '2026-09-01');
    expect((await entryAction(w, recordId, 'complete', { probation: false })).status).toBe(200);
    const response = await edit(w, recordId, { effectiveDate: '2026-09-05', probation: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'NOT_PENDING_ENTRY' } } });
  });
});

describe('F-188 删除不可恢复（R2e8）', () => {
  it('删除后四个视图都查不到；对同一 ID 编辑 / 改期被拒；试用期不保留', async () => {
    const w = await entryWorld(testDb().db, 'f188-delete');
    const { recordId } = await addPending(w, '2026-10-10');
    await editOk(w, recordId, { effectiveDate: '2026-10-10', probation: true });
    const response = await w.session.request('DELETE', `/pending-entries/${recordId}`, {
      ifMatch: await businessRevision(w, recordId),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    for (const name of ['all', 'today', 'cancelled', 'hired']) expect(await view(w, name)).toEqual([]);
    const edited = await edit(w, recordId, { effectiveDate: '2026-10-12', probation: true }, 1);
    const postponed = await entryAction(w, recordId, 'postpone', { effectiveDate: '2026-10-12' }, 1);
    expect([edited.status, postponed.status].every((status) => status === 404 || status === 409)).toBe(true);
    expect(await probationRows(w)).toEqual([]);
    for (const name of ['all', 'today', 'cancelled', 'hired']) expect(await view(w, name)).toEqual([]);
  });
});
