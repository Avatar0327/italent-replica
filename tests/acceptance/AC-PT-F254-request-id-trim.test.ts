/**
 * F-254（#436 P2-1，DEC-406 后补-权限）：兼职详情 terms[].requestId 按字段查看权裁剪。
 * 申请历史 requests[].id 随任职记录对象的 id 字段权；期限链上的 requestId 是同一个申请 ID，
 * 仅有 endDate 查看权、无 id 查看权的 HR 不得经期限链拿到申请 ID（docs/08_设计/R2-T05_兼职设计.md §6.3 / §7.2）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { restricted } from './AC-PT-http-support.js';
import { viewsWorld } from './AC-PT-views-support.js';

const database = useTestDb();

interface Detail {
  terms?: { termNo: number; endDate: string | null; requestId?: string }[];
  requests: { id?: string }[];
}

/** 记录 R 的第 1 期来自新增申请、第 2 期来自延长申请；两张申请对操作人范围内可见。 */
async function setup(label: string) {
  const w = await viewsWorld(database().db, label);
  const recordId = await withTenant(w.db, w.tenantId, (tx) => w.insertPartTime(tx, { startDate: '2026-09-01' }));
  const landed = { state: 'effective', effectiveRecordId: recordId, recordId } as const;
  const add = await w.seedRequest({
    requestType: 'add',
    state: 'effective',
    effectiveRecordId: recordId,
    endDate: '2026-10-31',
  });
  const extend = await w.seedRequest({
    requestType: 'extend',
    ...landed,
    endDate: '2026-12-31',
    originalEndDate: '2026-10-31',
  });
  await withTenant(w.db, w.tenantId, async (tx) => {
    for (const [no, end, source, sourceId] of [
      [1, '2026-10-31', 'create', add],
      [2, '2026-12-31', 'extend', extend],
    ] as const)
      await tx.execute(sql`INSERT INTO employment_part_time_terms(tenant_id, employee_id, record_id, term_no,
          end_date, source, source_id, command_id)
        VALUES (${w.tenantId}, ${w.employeeId}, ${recordId}, ${no}, ${end}, ${source}, ${sourceId},
          ${`f254-${no}-${recordId}`})`);
  });
  return { w, recordId, add, extend };
}

const WITHOUT_ID = [
  'employeeId',
  'fields',
  'effectiveDate',
  'kind',
  'status',
  'initiator',
  'createdAt',
  'serviceType',
  'endDate',
];

describe('F-254 兼职详情 terms[].requestId 按字段权裁剪', () => {
  it('仅有 endDate 查看权、无申请 ID（id）查看权：期限链仍在，但不带 requestId，响应里也没有申请 ID', async () => {
    const { w, recordId, add, extend } = await setup('f254-no-id');
    const send = w.as(restricted({ fields: WITHOUT_ID }));
    const detail = await w.ok<Detail>(await send('GET', `/part-times/${recordId}`));
    expect(detail.terms!.map((term) => [term.termNo, term.endDate])).toEqual([
      [1, '2026-10-31'],
      [2, '2026-12-31'],
    ]);
    expect(detail.terms!.every((term) => !('requestId' in term))).toBe(true);
    expect(detail.requests.every((request) => !('id' in request))).toBe(true);
    const body = JSON.stringify(detail);
    expect(body).not.toContain(add);
    expect(body).not.toContain(extend);
  });

  it('有申请 ID 查看权：来自申请的期带 requestId，与申请历史同一份 ID', async () => {
    const { w, recordId, add, extend } = await setup('f254-with-id');
    const send = w.as(restricted({ fields: [...WITHOUT_ID, 'id'] }));
    const detail = await w.ok<Detail>(await send('GET', `/part-times/${recordId}`));
    expect(detail.terms!.map((term) => term.requestId)).toEqual([add, extend]);
    expect(detail.requests.map((request) => request.id)).toEqual([add, extend]);
  });
});
