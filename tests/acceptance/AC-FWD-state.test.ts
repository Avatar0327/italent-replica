import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { employmentSession, type EmploymentBusiness, type EmploymentSession } from './AC-EMP-support.js';
import { resultRows } from './AC-ORG-support.js';

const testDb = useTestDb();

async function fixture(db: Db, label: string) {
  const session = await employmentSession(db, label);
  const employee = await session.employee();
  const hire = await session.business(
    employee.id,
    { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { place: '原地点' } },
    employee.revision,
  );
  return { session, employee, hire };
}

async function transition(
  db: Db,
  session: EmploymentSession,
  business: EmploymentBusiness,
  action: 'submit' | 'approve' | 'reject' | 'activate',
  now = '2026-10-01T01:00:00Z',
) {
  const result = await runEmploymentTransition(
    db,
    {
      tenantId: session.tenant.id,
      userId: session.user.id,
      timezone: session.tenant.timezone,
      now: new Date(now),
      commandId: randomUUID(),
      expectedRevision: business.revision,
    },
    { id: business.id, action },
  );
  expect(result.status).toBe(200);
  return result.body as EmploymentBusiness;
}

async function stored(session: EmploymentSession, id: string) {
  const response = await session.request('GET', `/businesses/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as EmploymentBusiness & { fields: Record<string, unknown> };
}

describe('AC-FWD-01/02 状态、周期与并发边界', () => {
  it.each(['draft', 'in_review', 'approved', 'rejected'] as const)(
    '同日%s申请是传播目标，保持原状态并追加payload，早于源日期的申请不变',
    async (state) => {
      const { db } = testDb();
      const { session, employee, hire } = await fixture(db, `fwd-state-${state}`);
      const earlier = await session.business(
        employee.id,
        { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-04', fields: { place: '原地点' } },
        hire.employeeRevision,
      );
      let target = await session.business(
        employee.id,
        { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-05', fields: { place: '原地点' } },
        earlier.employeeRevision,
      );
      if (state !== 'draft') target = await transition(db, session, target, 'submit');
      if (state === 'approved' || state === 'rejected') {
        target = await transition(db, session, target, state === 'approved' ? 'approve' : 'reject');
      }
      expect(target.status).toBe(state);
      const beforeVersion = await withTenant(
        db,
        session.tenant.id,
        async (tx) =>
          resultRows<Record<string, unknown>>(
            await tx.execute(sql`SELECT id,version_no FROM employment_payload_versions
          WHERE tenant_id=${session.tenant.id} AND business_id=${target.id} ORDER BY version_no DESC LIMIT 1`),
          )[0]!,
      );
      const source = await session.business(
        employee.id,
        { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { place: '同步地点' } },
        (await session.getEmployee(employee.id)).revision,
      );
      const changed = await stored(session, target.id);
      expect(changed).toMatchObject({ status: state, revision: target.revision + 1, fields: { place: '同步地点' } });
      expect(changed.record).toBeNull();
      expect((await stored(session, earlier.id)).fields.place).toBe('原地点');
      const latest = await withTenant(db, session.tenant.id, async (tx) =>
        resultRows(
          await tx.execute(sql`SELECT previous_version_id,version_no,trigger_business_id,is_record_snapshot
          FROM employment_payload_versions WHERE tenant_id=${session.tenant.id} AND business_id=${target.id}
          ORDER BY version_no DESC LIMIT 1`),
        ),
      );
      expect(latest).toEqual([
        expect.objectContaining({
          previous_version_id: beforeVersion.id,
          version_no: Number(beforeVersion.version_no) + 1,
          trigger_business_id: source.id,
          is_record_snapshot: false,
        }),
      ]);
    },
  );

  it('仅严格晚于源日期的effective记录传播，同周期同日effective仍按DEC-077返回409', async () => {
    const { db } = testDb();
    const { session, employee, hire } = await fixture(db, 'fwd-effective-after');
    const later = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-09-20' },
      hire.employeeRevision,
    );
    const source = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-10', fields: { place: '同步地点' } },
      later.employeeRevision,
    );
    expect((await session.record(hire.id)).fields.place).toBe('原地点');
    expect((await session.record(later.id)).fields.place).toBe('同步地点');
    const duplicate = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: source.employeeRevision,
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-20', fields: { place: '同日覆盖' } },
    });
    expect(duplicate.status).toBe(409);
    expect((await session.record(later.id)).fields.place).toBe('同步地点');
  });

  it('未来审批通过不传播，按租户日期activate后才同步到更晚任职', async () => {
    const { db } = testDb();
    const { session, employee, hire } = await fixture(db, 'fwd-approval-timing');
    const later = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-10-10' },
      hire.employeeRevision,
    );
    const draft = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-05', fields: { place: '到期地点' } },
      later.employeeRevision,
    );
    const reviewing = await transition(db, session, draft, 'submit');
    const approved = await transition(db, session, reviewing, 'approve');
    expect(approved.status).toBe('approved');
    expect((await session.record(later.id)).fields.place).toBe('原地点');
    // 上海已到10月5日，UTC仍是10月4日；DEC-056要求按租户日期执行。
    const activated = await transition(db, session, approved, 'activate', '2026-10-04T16:00:00Z');
    expect(activated.status).toBe('effective');
    expect((await session.record(later.id)).fields.place).toBe('到期地点');
  });

  it('DEC-077同日退休返聘不跨StaffID，Q-M0-26旧周期补录也不传播', async () => {
    const { db } = testDb();
    const { session, employee, hire } = await fixture(db, 'fwd-cycle-boundary');
    const firstLater = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-09-10' },
      hire.employeeRevision,
    );
    const retired = await session.business(
      employee.id,
      { kind: 'retirement', mode: 'direct', lastWorkDate: '2026-09-19' },
      firstLater.employeeRevision,
    );
    const rehire = await session.business(
      employee.id,
      { kind: 'retire_rehire', mode: 'direct', effectiveDate: '2026-09-20', fields: { place: '原地点' } },
      retired.employeeRevision,
    );
    const later = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-09-28' },
      rehire.employeeRevision,
    );
    const oldBackfill = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-05', fields: { place: '旧周期更正' } },
      later.employeeRevision,
    );
    expect((await session.record(firstLater.id)).fields.place).toBe('原地点');
    expect((await session.record(retired.id)).fields.place).toBe('原地点');
    expect((await session.record(rehire.id)).fields.place).toBe('原地点');
    expect((await session.record(later.id)).fields.place).toBe('原地点');
    await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-25', fields: { place: '新周期更正' } },
      oldBackfill.employeeRevision,
    );
    expect((await session.record(later.id)).fields.place).toBe('新周期更正');
    expect((await session.record(retired.id)).fields.place).toBe('原地点');
    expect(retired.record!.staffId).not.toBe(rehire.record!.staffId);
    expect(
      (await session.records(employee.id)).filter((record) => record.isCurrent).map((record) => record.id),
    ).toEqual([later.id]);
  });

  it('两笔不同业务并发批准，传播与另一业务生效串行一致；过期目标显式刷新重提不丢更新', async () => {
    const { db } = testDb();
    const { session, employee, hire } = await fixture(db, 'fwd-concurrent-approval');
    const sourceDraft = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-09-10', fields: { place: '并发同步地点' } },
      hire.employeeRevision,
    );
    const laterDraft = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'application', effectiveDate: '2026-09-20', fields: { place: '原地点' } },
      sourceDraft.employeeRevision,
    );
    const source = await transition(db, session, sourceDraft, 'submit');
    const later = await transition(db, session, laterDraft, 'submit');
    const results = await Promise.allSettled([
      transition(db, session, source, 'approve'),
      transition(db, session, later, 'approve'),
    ]);
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'REVISION_CONFLICT' });
        const original = index === 0 ? source : later;
        const refreshed = await stored(session, original.id);
        expect(refreshed.status).toBe('in_review');
        await transition(db, session, refreshed, 'approve');
      }
    }
    expect((await stored(session, source.id)).status).toBe('effective');
    expect((await stored(session, later.id)).status).toBe('effective');
    expect((await session.record(later.id)).fields.place).toBe('并发同步地点');
    const records = await session.records(employee.id);
    expect(records).toHaveLength(3);
    expect(records.filter((record) => record.isCurrent).map((record) => record.id)).toEqual([later.id]);
    const projected = await withTenant(db, session.tenant.id, async (tx) =>
      resultRows(
        await tx.execute(sql`SELECT record_id FROM employment_timeline
        WHERE tenant_id=${session.tenant.id} AND employee_id=${employee.id}
          AND valid_during @> '2026-10-01'::date`),
      ),
    );
    expect(projected).toEqual([{ record_id: later.id }]);
  });
});
