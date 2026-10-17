/**
 * BE-7 PT-1 兼职契约与数据（docs/08_设计/R2-T05_兼职设计.md §1.1 / §1.2 / §1.4，§9 PB-01～05）。
 * 只用 SQL 与 main 已有的任职读模型断言（不依赖本批新增的 schema 导出），表、约束或触发器缺失时是断言失败。
 * 兼职记录在 PT-3a 之前没有写入口，造数见 AC-PT-support.ts。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { partTimeWorld } from './AC-PT-support.js';

const testDb = useTestDb();
const DENIED = /permission denied/;

describe('BE-7 PT-1 兼职不进主职版本链（§1.1，PB-01 / PB-02 / PB-03）', () => {
  it('PB-01：插入兼职记录（无时间轴行）后提交通过覆盖触发器，主职当前记录与记录列表逐项不变', async () => {
    const w = await partTimeWorld(testDb().db, 'pb01');
    const before = await w.primaryView();
    expect(before.current).toBeTruthy();
    let recordId = '';
    const error = await w.attempt(async (tx) => {
      recordId = await w.insertPartTime(tx);
      await tx.execute(w.term(recordId, 1, '2026-12-31', 'create'));
    });
    expect(error).toBeUndefined();
    expect(await w.primaryView()).toEqual(before);
    // 记录确实落库：任职类型 part_time、没有时间轴行
    const [row] = await withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ service_type: string; kind: string; projected: number }>(
        await tx.execute(sql`SELECT r.service_type, r.kind,
          (SELECT count(*) FROM employment_timeline t WHERE t.tenant_id = r.tenant_id AND t.record_id = r.id)::int
            AS projected
          FROM employment_records r WHERE r.tenant_id = ${w.tenantId} AND r.id = ${recordId}`),
      ),
    );
    expect(row).toEqual({ service_type: 'part_time', kind: 'part_time', projected: 0 });
  });

  it('借调 / 外派同样是非主职记录；同一事务可插多条，主职链仍不变', async () => {
    const w = await partTimeWorld(testDb().db, 'pb01-types');
    const before = await w.primaryView();
    const error = await w.attempt(async (tx) => {
      for (const serviceType of ['part_time', 'secondment', 'expatriate']) {
        const id = await w.insertPartTime(tx, { serviceType });
        await tx.execute(w.term(id, 1, null, 'create'));
      }
    });
    expect(error).toBeUndefined();
    expect(await w.primaryView()).toEqual(before);
  });

  it('PB-02：给兼职记录插时间轴行被 employment_timeline_primary_only 拒绝（23514）', async () => {
    const w = await partTimeWorld(testDb().db, 'pb02');
    let recordId = '';
    expect(
      await w.attempt(async (tx) => {
        recordId = await w.insertPartTime(tx);
      }),
    ).toBeUndefined();
    const error = await w.attempt((tx) =>
      tx.execute(sql`INSERT INTO employment_timeline(tenant_id, employee_id, record_id, staff_id, start_date,
          valid_during, sort_order)
        VALUES (${w.tenantId}, ${w.employeeId}, ${recordId}, ${w.cycle.id}, '2026-09-01',
          daterange('2026-09-01', '2026-09-02', '[)'), 0)`),
    );
    expect(error).toMatch(/^23514 .*employment_timeline_primary_only/);
  });

  it('PB-03：任职类型与业务类型不匹配被 CHECK 拒绝（主职记录不能是 part_time，兼职记录只能是 part_time）', async () => {
    const w = await partTimeWorld(testDb().db, 'pb03');
    const primaryPartTime = await w.attempt((tx) => w.insertPartTime(tx, { serviceType: 'primary' }));
    expect(primaryPartTime).toMatch(/employment_records_service_kind/);
    const partTimeTransfer = await w.attempt((tx) => w.insertPartTime(tx, { kind: 'transfer' }));
    expect(partTimeTransfer).toMatch(/employment_records_service_kind/);
    // 返聘等不在白名单的任职类型（Q-M0-121④）
    const unknown = await w.attempt((tx) => w.insertPartTime(tx, { serviceType: 'rehire' }));
    expect(unknown).toMatch(/employment_records_service_type/);
  });
});

describe('BE-7 PT-1 兼职期限链（§1.2，PB-04 / PB-05）', () => {
  it('PB-04：期限链只追加——app_user 无 UPDATE / DELETE 权限，迁移属主也被只追加触发器拒绝', async () => {
    const w = await partTimeWorld(testDb().db, 'pb04');
    let recordId = '';
    expect(
      await w.attempt(async (tx) => {
        recordId = await w.insertPartTime(tx);
        await tx.execute(w.term(recordId, 1, '2026-12-31', 'create'));
      }),
    ).toBeUndefined();
    const own = sql`tenant_id = ${w.tenantId} AND record_id = ${recordId}`;
    expect(
      await w.attempt((tx) =>
        tx.execute(sql`UPDATE employment_part_time_terms SET end_date = '2027-01-31'
      WHERE ${own}`),
      ),
    ).toMatch(DENIED);
    expect(await w.attempt((tx) => tx.execute(sql`DELETE FROM employment_part_time_terms WHERE ${own}`))).toMatch(
      DENIED,
    );
    const appendOnly = /employment_part_time_terms 只允许追加/;
    expect(await w.asOwner(sql`UPDATE employment_part_time_terms SET end_date = '2027-01-31' WHERE ${own}`)).toMatch(
      appendOnly,
    );
    expect(await w.asOwner(sql`DELETE FROM employment_part_time_terms WHERE ${own}`)).toMatch(appendOnly);
    // 追加下一期照常；同一记录期号唯一
    expect(await w.attempt((tx) => tx.execute(w.term(recordId, 2, '2026-10-15', 'end')))).toBeUndefined();
    expect(await w.attempt((tx) => tx.execute(w.term(recordId, 2, '2026-10-20', 'edit')))).toMatch(
      /employment_part_time_terms_record_term/,
    );
  });

  it('PB-05：人工来源写空区间期（end = start − 1）被拒绝，exit / transfer 允许；更早的结束日一律拒绝', async () => {
    const w = await partTimeWorld(testDb().db, 'pb05');
    let recordId = '';
    expect(
      await w.attempt(async (tx) => {
        recordId = await w.insertPartTime(tx, { startDate: '2026-09-01' });
        await tx.execute(w.term(recordId, 1, null, 'create'));
      }),
    ).toBeUndefined();
    const endDate = /employment_part_time_terms_end_date/;
    for (const source of ['create', 'edit', 'extend', 'end', 'batch_end']) {
      expect(await w.attempt((tx) => tx.execute(w.term(recordId, 2, '2026-08-31', source))), source).toMatch(endDate);
    }
    expect(await w.attempt((tx) => tx.execute(w.term(recordId, 2, '2026-08-30', 'exit')))).toMatch(endDate);
    expect(await w.attempt((tx) => tx.execute(w.term(recordId, 2, '2026-08-31', 'exit')))).toBeUndefined();
    expect(await w.attempt((tx) => tx.execute(w.term(recordId, 3, '2026-08-31', 'transfer')))).toBeUndefined();
    expect(await w.attempt((tx) => tx.execute(w.term(recordId, 4, '2026-09-01', 'edit')))).toBeUndefined();
    expect(await w.attempt((tx) => tx.execute(w.term(recordId, 5, null, 'unknown')))).toMatch(
      /employment_part_time_terms_source/,
    );
  });

  it('期限只能挂在非主职记录上；跨租户看不到', async () => {
    const w = await partTimeWorld(testDb().db, 'terms-guard');
    const other = await partTimeWorld(testDb().db, 'terms-guard-other');
    const primary = await w.primaryView();
    const primaryId = String((primary.current as { id: string }).id);
    expect(await w.attempt((tx) => tx.execute(w.term(primaryId, 1, null, 'create')))).toMatch(
      /employment_part_time_terms_record/,
    );
    let recordId = '';
    expect(
      await w.attempt(async (tx) => {
        recordId = await w.insertPartTime(tx);
        await tx.execute(w.term(recordId, 1, null, 'create'));
      }),
    ).toBeUndefined();
    const probe = sql`SELECT 1 / (SELECT count(*) FROM employment_part_time_terms WHERE record_id = ${recordId})::int`;
    expect(await w.attempt((tx) => tx.execute(probe))).toBeUndefined();
    expect(await w.attempt((tx) => tx.execute(probe), other.tenantId)).toMatch(/division by zero/);
  });
});

describe('BE-7 PT-1 兼职申请三表（§1.4）', () => {
  it('申请头只可改 revision、不可删除；载荷版本与状态事件只追加；状态 / 原因 / 落地记录约束生效', async () => {
    const w = await partTimeWorld(testDb().db, 'requests');
    let recordId = '';
    expect(
      await w.attempt(async (tx) => {
        recordId = await w.insertPartTime(tx);
        await tx.execute(w.term(recordId, 1, '2026-12-31', 'create'));
      }),
    ).toBeUndefined();
    const requestId = randomUUID();
    const versionId = randomUUID();
    const head = (id: string, type: string, record: string | null) =>
      sql`INSERT INTO part_time_requests(id, tenant_id, employee_id, request_type, record_id, initiator,
          initiator_user_id)
        VALUES (${id}, ${w.tenantId}, ${w.employeeId}, ${type}, ${record}, 'hr', ${w.user.id})`;
    const version = (id: string, request: string, endDate: string | null, previous: string | null = null, no = 1) =>
      sql`INSERT INTO part_time_request_versions(id, tenant_id, employee_id, request_id, version_no,
          previous_version_id, command_id, service_type, department_id, start_date, end_date, original_end_date,
          base_term_no)
        VALUES (${id}, ${w.tenantId}, ${w.employeeId}, ${request}, ${no}, ${previous}, ${`pt-v-${id}`}, 'part_time',
          ${null}, '2026-09-01', ${endDate}, '2026-12-31', 1)`;
    const event = (state: string, no: number, reason: string | null = null, record: string | null = null) =>
      sql`INSERT INTO part_time_request_events(tenant_id, employee_id, request_id, version_id, state, event_no,
          command_id, reason, record_id)
        VALUES (${w.tenantId}, ${w.employeeId}, ${requestId}, ${versionId}, ${state}, ${no}, ${`pt-e-${no}`},
          ${reason}, ${record})`;
    expect(
      await w.attempt(async (tx) => {
        await tx.execute(head(requestId, 'end', recordId));
        await tx.execute(version(versionId, requestId, '2026-10-15'));
        await tx.execute(event('draft', 1));
        await tx.execute(event('in_review', 2));
        await tx.execute(event('approved', 3));
        await tx.execute(event('effective', 4, null, recordId));
      }),
    ).toBeUndefined();
    const own = sql`tenant_id = ${w.tenantId} AND id = ${requestId}`;
    expect(await w.attempt((tx) => tx.execute(sql`UPDATE part_time_requests SET revision = 2 WHERE ${own}`))).toBe(
      undefined,
    );
    expect(
      await w.attempt((tx) => tx.execute(sql`UPDATE part_time_requests SET request_type = 'extend' WHERE ${own}`)),
    ).toMatch(DENIED);
    expect(await w.attempt((tx) => tx.execute(sql`DELETE FROM part_time_requests WHERE ${own}`))).toMatch(DENIED);
    expect(await w.asOwner(sql`UPDATE part_time_requests SET request_type = 'extend' WHERE ${own}`)).toMatch(
      /immutable/,
    );
    expect(await w.asOwner(sql`DELETE FROM part_time_requests WHERE ${own}`)).toMatch(/只允许追加/);
    for (const table of ['part_time_request_versions', 'part_time_request_events']) {
      const where = sql`tenant_id = ${w.tenantId} AND request_id = ${requestId}`;
      expect(await w.asOwner(sql`DELETE FROM ${sql.identifier(table)} WHERE ${where}`), table).toMatch(/只允许追加/);
      expect(await w.attempt((tx) => tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE ${where}`))).toMatch(
        DENIED,
      );
    }
    // 申请类型与目标记录：新增不挂记录，延长 / 结束必须挂兼职记录；不能挂主职记录
    const primaryId = String(((await w.primaryView()).current as { id: string }).id);
    expect(await w.attempt((tx) => tx.execute(head(randomUUID(), 'add', recordId)))).toMatch(
      /part_time_requests_record_pair/,
    );
    expect(await w.attempt((tx) => tx.execute(head(randomUUID(), 'extend', null)))).toMatch(
      /part_time_requests_record_pair/,
    );
    expect(await w.attempt((tx) => tx.execute(head(randomUUID(), 'end', primaryId)))).toMatch(
      /part_time_requests_record/,
    );
    expect(await w.attempt((tx) => tx.execute(head(randomUUID(), 'transfer', null)))).toMatch(
      /part_time_requests_type/,
    );
    // 状态事件：作废必须带原因，其余不带；只有 effective 写落地记录
    expect(await w.attempt((tx) => tx.execute(event('voided', 5)))).toMatch(/part_time_request_events_reason/);
    expect(await w.attempt((tx) => tx.execute(event('rejected', 5, 'hr')))).toMatch(/part_time_request_events_reason/);
    expect(await w.attempt((tx) => tx.execute(event('voided', 5, 'unknown')))).toMatch(
      /part_time_request_events_reason/,
    );
    expect(await w.attempt((tx) => tx.execute(event('approved', 5, null, recordId)))).toMatch(
      /part_time_request_events_record/,
    );
    expect(await w.attempt((tx) => tx.execute(event('effective', 5)))).toMatch(/part_time_request_events_record/);
    expect(await w.attempt((tx) => tx.execute(event('voided', 5, 'landing_rejected')))).toBeUndefined();
    expect(await w.attempt((tx) => tx.execute(event('deleted', 5)))).toMatch(/part_time_request_events_request_number/);
    // 载荷版本：结束日不早于开始日（D-1 / T-1 的数据库兜底）
    expect(await w.attempt((tx) => tx.execute(version(randomUUID(), requestId, '2026-08-31', versionId, 2)))).toMatch(
      /part_time_request_versions_end_date/,
    );
  });
});
