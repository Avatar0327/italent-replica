/**
 * AC-DM-R2（黑名单管理部分，B68）：组织员工 > 黑名单管理 > 黑名单（差距表“补证结论 R2f”、DEC-569）。
 * 列：姓名、证件号码、手机号、加黑原因、加黑日期、有效截止日期（空 = 永久）、邮箱、数据来源；
 * 新增（手动加黑）/ 编辑 / 移出 / 删除；导入未验证（后补）。原因与期限是两个独立字段。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { blacklistWorld, leftEmployee, rowsOf, setPersonIdentity } from './AC-DM-R2-blacklist-support.js';

const testDb = useTestDb();
const TODAY = '2026-10-01';
const error = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;

describe('AC-DM-R2 手动加黑与列表', () => {
  it('选人员加黑：快照档案的姓名 / 证件号 / 手机 / 邮箱，加黑日期 = 今天，来源“手工新增”，截止日期空 = 永久', async () => {
    const w = await blacklistWorld(testDb().db, 'add-employee');
    const { employee } = await leftEmployee(w.db, w.session, '加黑员工甲', {
      idNumber: 'ID-SYN-0001',
      mobilePhone: '13800000001',
      email: 'synthetic-a@example.com',
    });
    const entry = await w.added({ employeeId: employee.id, reason: 'major_violation', note: '合成说明' });
    expect(entry).toMatchObject({
      employeeId: employee.id,
      name: '加黑员工甲',
      idNumber: 'ID-SYN-0001',
      mobilePhone: '13800000001',
      email: 'synthetic-a@example.com',
      reason: 'major_violation',
      blacklistDate: TODAY,
      expiryDate: null,
      note: '合成说明',
      source: 'manual',
      status: 'active',
      revision: 1,
    });
    const page = await w.list();
    expect(page.hasDataPermission).toBe(true);
    expect(page.items.map((item) => item.id)).toEqual([entry.id]);
  });

  it('不选人员时手填姓名与至少一项证件号 / 手机 / 邮箱；原因“其他(当月…)”不推导期限', async () => {
    const w = await blacklistWorld(testDb().db, 'add-manual');
    const entry = await w.added({ name: '外部人员乙', mobilePhone: '13800000002', reason: 'other' });
    expect(entry).toMatchObject({ employeeId: null, name: '外部人员乙', reason: 'other', expiryDate: null });
    const dated = await w.added({
      name: '外部人员丙',
      idNumber: 'ID-SYN-0003',
      reason: 'resignation',
      expiryDate: '2026-12-31',
    });
    expect(dated.expiryDate).toBe('2026-12-31');
  });

  it('输入非法 400、重复加黑 409、If-Match 非 0 409，均不写入', async () => {
    const w = await blacklistWorld(testDb().db, 'add-invalid');
    const { employee } = await leftEmployee(w.db, w.session, '重复员工', { idNumber: 'ID-SYN-0004' });
    await w.added({ employeeId: employee.id, reason: 'integrity' });
    const cases: [unknown, number, string?][] = [
      [{ name: '无联系方式', reason: 'other' }, 400],
      [{ name: '原因非法', mobilePhone: '13800000005', reason: '其他' }, 400],
      [{ mobilePhone: '13800000006', reason: 'other' }, 400],
      [{ employeeId: employee.id, name: '改名', reason: 'other' }, 400],
      [{ name: '早于今天', mobilePhone: '13800000007', reason: 'other', expiryDate: '2026-09-30' }, 400],
      [{ name: '多余字段', mobilePhone: '13800000008', reason: 'other', source: 'import' }, 400],
      [{ name: '说明过长', mobilePhone: '13800000009', reason: 'other', note: 'x'.repeat(501) }, 400],
      [{ employeeId: '00000000-0000-4000-8000-000000000000', reason: 'other' }, 404],
      [{ employeeId: employee.id, reason: 'other' }, 409, 'BLACKLIST_DUPLICATE'],
      [{ name: '同证件号', idNumber: 'id-syn-0004', reason: 'other' }, 409, 'BLACKLIST_DUPLICATE'],
    ];
    for (const [body, status, reason] of cases) {
      const response = await w.add(body);
      expect(response.status, `${JSON.stringify(body)} → ${await response.clone().text()}`).toBe(status);
      if (reason) expect((await error(response)).details).toMatchObject({ reason });
    }
    expect((await w.add({ name: '版本', mobilePhone: '13800000010', reason: 'other' }, { ifMatch: 2 })).status).toBe(
      409,
    );
    expect((await w.list()).items).toHaveLength(1);
  });

  it('空白证件号不参与查重（#387 第 1 轮 P2-1）：两个不同人员证件号都为空，先后加黑都成功、证件号存为空', async () => {
    const w = await blacklistWorld(testDb().db, 'blank-duplicate');
    const a = await leftEmployee(w.db, w.session, '空证件甲', { idNumber: '', mobilePhone: '13800000211' });
    const b = await leftEmployee(w.db, w.session, '空证件乙', { idNumber: ' ', mobilePhone: '13800000212' });
    const first = await w.added({ employeeId: a.employee.id, reason: 'integrity' });
    const second = await w.add({ employeeId: b.employee.id, reason: 'integrity' });
    expect(second.status, await second.clone().text()).toBe(201);
    expect([first.idNumber, ((await second.json()) as { idNumber: string | null }).idNumber]).toEqual([null, null]);
    expect((await w.list()).items).toHaveLength(2);
  });

  it('筛选：姓名包含、证件号 / 手机号精确、原因、来源、状态；按加黑日期倒序', async () => {
    const w = await blacklistWorld(testDb().db, 'filters');
    const a = await w.added({ name: '筛选张一', idNumber: 'ID-SYN-0011', reason: 'integrity' });
    // 同一加黑日期按创建时间倒序：时钟固定，显式拨后一分钟
    w.session.setNow('2026-10-01T01:01:00.000Z');
    const b = await w.added({ name: '筛选李二', mobilePhone: '13800000012', reason: 'instability' });
    w.session.setNow('2026-10-02T01:00:00.000Z');
    const c = await w.added({ name: '筛选张三', email: 'synthetic-c@example.com', reason: 'integrity' });
    expect((await w.list()).items.map((i) => i.id)).toEqual([c.id, b.id, a.id]);
    expect((await w.list('?name=张')).items.map((i) => i.id)).toEqual([c.id, a.id]);
    expect((await w.list('?idNumber=ID-SYN-0011')).items.map((i) => i.id)).toEqual([a.id]);
    expect((await w.list('?mobilePhone=13800000012')).items.map((i) => i.id)).toEqual([b.id]);
    expect((await w.list('?reason=integrity')).items.map((i) => i.id)).toEqual([c.id, a.id]);
    expect((await w.list('?source=manual')).items).toHaveLength(3);
    expect((await w.list('?source=import')).items).toHaveLength(0);
    for (const bad of ['?reason=x', '?status=gone', '?source=x', '?pageSize=0']) {
      expect((await w.session.request('GET', `/blacklist${bad}`)).status).toBe(400);
    }
  });
});

describe('AC-DM-R2 编辑 / 移出 / 删除', () => {
  it('编辑原因、截止日期、说明：revision +1；改身份字段 400；revision 过期 409；不存在 404', async () => {
    const w = await blacklistWorld(testDb().db, 'edit');
    const entry = await w.added({ name: '编辑对象', mobilePhone: '13800000020', reason: 'other' });
    const saved = await w.edit(entry.id, 1, { reason: 'resignation', expiryDate: '2027-01-31', note: '改为辞职' });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await saved.json()).toMatchObject({
      reason: 'resignation',
      expiryDate: '2027-01-31',
      note: '改为辞职',
      revision: 2,
    });
    const permanent = await w.edit(entry.id, 2, { expiryDate: null });
    expect(await permanent.json()).toMatchObject({ expiryDate: null, revision: 3 });
    expect((await w.edit(entry.id, 3, { name: '改名' })).status).toBe(400);
    expect((await w.edit(entry.id, 1, { note: '旧版本' })).status).toBe(409);
    expect((await w.edit('00000000-0000-4000-8000-000000000000', 1, { note: 'x' })).status).toBe(404);
    expect((await w.edit('not-a-uuid', 1, { note: 'x' })).status).toBe(400);
  });

  it('移出：整批成功或整批失败；移出后不在默认列表、可按 status=removed 查到、不能再编辑；可再次加黑', async () => {
    const w = await blacklistWorld(testDb().db, 'remove');
    const a = await w.added({ name: '移出甲', mobilePhone: '13800000031', reason: 'other' });
    const b = await w.added({ name: '移出乙', mobilePhone: '13800000032', reason: 'other' });
    const stale = await w.remove([
      { id: a.id, revision: 1 },
      { id: b.id, revision: 9 },
    ]);
    expect(stale.status).toBe(409);
    expect((await w.list()).items).toHaveLength(2);
    const removed = await w.remove([
      { id: a.id, revision: 1 },
      { id: b.id, revision: 1 },
    ]);
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await w.list()).items).toHaveLength(0);
    const history = await w.list('?status=removed');
    expect(history.items.map((i) => [i.name, i.status, i.revision]).sort()).toEqual([
      ['移出乙', 'removed', 2],
      ['移出甲', 'removed', 2],
    ]);
    const again = await w.edit(a.id, 2, { note: '已移出' });
    expect(again.status).toBe(409);
    expect((await error(again)).details).toMatchObject({ reason: 'BLACKLIST_REMOVED' });
    expect((await w.remove([{ id: a.id, revision: 2 }])).status).toBe(409);
    expect((await w.added({ name: '移出甲', mobilePhone: '13800000031', reason: 'integrity' })).status).toBe('active');
  });

  it('删除：整行删除并在审计留快照；批量上限 100、重复 id 400', async () => {
    const w = await blacklistWorld(testDb().db, 'delete');
    const entry = await w.added({ name: '删除对象', idNumber: 'ID-SYN-0040', reason: 'integrity' });
    w.session.setNow('2026-10-01T01:01:00.000Z');
    const deleted = await w.destroy([{ id: entry.id, revision: 1 }]);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect((await w.list()).items).toHaveLength(0);
    expect((await w.list('?status=removed')).items).toHaveLength(0);
    const audits = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rowsOf<{ action: string; before: { name?: string } | null; after: unknown }>(
        await tx.execute(sql`SELECT action, before, after FROM audit_events
          WHERE tenant_id = ${w.session.tenant.id} AND object_id = ${entry.id} ORDER BY occurred_at, id`),
      ),
    );
    expect(audits.map((a) => a.action)).toEqual(['blacklist.create', 'blacklist.delete']);
    expect(audits[1]).toMatchObject({ before: { name: '删除对象' }, after: null });
    const many = Array.from({ length: 101 }, () => ({ id: entry.id, revision: 1 }));
    expect((await w.destroy(many)).status).toBe(400);
    expect(
      (
        await w.destroy([
          { id: entry.id, revision: 1 },
          { id: entry.id, revision: 1 },
        ])
      ).status,
    ).toBe(400);
    expect((await w.destroy([{ id: entry.id, revision: 1 }])).status).toBe(404);
  });
});

describe('AC-DM-R2 黑名单按租户隔离', () => {
  it('另一租户看不到、改不了本租户的黑名单', async () => {
    const w = await blacklistWorld(testDb().db, 'tenant-a');
    const other = await blacklistWorld(testDb().db, 'tenant-b');
    const entry = await w.added({ name: '本租户', mobilePhone: '13800000050', reason: 'other' });
    expect((await other.list()).items).toHaveLength(0);
    expect((await other.edit(entry.id, 1, { note: '跨租户' })).status).toBe(404);
    const { employee } = await leftEmployee(other.db, other.session, '另一租户员工');
    await setPersonIdentity(other.db, other.session, employee.id, { mobilePhone: '13800000050' });
    expect((await other.added({ name: '本租户', mobilePhone: '13800000050', reason: 'other' })).status).toBe('active');
  });
});
