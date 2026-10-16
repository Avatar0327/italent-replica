/**
 * BE-2b 入职四视图（docs/02_业务建模/34 EN-R1，DEC-484② / F-129）：
 * 全部待入职（入职状态 ≠ 取消）、今日待入职（入职日 = 租户今天）、已取消入职、已入职。
 * 视图以当前待入职记录为准：改期替换记录后只出现新记录，删除后全视图不可见（EN-R14）。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { addHire, businessRevision, entryAction, entryWorld, hireBody, type EntryWorld } from './AC-EN-BE2a-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

interface EntryItem {
  readonly id: string;
  readonly employeeId: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly effectiveDate: string;
  readonly employeeStatus: number;
  readonly entryStatus: number | null;
  readonly departmentId: string;
  readonly revision: number;
}

async function addEntry(w: EntryWorld, name: string, date: string, orgId = w.org.id, pending = true) {
  const employee = await w.session.employee(name);
  const body = hireBody(orgId, date, pending ? { pendingEntry: true } : {});
  const response = await addHire(w.session, employee, body);
  expect(response.status, await response.clone().text()).toBe(201);
  const business = (await response.json()) as { id: string };
  return { employee, id: business.id, name };
}

async function view(w: EntryWorld, name: string, query = ''): Promise<EntryItem[]> {
  const response = await w.session.request('GET', `/pending-entries?view=${name}${query}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: EntryItem[] }).items;
}

/** 一个租户里的六种状态：今日 / 将来 / 延期到今日 / 已取消 / 办理入职 / 直接入职。 */
async function seed(w: EntryWorld) {
  const today = await addEntry(w, '今日合成员工', '2026-10-01');
  const future = await addEntry(w, '将来合成员工', '2026-10-10');
  const postponed = await addEntry(w, '延期合成员工', '2026-10-05');
  const cancelled = await addEntry(w, '取消合成员工', '2026-10-01');
  const completed = await addEntry(w, '办理合成员工', '2026-09-01');
  const direct = await addEntry(w, '直接入职合成员工', '2026-08-01', w.org.id, false);
  expect((await entryAction(w, postponed.id, 'postpone', { effectiveDate: '2026-10-01' })).status).toBe(200);
  expect((await entryAction(w, cancelled.id, 'cancel', { reason: 'personal' })).status).toBe(200);
  expect((await entryAction(w, completed.id, 'complete', { probation: false })).status).toBe(200);
  return { today, future, postponed, cancelled, completed, direct };
}

const names = (items: readonly EntryItem[]) => items.map((item) => item.name).sort();

describe('BE-2b 入职四视图', () => {
  it('四个视图按入职状态与入职日分流', async () => {
    const w = await entryWorld(testDb().db, 'be2b-views');
    await seed(w);
    expect(names(await view(w, 'all'))).toEqual(['今日合成员工', '将来合成员工', '延期合成员工'].sort());
    expect(names(await view(w, 'today'))).toEqual(['今日合成员工', '延期合成员工']);
    expect(names(await view(w, 'cancelled'))).toEqual(['取消合成员工']);
    expect(names(await view(w, 'hired'))).toEqual(['直接入职合成员工', '办理合成员工']);
  });

  it('条目带员工、业务类型、日期、状态与部门；按入职日、ID 排序', async () => {
    const w = await entryWorld(testDb().db, 'be2b-shape');
    const s = await seed(w);
    const all = await view(w, 'all');
    expect(all.map((item) => item.effectiveDate)).toEqual(['2026-10-01', '2026-10-01', '2026-10-10']);
    const future = all.find((item) => item.name === '将来合成员工')!;
    expect(future).toMatchObject({
      id: s.future.id,
      employeeId: s.future.employee.id,
      code: s.future.employee.code,
      kind: 'hire',
      employeeStatus: 1,
      entryStatus: 0,
      departmentId: w.org.id,
    });
    expect(future.revision).toBe(await businessRevision(w, s.future.id));
    expect(all.find((item) => item.name === '延期合成员工')).toMatchObject({ entryStatus: 2 });
    expect((await view(w, 'hired')).every((item) => item.entryStatus === null)).toBe(true);
  });

  it('改期替换记录后只见新记录；删除后全视图不可见（EN-R14）', async () => {
    const w = await entryWorld(testDb().db, 'be2b-current');
    const s = await seed(w);
    const before = (await view(w, 'all')).find((item) => item.name === '将来合成员工')!;
    expect((await entryAction(w, s.future.id, 'postpone', { effectiveDate: '2026-10-20' })).status).toBe(200);
    const after = (await view(w, 'all')).find((item) => item.name === '将来合成员工')!;
    expect(after.id).not.toBe(before.id);
    expect(after).toMatchObject({ effectiveDate: '2026-10-20', entryStatus: 2 });
    expect((await view(w, 'all')).filter((item) => item.name === '将来合成员工')).toHaveLength(1);

    const removed = await w.session.request('DELETE', `/pending-entries/${after.id}`, {
      ifMatch: await businessRevision(w, after.id),
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    for (const name of ['all', 'today', 'cancelled', 'hired'])
      expect((await view(w, name)).some((item) => item.employeeId === s.future.employee.id)).toBe(false);
  });

  it('已取消入职改期即恢复：从已取消视图回到全部待入职', async () => {
    const w = await entryWorld(testDb().db, 'be2b-restore');
    const s = await seed(w);
    expect((await entryAction(w, s.cancelled.id, 'postpone', { effectiveDate: '2026-10-12' })).status).toBe(200);
    expect(await view(w, 'cancelled')).toEqual([]);
    expect((await view(w, 'all')).find((item) => item.name === '取消合成员工')).toMatchObject({ entryStatus: 2 });
  });

  it('今日按租户时区判定入职日，不用 UTC 日期', async () => {
    const w = await entryWorld(testDb().db, 'be2b-today-tz');
    await addEntry(w, '明日合成员工', '2026-10-02');
    expect(await view(w, 'today')).toEqual([]);
    // 租户时区 Asia/Shanghai：UTC 10-01 17:00 已是本地 10-02
    w.session.setNow('2026-10-01T17:00:00.000Z');
    expect(names(await view(w, 'today'))).toEqual(['明日合成员工']);
  });

  it('分页：pageSize 与 page 生效，pageSize 超上限 400', async () => {
    const w = await entryWorld(testDb().db, 'be2b-page');
    await seed(w);
    const first = await view(w, 'all', '&pageSize=2&page=1');
    const second = await view(w, 'all', '&pageSize=2&page=2');
    expect([first.length, second.length]).toEqual([2, 1]);
    expect(new Set([...first, ...second].map((item) => item.id)).size).toBe(3);
    const tooBig = await w.session.request('GET', '/pending-entries?view=all&pageSize=1000');
    expect(tooBig.status).toBe(400);
  });

  it.each(['', '?view=', '?view=unknown', '?view=ALL'])('视图参数缺失或不合法：%s → 400', async (query) => {
    const w = await entryWorld(testDb().db, `be2b-bad-${query.length}`);
    const response = await w.session.request('GET', `/pending-entries${query}`);
    expect(response.status).toBe(400);
  });
});

describe('BE-2b 入职四视图的数据范围（fail-closed）', () => {
  async function scoped(w: EntryWorld, orgIds: readonly string[]) {
    const authorize: Authorizer = () => true;
    registerScopeProvider(authorize, {
      scope: async () => ({
        ...EMPTY_SCOPE,
        orgIds,
        hasDataPermission: orgIds.length > 0,
        terms: orgIds.length ? [{ dimension: 'organization' as const, orgIds, personIds: [] }] : [],
      }),
      authorize: async () => true,
      fields: async () =>
        new Set(['id', 'employeeId', 'code', 'name', 'kind', 'effectiveDate', 'revision', 'departmentId']),
    });
    const api = tenantApi(w.db, { authorize, clock: () => new Date('2026-10-01T01:00:00.000Z') });
    return async (name: string) => {
      const response = await api.request('GET', `/api/tenant/employment/pending-entries?view=${name}`, {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as { items: EntryItem[]; hasDataPermission: boolean };
    };
  }

  it('只看到范围内部门的待入职；范围为空什么也看不到', async () => {
    const w = await entryWorld(testDb().db, 'be2b-scope');
    const other = await w.session.org(`另一部门-${randomUUID()}`, { establishedOn: '2026-01-01' });
    await addEntry(w, '本部门合成员工', '2026-10-10');
    await addEntry(w, '他部门合成员工', '2026-10-10', other.id);
    const inScope = await scoped(w, [w.org.id]);
    expect(names((await inScope('all')).items)).toEqual(['本部门合成员工']);
    const empty = await scoped(w, []);
    const none = await empty('all');
    expect(none.items).toEqual([]);
    expect(none.hasDataPermission).toBe(false);
  });
});
