/**
 * BE-7 PT-5 兼职详情的期限链与申请历史（docs/08_设计/R2-T05_兼职设计.md §6.3 / §1.2，AC-PT-06）：GET part-times/:recordId 在 PT-3b 的
 * 当前字段之外，加期限链（按 term_no 升序，每期结束日、来源、创建时间、申请链接；“变更前”一律取上一期，不建列）和申请历史
 * （以该记录为目标的延长 / 结束申请 ∪ 产生该记录的新增申请，每条类型 / 状态 / 原定 / 申请结束日）。申请链接与历史条目只对
 * 按 §6.2 同一谓词可见的操作人给出，字段逐层按字段权裁剪（无权缺席）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { restricted } from './AC-PT-http-support.js';
import { viewsWorld } from './AC-PT-views-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();

interface Chain {
  endDate: string | null;
  terms?: {
    termNo: number;
    endDate: string | null;
    source: string;
    createdAt: string;
    requestId?: string;
    previous: { termNo: number; endDate: string | null } | null;
  }[];
  requests: {
    id: string;
    kind: string;
    status: string;
    initiator: string;
    createdAt: string;
    endDate: string | null;
    originalEndDate?: string | null;
  }[];
}

/**
 * 记录 R：新增申请落地（第 1 期 create，结束日 10-31）→ 延长申请落地（12-31）→ 直接编辑（2027-01-31）→ 批量结束（11-30）→
 * 结束申请落地（11-20）；另有一张驳回的延长申请。新增申请的兼职部门与记录当前部门不同。
 */
async function setup(label: string) {
  const w = await viewsWorld(database().db, label);
  const recordId = await withTenant(w.db, w.tenantId, (tx) => w.insertPartTime(tx, { startDate: '2026-09-01' }));
  const elsewhere = await w.org(`新增申请部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
  const landed = { state: 'effective', effectiveRecordId: recordId, recordId } as const;
  const add = await w.seedRequest({
    requestType: 'add',
    state: 'effective',
    effectiveRecordId: recordId,
    departmentId: elsewhere.id,
    endDate: '2026-10-31',
  });
  const extend = await w.seedRequest({
    requestType: 'extend',
    ...landed,
    endDate: '2026-12-31',
    originalEndDate: '2026-10-31',
  });
  const rejected = await w.seedRequest({
    requestType: 'extend',
    state: 'rejected',
    recordId,
    endDate: '2027-06-30',
    originalEndDate: '2027-01-31',
  });
  const ending = await w.seedRequest({
    requestType: 'end',
    ...landed,
    endDate: '2026-11-20',
    originalEndDate: '2026-11-30',
  });
  const batchId = randomUUID();
  const chain: [number, string, string, string | null][] = [
    [1, '2026-10-31', 'create', add],
    [2, '2026-12-31', 'extend', extend],
    [3, '2027-01-31', 'edit', null],
    [4, '2026-11-30', 'batch_end', batchId],
    [5, '2026-11-20', 'end', ending],
  ];
  await withTenant(w.db, w.tenantId, async (tx) => {
    for (const [no, end, source, sourceId] of chain)
      await tx.execute(sql`INSERT INTO employment_part_time_terms(tenant_id, employee_id, record_id, term_no,
          end_date, source, source_id, command_id)
        VALUES (${w.tenantId}, ${w.employeeId}, ${recordId}, ${no}, ${end}, ${source}, ${sourceId},
          ${`chain-${randomUUID()}`})`);
  });
  return { w, recordId, add, extend, rejected, ending, elsewhere };
}

describe('GET part-times/:recordId 期限链', () => {
  it('按期号升序列出结束日、来源、时间；变更前取上一期（第 1 期为 null）；当前字段不变', async () => {
    const { w, recordId } = await setup('chain-terms');
    const detail = await w.ok<Chain & { revision: number; serviceStatus: string }>(await w.one(recordId));
    expect(detail).toMatchObject({ id: recordId, endDate: '2026-11-20', serviceStatus: 'serving', revision: 1 });
    const terms = detail.terms!;
    expect(terms.map((term) => [term.termNo, term.source, term.endDate])).toEqual([
      [1, 'create', '2026-10-31'],
      [2, 'extend', '2026-12-31'],
      [3, 'edit', '2027-01-31'],
      [4, 'batch_end', '2026-11-30'],
      [5, 'end', '2026-11-20'],
    ]);
    expect(terms[0]!.previous).toBeNull();
    expect(terms.slice(1).map((term) => term.previous)).toEqual([
      { termNo: 1, endDate: '2026-10-31' },
      { termNo: 2, endDate: '2026-12-31' },
      { termNo: 3, endDate: '2027-01-31' },
      { termNo: 4, endDate: '2026-11-30' },
    ]);
    expect(terms.every((term) => typeof term.createdAt === 'string')).toBe(true);
  });

  it('来自申请的期带申请链接；直接编辑与批次来源没有链接', async () => {
    const { w, recordId, add, extend, ending } = await setup('chain-links');
    const terms = (await w.ok<Chain>(await w.one(recordId))).terms!;
    expect(terms.map((term) => term.requestId)).toEqual([add, extend, undefined, undefined, ending]);
    expect(terms[2]).not.toHaveProperty('requestId');
    expect(terms[3]).not.toHaveProperty('requestId');
  });

  it('没有申请的直接新增：期限链只有第 1 期 create，无申请历史', async () => {
    const w = await viewsWorld(database().db, 'chain-direct');
    const created = await w.make({ endDate: '2026-12-31' });
    const detail = await w.ok<Chain>(await w.one(created.id));
    expect(detail.terms).toEqual([
      expect.objectContaining({ termNo: 1, source: 'create', endDate: '2026-12-31', previous: null }),
    ]);
    expect(detail.terms![0]).not.toHaveProperty('requestId');
    expect(detail.requests).toEqual([]);
  });
});

describe('GET part-times/:recordId 申请历史', () => {
  it('= 目标为该记录的全部延长 / 结束申请 ∪ 产生该记录的新增申请，带类型 / 状态 / 原定 / 申请结束日，按发起时间升序', async () => {
    const { w, recordId, add, extend, rejected, ending } = await setup('chain-requests');
    const { requests } = await w.ok<Chain>(await w.one(recordId));
    expect(requests.map((request) => request.id)).toEqual([add, extend, rejected, ending]);
    const row = (id: string) => requests.find((request) => request.id === id)!;
    expect(row(add)).toMatchObject({ kind: 'add', status: 'effective', endDate: '2026-10-31', originalEndDate: null });
    expect(row(extend)).toMatchObject({ kind: 'extend', status: 'effective', endDate: '2026-12-31' });
    expect(row(extend).originalEndDate).toBe('2026-10-31');
    expect(row(rejected)).toMatchObject({ kind: 'extend', status: 'rejected', endDate: '2027-06-30' });
    expect(row(ending)).toMatchObject({ kind: 'end', status: 'effective', endDate: '2026-11-20' });
    expect(row(ending).originalEndDate).toBe('2026-11-30');
    expect(requests.every((request) => request.initiator === 'hr' && typeof request.createdAt === 'string')).toBe(true);
  });

  it('其他员工、其他记录的申请不进历史', async () => {
    const { w, recordId } = await setup('chain-isolation');
    const other = await w.seedPartTime({ startDate: '2026-09-01', endDate: null });
    await w.seedRequest({ requestType: 'extend', recordId: other, endDate: '2026-12-31' });
    const { requests } = await w.ok<Chain>(await w.one(recordId));
    expect(requests).toHaveLength(4);
  });
});

describe('可见性与字段权', () => {
  it('申请对操作人不可见（按 §6.2 同一谓词）：历史里不出现，期限链上也不给申请链接', async () => {
    const { w, recordId, add, extend, rejected, ending } = await setup('chain-scope');
    // 只管记录当前部门：新增申请的兼职部门在别处、发起人维度不在范围 → 不可见；延长 / 结束取目标记录当前部门 → 可见
    const send = w.as(restricted({ scope: w.scopeOf(w.partTimeOrg.id) }));
    const detail = await w.ok<Chain>(await send('GET', `/part-times/${recordId}`));
    expect(detail.requests.map((request) => request.id)).toEqual([extend, rejected, ending]);
    expect(detail.terms!.map((term) => term.requestId)).toEqual([undefined, extend, undefined, undefined, ending]);
    expect(JSON.stringify(detail)).not.toContain(add);
  });

  it('无权字段缺席：看不到 originalEndDate 的人历史里没有原定结束日；看不到 endDate 的人没有期限链', async () => {
    const { w, recordId } = await setup('chain-fields');
    const base = [
      'id',
      'employeeId',
      'fields',
      'effectiveDate',
      'kind',
      'status',
      'initiator',
      'createdAt',
      'serviceType',
    ];
    const noOriginal = await w.ok<Chain>(
      await w.as(restricted({ fields: [...base, 'endDate'] }))('GET', `/part-times/${recordId}`),
    );
    expect(noOriginal.requests.length).toBe(4);
    expect(noOriginal.requests.every((request) => !('originalEndDate' in request))).toBe(true);
    expect(noOriginal.requests[1]).toHaveProperty('endDate', '2026-12-31');
    expect(noOriginal.terms).toHaveLength(5);
    const noEnd = await w.ok<Chain>(
      await w.as(restricted({ fields: [...base, 'originalEndDate'] }))('GET', `/part-times/${recordId}`),
    );
    expect(noEnd).not.toHaveProperty('terms');
    expect(noEnd).not.toHaveProperty('endDate');
    expect(noEnd.requests.every((request) => !('endDate' in request))).toBe(true);
    expect(noEnd.requests[1]).toHaveProperty('originalEndDate', '2026-10-31');
  });

  it('范围外 / 不存在仍是同一个 404', async () => {
    const { w, recordId } = await setup('chain-404');
    const elsewhere = await w.org(`无关${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    const send = w.as(restricted({ scope: w.scopeOf(elsewhere.id) }));
    expect((await send('GET', `/part-times/${recordId}`)).status).toBe(404);
  });
});
