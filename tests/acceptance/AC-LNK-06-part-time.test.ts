/**
 * AC-LNK-06 调动勾选结束兼职（docs/08_设计/R2-T05_兼职设计.md §4.7，PB-48～51 / PB-81，PT-6）：走生产装配的真实调动端口
 * （createApp 经 employment/routes.ts 的 installPartTime 登记），不用替身。失效日 = 调动实际生效日 − 1（#71、R2d、R2f
 * 三次一致，🟢 实测）；迟到按实际执行日；联动结果仍在时拒绝删除调动（DEC-012 / DEC-172，探针 transfer-linkage:part-time）。
 * 原 AC-LNK-01-06 的替身用例保留（只验证子项执行与重试机制）。
 */
import { sql, withTenant } from '@italent/db';
import { partTimeServiceStatus } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { AppError } from '@italent/api';
import { afterEach, describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import {
  registerTransferPartTimePort,
  transferPartTimePort,
  type TransferPartTimePort,
} from '../../apps/api/src/modules/transfer/linkage/part-time.js';
import { D, linkageWorld, type LinkageWorld } from './AC-LNK-support.js';
import { insertPartTimeRecord } from './AC-PT-support.js';

const database = useTestDb();
type Person = { employee: { id: string } };

/** 可信造数一条兼职记录（缺省 09-05 开始、无结束日期，租户今天 10-01 时在进行中）。 */
function seedPartTime(w: LinkageWorld, person: Person, input: { startDate?: string; endDate?: string | null } = {}) {
  const tenantId = w.session.tenant.id;
  return withTenant(w.db, tenantId, (tx) =>
    insertPartTimeRecord(tx, {
      tenantId,
      employeeId: person.employee.id,
      departmentId: w.from.id,
      startDate: '2026-09-05',
      endDate: null,
      ...input,
    }),
  );
}

const terms = (w: LinkageWorld, recordId: string) =>
  withTenant(w.db, w.session.tenant.id, async (tx) =>
    rowsOf<{ term_no: number; end_date: string | null; source: string; source_id: string | null }>(
      await tx.execute(sql`SELECT term_no, end_date::text, source, source_id::text FROM employment_part_time_terms
        WHERE tenant_id=${w.session.tenant.id} AND record_id=${recordId}::uuid ORDER BY term_no`),
    ),
  );

/** 保存并审批通过一张带“结束兼职”的 HR 调动（计划生效日 effectiveDate，缺省 D）。 */
async function approvedTransfer(w: LinkageWorld, person: Person, recordIds: string[], effectiveDate = D) {
  const business = await w.saved(
    await w.transfer(person, { effectiveDate, linkage: { partTimes: recordIds.map((recordId) => ({ recordId })) } }),
  );
  expect(business.status).toBe('in_review');
  return w.approve(business, '2026-10-02T01:00:00Z');
}

/** 补录过去日期的直接调动：保存即生效，联动同事务执行。 */
async function executedTransfer(w: LinkageWorld, person: Person, effectiveDate: string, recordIds: string[]) {
  return w.saved(
    await w.transfer(person, {
      mode: 'direct',
      submit: undefined,
      effectiveDate,
      linkage: { partTimes: recordIds.map((recordId) => ({ recordId })) },
    }),
  );
}

let real: TransferPartTimePort | undefined;
afterEach(() => {
  if (real) registerTransferPartTimePort(real);
  real = undefined;
});

describe('AC-LNK-06 调动结束兼职 = 调动生效日 − 1（真实端口）', () => {
  it('PB-48：调动 10-13 勾选结束兼职 → 兼职结束于 10-12（任职结束），期限来源 transfer、source_id = 联动子项', async () => {
    const w = await linkageWorld(database().db, 'lnk06-end');
    const person = await w.hire('兼职调动员工');
    const record = await seedPartTime(w, person);
    const business = await approvedTransfer(w, person, [record], '2026-10-13');
    expect((await w.runScheduler('2026-10-12T01:00:00Z')).activated).toEqual([]);
    expect(await terms(w, record)).toHaveLength(1);

    const run = await w.runScheduler('2026-10-13T01:00:00Z');
    expect(run).toMatchObject({ activated: [business.id], failed: [], errors: [] });
    const [item] = (await w.linkage(business.id)).partTimes;
    expect(item).toMatchObject({ partTimeRecordId: record, status: 'succeeded', effectiveDate: '2026-10-12' });
    expect(await terms(w, record)).toEqual([
      { term_no: 1, end_date: null, source: 'create', source_id: null },
      { term_no: 2, end_date: '2026-10-12', source: 'transfer', source_id: item!.id },
    ]);
    const span = { startDate: '2026-09-05', endDate: '2026-10-12' };
    expect(partTimeServiceStatus(span, '2026-10-12')).toBe('serving');
    expect(partTimeServiceStatus(span, '2026-10-13')).toBe('ended');
    const audits = await w.auditEvents(record);
    expect(audits.map((event) => event.action)).toContain('employment.part_time.ended_by_transfer');
  });

  it('PB-49：调动迟到到 10-18 执行 → 兼职结束于 10-17（按实际生效日，S3）', async () => {
    const w = await linkageWorld(database().db, 'lnk06-late');
    const person = await w.hire('迟到调动员工');
    const record = await seedPartTime(w, person);
    const business = await approvedTransfer(w, person, [record], '2026-10-13');
    expect(await w.runScheduler('2026-10-18T01:00:00Z')).toMatchObject({ activated: [business.id], errors: [] });
    const [item] = (await w.linkage(business.id)).partTimes;
    expect(item).toMatchObject({ status: 'succeeded', effectiveDate: '2026-10-17' });
    expect((await terms(w, record)).map((term) => [term.end_date, term.source])).toEqual([
      [null, 'create'],
      ['2026-10-17', 'transfer'],
    ]);
  });

  it('S4：兼职本就早于失效日结束 → 子项成功但不追加期限（幂等）', async () => {
    const w = await linkageWorld(database().db, 'lnk06-closed');
    const person = await w.hire('提前结束员工');
    const record = await seedPartTime(w, person, { endDate: '2026-10-05' });
    const business = await approvedTransfer(w, person, [record]);
    expect(await w.runScheduler('2026-10-10T01:00:00Z')).toMatchObject({ activated: [business.id], errors: [] });
    expect((await w.linkage(business.id)).partTimes[0]).toMatchObject({ status: 'succeeded' });
    expect(await terms(w, record)).toEqual([{ term_no: 1, end_date: '2026-10-05', source: 'create', source_id: null }]);
  });

  it('S5：开始日晚于失效日（补录过去日期的调动）→ 写空区间 end = 开始日 − 1，任职结束', async () => {
    const w = await linkageWorld(database().db, 'lnk06-empty');
    const person = await w.hire('空区间员工');
    const record = await seedPartTime(w, person, { startDate: '2026-09-25' });
    const business = await executedTransfer(w, person, '2026-09-20', [record]);
    expect((await w.linkage(business.id)).partTimes[0]).toMatchObject({ status: 'succeeded' });
    expect((await terms(w, record)).map((term) => [term.end_date, term.source])).toEqual([
      [null, 'create'],
      ['2026-09-24', 'transfer'],
    ]);
    expect(partTimeServiceStatus({ startDate: '2026-09-25', endDate: '2026-09-24' }, '2026-09-30')).toBe('ended');
  });

  it('PB-51：联动子项结束兼职失败 → 记失败可见；HR 重试成功且只追加一期（幂等）', async () => {
    const w = await linkageWorld(database().db, 'lnk06-retry');
    const person = await w.hire('重试员工');
    const record = await seedPartTime(w, person);
    real = transferPartTimePort();
    let failures = 1;
    registerTransferPartTimePort({
      ...real,
      async end(tx, ctx, input) {
        if (failures-- > 0) throw new AppError('CONFLICT', '兼职记录已变更', { reason: 'PART_TIME_CHANGED' });
        return real!.end(tx, ctx, input);
      },
    });
    const business = await approvedTransfer(w, person, [record]);
    await w.runScheduler('2026-10-10T01:00:00Z');
    const failed = (await w.linkage(business.id)).partTimes[0]!;
    expect(failed).toMatchObject({ status: 'failed', failure: { rule: 'PART_TIME_CHANGED' } });
    expect(await terms(w, record)).toHaveLength(1);

    const retried = await w.retryItem(failed);
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect((await w.linkage(business.id)).partTimes[0]).toMatchObject({ status: 'succeeded', attemptCount: 2 });
    expect((await terms(w, record)).map((term) => [term.end_date, term.source, term.source_id])).toEqual([
      [null, 'create', null],
      ['2026-10-09', 'transfer', failed.id],
    ]);
  });

  it('PB-50：校验层只认进行中的兼职（未来开始 / 已结束 / 他人的都报 PART_TIME_RECORD_NOT_FOUND）', async () => {
    const w = await linkageWorld(database().db, 'lnk06-exists');
    const person = await w.hire('列表员工');
    const other = await w.hire('他人');
    const future = await seedPartTime(w, person, { startDate: '2026-10-05' });
    const ended = await seedPartTime(w, person, { endDate: '2026-09-30' });
    const foreign = await seedPartTime(w, other);
    for (const recordId of [future, ended, foreign, crypto.randomUUID()]) {
      const response = await w.transfer(person, { linkage: { partTimes: [{ recordId }] } });
      expect(response.status, recordId).toBe(400);
      expect(await response.json()).toMatchObject({ error: { details: { reason: 'PART_TIME_RECORD_NOT_FOUND' } } });
    }
    const ongoing = await seedPartTime(w, person);
    expect((await w.transfer(person, { linkage: { partTimes: [{ recordId: ongoing }] } })).status).toBe(201);
  });

  it('调动预览返回进行中的兼职列表 partTimes（HR 调动；未来开始 / 已结束的不在列表）', async () => {
    const w = await linkageWorld(database().db, 'lnk06-preview');
    const person = await w.hire('预览员工');
    const ongoing = await seedPartTime(w, person, { endDate: '2026-12-31' });
    await seedPartTime(w, person, { startDate: '2026-10-05' });
    await seedPartTime(w, person, { endDate: '2026-09-30' });
    const response = await w.session.request('POST', `/transfers/employees/${person.employee.id}/preview`, {
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'application',
        effectiveDate: D,
        fields: { departmentId: w.to.id },
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { partTimes: { items: { id: string }[]; hiddenCount: number } };
    expect(body.partTimes.hiddenCount).toBe(0);
    expect(body.partTimes.items).toEqual([
      expect.objectContaining({
        id: ongoing,
        departmentId: w.from.id,
        startDate: '2026-09-05',
        endDate: '2026-12-31',
      }),
    ]);
  });
});

describe('PB-81 调动删除探针 transfer-linkage:part-time（DEC-012 / DEC-172）', () => {
  it('联动结束的兼职仍停在该子项写的那一期 → 拒绝删除（只给件数）；HR 改过结束日后可以删除', async () => {
    const w = await linkageWorld(database().db, 'lnk06-probe');
    const person = await w.hire('探针员工');
    const record = await seedPartTime(w, person);
    const business = await executedTransfer(w, person, '2026-09-20', [record]);
    expect((await w.linkage(business.id)).partTimes[0]).toMatchObject({ status: 'succeeded' });

    const head = await w.business(business.id);
    const refused = await w.session.request('DELETE', `/businesses/${business.id}`, { ifMatch: head.revision });
    expect(refused.status, await refused.clone().text()).toBe(409);
    const body = (await refused.json()) as {
      error: { details: { reason: string; linkages: { kind: string; label: string; count: number }[] } };
    };
    expect(body.error.details.reason).toBe('EMPLOYMENT_LINKED_CHANGES_EXIST');
    expect(body.error.details.linkages).toEqual([expect.objectContaining({ kind: 'partTimeEnd', count: 1 })]);
    expect(JSON.stringify(body)).not.toContain(record);

    const current = await w.session.request('GET', `/part-times/${record}`);
    const { revision } = (await current.json()) as { revision: number };
    const edited = await w.session.request('PATCH', `/part-times/${record}`, {
      ifMatch: revision,
      body: { endDate: '2026-09-25' },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const after = await w.business(business.id);
    const removed = await w.session.request('DELETE', `/businesses/${business.id}`, { ifMatch: after.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
  });
});
