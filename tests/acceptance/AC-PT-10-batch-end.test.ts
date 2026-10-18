/**
 * BE-7 PT-3c 批量结束兼职（docs/08_设计/R2-T05_兼职设计.md §4.4 批量结束、§7.2、§7.5 ⑥、§12 A-17、AC-PT-10，PB-26 / 76 / 77 / 78）：
 * POST part-times/batch-end { items: [{ recordId, revision }]（1～200）, endDate }：只有结束日期、直接生效；不用 If-Match，
 * 逐条 revision 锁内比对；重复 recordId（不分大小写）整批 400；整批成功或整批失败，失败时不追加期限、不写审计 / outbox / 操作日志。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { denyAction, denyButton, denyFieldWrite, httpWorld, restricted } from './AC-PT-http-support.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';

const database = useTestDb();

/** 三条兼职（含另一名员工的一条）；各自 start 09-01 / 09-10 / 09-01，结束日 12-31 / 无 / 11-30。 */
async function batchWorld(label: string) {
  const w = await httpWorld(database().db, label);
  const a = await w.make({ endDate: '2026-12-31' });
  const b = await w.make({ startDate: '2026-09-10' });
  const other = await w.colleague('另一名员工');
  const c = await w.ok(
    await w.request('POST', `/employees/${other.id}/part-times`, {
      body: w.body({ endDate: '2026-11-30', partTimeType: 'secondment' }),
    }),
    201,
  );
  const items = [a, b, c].map((record) => ({ recordId: record.id, revision: record.revision }));
  const operationLogs = () =>
    withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{
        behavior: string;
        object_type: string;
        success_count: number;
        items: { objectId: string; employeeId: string; orgId: string }[];
      }>(
        await tx.execute(sql`SELECT behavior, object_type, success_count, items FROM audit_operation_logs
          WHERE tenant_id=${w.tenantId}`),
      ),
    );
  return { w, a, b, c, items, operationLogs };
}

describe('AC-PT-10 批量结束成功路径', () => {
  it('3 条（跨两名员工）→ 200：逐条追加 batch_end 期、同一批次 ID、revision +1；逐条审计；一条对象操作日志（batch_update）', async () => {
    const { w, a, b, c, items, operationLogs } = await batchWorld('batch-ok');
    const result = await w.ok<{
      total: number;
      succeeded: number;
      failed: number;
      items: { id: string; endDate: string; revision: number }[];
    }>(await w.batchEnd(items, '2026-10-15'));
    expect(result).toMatchObject({ total: 3, succeeded: 3, failed: 0 });
    expect(result.items.map((item) => [item.id, item.endDate, item.revision])).toEqual(
      [a, b, c].map((record) => [record.id, '2026-10-15', 2]),
    );
    const batchIds = new Set<string | null>();
    for (const record of [a, b, c]) {
      const terms = await w.terms(record.id);
      expect(terms.map((term) => term.source)).toEqual(['create', 'batch_end']);
      expect(terms[1]!.end_date).toBe('2026-10-15');
      batchIds.add(terms[1]!.source_id);
      expect(await w.headRevision(record.id)).toBe(2);
    }
    expect(batchIds.size).toBe(1);
    expect([...batchIds][0]).not.toBeNull();
    const audits = await withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ object_id: string; org: string }>(
        await tx.execute(sql`SELECT object_id, scope_org_id AS org FROM audit_events
          WHERE tenant_id=${w.tenantId} AND action='employment.part_time.batch_end' ORDER BY object_id`),
      ),
    );
    expect(audits.map((row) => row.object_id)).toEqual([a.id, b.id, c.id].sort());
    expect(new Set(audits.map((row) => row.org))).toEqual(new Set([w.partTimeOrg.id]));
    const logs = await operationLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ behavior: 'batch_update', object_type: 'employment-part-time', success_count: 3 });
    expect(logs[0]!.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectId: a.id, employeeId: w.employeeId, orgId: w.partTimeOrg.id }),
      ]),
    );
  });

  it('结束日在过去 → 任职结束、进“已结束”视图（R2d）；同一条再次批量结束同日（≤ 当前结束日）仍成功', async () => {
    const { w, a, items } = await batchWorld('batch-past');
    await w.ok(await w.batchEnd(items, '2026-09-20'));
    expect(await w.ok(await w.one(a.id))).toMatchObject({ serviceStatus: 'ended', partTimeView: ['ended', 'all'] });
  });
});

describe('整批失败：不追加期限、不写任何审计 / outbox / 操作日志', () => {
  it('PB-26：其中 1 条开始日晚于结束日 → 400 PART_TIME_END_BEFORE_START，逐条回执原因，无写入', async () => {
    const { w, b, items } = await batchWorld('batch-pb26');
    const before = await w.writes();
    const response = await w.batchEnd(items, '2026-09-05');
    expect(response.status).toBe(400);
    const error = (await response.json()) as {
      error: { code: string; details: { reason: string; items: { recordId: string; reason: string }[] } };
    };
    expect(error.error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(error.error.details.reason).toBe('PART_TIME_END_BEFORE_START');
    expect(error.error.details.items).toEqual([{ recordId: b.id, reason: 'PART_TIME_END_BEFORE_START' }]);
    expect(await w.writes()).toEqual(before);
  });

  it('PB-76：其中 1 条 revision 已被他人编辑改变 → 409 REVISION_CONFLICT，detail.items 指出该条，三条都不追加', async () => {
    const { w, b, items } = await batchWorld('batch-pb76');
    expect((await w.edit(b.id, { endDate: '2026-12-01' }, b.revision)).status).toBe(200);
    const before = await w.writes();
    const response = await w.batchEnd(items, '2026-10-15');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'REVISION_CONFLICT', details: { items: [{ recordId: b.id, expected: 1, actual: 2 }] } },
    });
    expect(await w.writes()).toEqual(before);
    const fresh = items.map((item) => (item.recordId === b.id ? { ...item, revision: 2 } : item));
    expect((await w.batchEnd(fresh, '2026-10-15')).status).toBe(200);
  });

  it('PB-77：同一 recordId 出现两次（大小写不同）→ 400 DUPLICATE_RECORD，无写入', async () => {
    const { w, a, items } = await batchWorld('batch-pb77');
    const before = await w.writes();
    const duplicated = [...items, { recordId: a.id.toUpperCase(), revision: a.revision }];
    expect(await w.refusal(await w.batchEnd(duplicated, '2026-10-15'))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      reason: 'DUPLICATE_RECORD',
    });
    expect(await w.writes()).toEqual(before);
  });

  it('PB-78：带 If-Match 头 → 400 VALIDATION_FAILED，无写入', async () => {
    const { w, items } = await batchWorld('batch-pb78');
    const before = await w.writes();
    const failed = await w.refusal(await w.batchEnd(items, '2026-10-15', { ifMatch: 1 }));
    expect(failed).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(await w.writes()).toEqual(before);
  });

  it('T-2：新结束日晚于某条的当前结束日 → 409 PART_TIME_END_AFTER_CURRENT；E-5：含已结束的兼职 → 409 PART_TIME_ALREADY_ENDED', async () => {
    const { w, c, items } = await batchWorld('batch-rules');
    const before = await w.writes();
    expect(await w.refusal(await w.batchEnd(items, '2027-01-31'))).toMatchObject({
      status: 409,
      reason: 'PART_TIME_END_AFTER_CURRENT',
    });
    const ended = await w.ok(await w.edit(c.id, { endDate: '2026-09-20' }, 1));
    const rows = items.map((item) => (item.recordId === c.id ? { ...item, revision: ended.revision } : item));
    const after = await w.writes();
    expect(await w.refusal(await w.batchEnd(rows, '2026-09-15'))).toMatchObject({
      status: 409,
      reason: 'PART_TIME_ALREADY_ENDED',
    });
    expect(await w.writes()).toEqual(after);
    expect(after).not.toEqual(before);
  });

  it('E-4：有未办结的延长 / 结束申请的兼职不能批量结束 → 409 PART_TIME_REQUEST_IN_PROGRESS', async () => {
    const { w, a, items } = await batchWorld('batch-e4');
    await w.seedRequest({ requestType: 'end', recordId: a.id });
    const before = await w.writes();
    expect(await w.refusal(await w.batchEnd(items, '2026-10-15'))).toMatchObject({
      status: 409,
      reason: 'PART_TIME_REQUEST_IN_PROGRESS',
    });
    expect(await w.writes()).toEqual(before);
  });

  it('请求体：0 条 / 超过 200 条 / 未知键 / 非法日期 / 非 UUID / 缺 revision → 400；不存在或不是兼职的 ID → 整批 404', async () => {
    const { w, items } = await batchWorld('batch-schema');
    const before = await w.writes();
    const send = (body: unknown) => w.request('POST', '/part-times/batch-end', { body });
    const record = (n: number) => ({ recordId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, revision: 1 });
    for (const body of [
      { items: [], endDate: '2026-10-15' },
      { items: Array.from({ length: 201 }, (_unused, n) => record(n + 1)), endDate: '2026-10-15' },
      { items, endDate: '2026-10-15', surprise: 1 },
      { items, endDate: '2026-13-01' },
      { items, endDate: null },
      { items: [{ recordId: 'x', revision: 1 }], endDate: '2026-10-15' },
      { items: [{ recordId: items[0]!.recordId }], endDate: '2026-10-15' },
    ])
      expect((await send(body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    const hire = (await w.records(w.employeeId)).find((item) => item.kind === 'hire')!;
    for (const stranger of [record(900), { recordId: hire.id, revision: 1 }])
      expect((await send({ items: [...items, stranger], endDate: '2026-10-15' })).status).toBe(404);
    expect(await w.writes()).toEqual(before);
  });
});

describe('§7.2 批量结束：逐条同编辑，任一条被拒整批不写', () => {
  it('缺 object.update / Employment.PartTimeBatchEnd 按钮 / endDate 字段写权 → 403', async () => {
    const { w, items } = await batchWorld('batch-perm');
    const before = await w.writes();
    const send = (deny: Parameters<typeof restricted>[0]['deny']) =>
      w.as(restricted({ deny }))('POST', '/part-times/batch-end', { body: { items, endDate: '2026-10-15' } });
    expect((await send(denyAction('object.update'))).status).toBe(403);
    expect((await send(denyButton('Employment.PartTimeBatchEnd'))).status).toBe(403);
    expect((await send(denyFieldWrite('endDate'))).status).toBe(403);
    expect(await w.writes()).toEqual(before);
  });

  it('任一条的兼职部门不在范围 → 整批 404 不写；全部在范围放行；空范围 404', async () => {
    const { w, a, items } = await batchWorld('batch-scope');
    const elsewhere = await w.org('他处部门', { establishedOn: '2024-01-01' });
    await w.moveSnapshot(a.id, elsewhere.id);
    const before = await w.writes();
    const send = (who: ReturnType<typeof restricted>) =>
      w.as(who)('POST', '/part-times/batch-end', { body: { items, endDate: '2026-10-15' } });
    expect((await send(restricted({ scope: w.scopeOf(w.partTimeOrg.id) }))).status).toBe(404);
    expect((await send(restricted({ scope: EMPTY_SCOPE }))).status).toBe(404);
    expect(await w.writes()).toEqual(before);
    expect((await send(restricted({ scope: w.scopeOf(w.partTimeOrg.id, elsewhere.id) }))).status).toBe(200);
  });
});
