import './support/exit-gate-enforced.js';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { forwardJobApi } from './AC-FWD-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { hire, pbWorld, regularizeAt, rescheduleRegularization, transferAt } from './AC-PB-support.js';
import { httpWorld } from './AC-PT-http-support.js';
import { retirementWorld } from './AC-RT-support.js';

const database = useTestDb();

function history(db: Db, tenantId: string, businessId: string) {
  return withTenant(db, tenantId, async (tx) =>
    resultRows<{
      version: number;
      date: string;
      explicit: string[];
      deferred: string[];
      sequence: string | null;
      origins: { field: string; kind: string; value: unknown; sourceRecord: string | null }[];
    }>(
      await tx.execute(sql`
        SELECT p.version_no AS version, p.effective_date::text AS date, p.explicit_field_codes AS explicit,
               p.deferred_field_codes AS deferred, p.sequence_id AS sequence,
               COALESCE(jsonb_agg(jsonb_build_object('field', o.field_code, 'kind', o.origin_kind, 'value', o.value,
                 'sourceRecord', o.source_record_id) ORDER BY o.seq) FILTER (WHERE o.id IS NOT NULL), '[]') AS origins
        FROM employment_payload_versions p LEFT JOIN employment_field_origins o
         ON o.tenant_id=p.tenant_id AND o.payload_version_id=p.id
        WHERE p.tenant_id=${tenantId} AND p.business_id=${businessId}
        GROUP BY p.id, p.version_no ORDER BY p.version_no`),
    ),
  );
}

const markers = <T extends { origins: unknown; sequence: string | null }>(rows: readonly T[]) =>
  rows.map(({ origins: _origins, sequence: _sequence, ...row }) => row);

it.each(['approved', 'effective'] as const)('AC-EMP-25/26 #13：%s 离职改期只记录独立业务日期', async (state) => {
  const { db } = database();
  const x = await downstreamWorld(db, `f036s3-exit-plan-${state}`);
  const leave = await x.directLeave('2026-10-15');
  if (state === 'effective')
    expect(await x.runScheduler('2026-10-16T02:00:00Z')).toMatchObject({ activated: [leave.id] });
  x.setNow(state === 'effective' ? '2026-11-05T02:00:00Z' : '2026-10-08T02:00:00Z');
  const response = await x.session.request('PATCH', `/exits/${leave.id}`, {
    ifMatch: (await x.business(leave.id)).revision,
    body: { lastWorkDate: '2026-10-25' },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const rows = await history(db, x.session.tenant.id, leave.id);
  expect(markers(rows)).toEqual([
    { version: 1, date: '2026-10-16', explicit: [], deferred: [] },
    { version: 2, date: '2026-10-26', explicit: [], deferred: [] },
  ]);
  expect(rows[1]!.origins).toEqual([
    { field: 'preset:effectiveDate', kind: 'hr-input', value: '2026-10-26', sourceRecord: null },
    { field: 'preset:lastWorkDate', kind: 'hr-input', value: '2026-10-25', sourceRecord: null },
  ]);
});

it('AC-EMP-25/26 #13：真实退休审批令等待返聘顺延，只记录返聘生效日', async () => {
  const { db } = database();
  const x = await retirementWorld(db, 'f036s3-rehire-plan', '2026-10-20');
  const { session, employee } = x;
  const retirement = await x.atDay('2026-10-06', () => x.submittedRetire('2026-10-15'));
  const rehire = await x.atDay('2026-10-06', async () =>
    session.business(
      employee.id,
      { kind: 'retire_rehire', mode: 'application', effectiveDate: '2026-10-18', fields: { employType: 'internal' } },
      (await session.getEmployee(employee.id)).revision,
    ),
  );
  await x.atDay('2026-10-06', async () => {
    const sent = await session.request('POST', `/businesses/${rehire.id}/submit`, {
      ifMatch: rehire.revision,
      body: {},
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
  });
  await x.approveInReview(rehire.id);
  await x.approveInReview(retirement.id);
  const rows = await history(db, session.tenant.id, rehire.id);
  expect(markers(rows)).toEqual([
    { version: 1, date: '2026-10-18', explicit: ['preset:employType'], deferred: [] },
    { version: 2, date: '2026-10-21', explicit: ['preset:employType'], deferred: [] },
  ]);
  expect(rows[1]!.origins).toEqual([
    { field: 'preset:effectiveDate', kind: 'system-input', value: '2026-10-21', sourceRecord: null },
  ]);
});

it('AC-EMP-25/26 #14：转正人工计划版沿用，重排快照记录新前驱', async () => {
  const { db } = database();
  const world = await pbWorld(db, 'f036s3-probation-move');
  const { employee } = await hire(world, { months: 3 });
  const id = await regularizeAt(world, employee.id, '2026-11-01');
  const transfer = await transferAt(world, employee.id, '2026-11-15', { place: '十一月地点' });
  const response = await rescheduleRegularization(world, id, '2026-12-01');
  expect(response.status, await response.clone().text()).toBe(200);
  const rows = await history(db, world.session.tenant.id, id);
  expect(markers(rows)).toEqual([
    { version: 1, date: '2026-11-01', explicit: [], deferred: [] },
    { version: 2, date: '2026-12-01', explicit: [], deferred: [] },
    { version: 3, date: '2026-12-01', explicit: [], deferred: [] },
  ]);
  expect(rows[1]!.origins).toEqual([]);
  expect(rows[2]!.origins.filter(({ field }) => field === 'preset:place')).toEqual([
    { field: 'preset:place', kind: 'inherit', value: '十一月地点', sourceRecord: transfer.id },
  ]);
  expect((await world.session.record(id, '2026-12-01')).fields.place).toBe('十一月地点');
});

it('AC-EMP-25/26 #15：HTTP 创建兼职，对填写值记录来源且保留基线标记', async () => {
  const { db } = database();
  const x = await httpWorld(db, 'f036s3-part-time');
  const post = await forwardJobApi(db, x).create('posts');
  const filled = await x.customField('text');
  const omitted = await x.customField('text');
  const record = await x.make({ fields: { postId: post.id }, customFields: { [filled]: '兼职填写项' } });
  const rows = await history(db, x.tenantId, record.id);
  expect(markers(rows)).toEqual([
    {
      version: 1,
      date: '2026-09-01',
      explicit: ['preset:departmentId', 'preset:postId', `custom:${filled}`],
      deferred: [],
    },
  ]);
  expect(rows[0]!.origins.filter(({ kind }) => kind === 'hr-input')).toEqual([
    { field: 'preset:departmentId', kind: 'hr-input', value: x.partTimeOrg.id, sourceRecord: null },
    { field: 'preset:postId', kind: 'hr-input', value: post.id, sourceRecord: null },
    { field: `custom:${filled}`, kind: 'hr-input', value: '兼职填写项', sourceRecord: null },
  ]);
  expect(rows[0]!.origins).toEqual(
    expect.arrayContaining([
      { field: 'preset:positionId', kind: 'none', value: null, sourceRecord: null },
      { field: `custom:${filled}`, kind: 'none', value: null, sourceRecord: null },
      { field: `custom:${omitted}`, kind: 'none', value: null, sourceRecord: null },
    ]),
  );
});

it('AC-EMP-26：只改生效日保留两列与带出的序列，审批到期后序列落地', async () => {
  const { db } = database();
  const x = await downstreamWorld(db, 'f036s3-date-only');
  const { session, employee } = x;
  const jobs = forwardJobApi(db, session);
  const sequence = await jobs.create('sequences');
  const post = await jobs.create('posts', { sequenceId: sequence.id });
  const draft = await session.business(
    employee.id,
    {
      kind: 'transfer',
      mode: 'application',
      effectiveDate: '2026-11-01',
      fields: { departmentId: x.to.id, postId: post.id },
    },
    (await session.getEmployee(employee.id)).revision,
  );
  const date = '2026-11-03';
  const moved = await session.request('PATCH', `/businesses/${draft.id}`, {
    ifMatch: draft.revision,
    body: { effectiveDate: date },
  });
  expect(moved.status, await moved.clone().text()).toBe(200);
  const saved = await x.business(draft.id);
  expect(saved).toMatchObject({ effectiveDate: date, fields: { postId: post.id, sequenceId: sequence.id } });
  const explicit = ['preset:departmentId', 'preset:postId'];
  const rows = await history(db, session.tenant.id, draft.id);
  expect(markers(rows)).toEqual([
    { version: 1, date: '2026-11-01', explicit, deferred: [] },
    { version: 2, date, explicit, deferred: [] },
  ]);
  expect(rows.map(({ sequence: savedSequence }) => savedSequence)).toEqual([sequence.id, sequence.id]);
  const sent = await session.request('POST', `/businesses/${draft.id}/submit`, {
    ifMatch: saved.revision,
    body: {},
  });
  expect(sent.status, await sent.clone().text()).toBe(200);
  await x.approveInReview(draft.id);
  expect(await x.runScheduler(`${date}T02:00:00Z`)).toMatchObject({ activated: [draft.id], failed: [], errors: [] });
  expect((await session.record(draft.id, date)).fields).toMatchObject({ postId: post.id, sequenceId: sequence.id });
});
