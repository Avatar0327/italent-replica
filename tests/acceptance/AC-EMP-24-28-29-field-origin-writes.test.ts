import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { addPending, entryAction, entryWorld } from './AC-EN-BE2a-support.js';
import { forwardFixture, forwardJobApi } from './AC-FWD-support.js';
import { scenario, worker } from './AC-JOB-sequence-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { httpWorld } from './AC-PT-http-support.js';
import { activationWorld } from './AC-TRF-activation-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const intent = 'employment.record.intent_confirmed';
const forward = 'employment.forward-update';

interface Origin {
  field: string;
  kind: string;
  value: unknown;
  hasValue: boolean;
  record: string | null;
  source: string | null;
  sourceVersion: number | null;
  matchBefore: unknown;
  rule: string | null;
  reference: string | null;
}

function evidence(db: Db, tenantId: string, businessId: string, action = forward) {
  return withTenant(db, tenantId, async (tx) => {
    const versions = resultRows<{ version: number; origins: Origin[] }>(
      await tx.execute(sql`
        SELECT p.version_no AS version, COALESCE(jsonb_agg(jsonb_build_object(
          'field', o.field_code, 'kind', o.origin_kind, 'value', o.value, 'hasValue', o.value IS NOT NULL,
          'record', o.record_id, 'source', o.source_business_id, 'sourceVersion', o.source_version_no,
          'matchBefore', o.match_before, 'rule', o.derivation_rule, 'reference', o.reference_id
        ) ORDER BY o.seq) FILTER (WHERE o.id IS NOT NULL), '[]'::jsonb) AS origins
        FROM employment_payload_versions p LEFT JOIN employment_field_origins o
          ON o.tenant_id = p.tenant_id AND o.payload_version_id = p.id
        WHERE p.tenant_id = ${tenantId} AND p.business_id = ${businessId}
        GROUP BY p.id, p.version_no ORDER BY p.version_no`),
    );
    const audits = resultRows<{ objectType: string }>(
      await tx.execute(sql`SELECT object_type AS "objectType" FROM audit_events
        WHERE tenant_id = ${tenantId} AND object_id = ${businessId} AND action = ${action}`),
    );
    const events = resultRows<{ version: number; payload: unknown }>(
      await tx.execute(sql`SELECT p.version_no AS version, o.payload
        FROM employment_outbox o LEFT JOIN employment_payload_versions p
          ON p.tenant_id = o.tenant_id AND p.id = o.payload_version_id
        WHERE o.tenant_id = ${tenantId} AND o.business_id = ${businessId} AND o.event_type = ${action}`),
    );
    return { versions, audits, events };
  });
}

const row = (field: string, kind: string, value: unknown, extra: Partial<Origin> = {}) =>
  expect.objectContaining({ field, kind, value, hasValue: true, ...extra });

async function ok(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
}

async function revisionOf(response: Response) {
  await ok(response);
  return ((await response.json()) as { revision: number }).revision;
}

describe('AC-EMP-24 任职字段来源写点 #5～#10', () => {
  it('记录 PATCH 的职务与带出序列分别入账，后续目标仅记录实际值匹配和连带派生', async () => {
    const { db } = database();
    const { session, employee, org, hired } = await forwardFixture(db, 'f036-s2-edit');
    const jobs = forwardJobApi(db, session);
    const oldSequence = await jobs.create('sequences');
    const newSequence = await jobs.create('sequences');
    const otherSequence = await jobs.create('sequences');
    const oldPost = await jobs.create('posts', { sequenceId: oldSequence.id });
    const newPost = await jobs.create('posts', { sequenceId: newSequence.id });
    const current = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-02', fields: { postId: oldPost.id } },
      hired.employeeRevision,
    );
    const future = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-11-01' },
      current.employeeRevision,
    );
    const independent = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-11-15', fields: { sequenceId: otherSequence.id } },
      future.employeeRevision,
    );
    await ok(
      await session.request('PATCH', `/records/${current.id}`, {
        ifMatch: current.revision,
        body: { fields: { postId: newPost.id, departmentId: org.id } },
      }),
    );
    expect((await session.record(future.id)).fields).toMatchObject({ postId: newPost.id, sequenceId: newSequence.id });
    expect((await session.record(independent.id)).fields).toMatchObject({
      postId: newPost.id,
      sequenceId: otherSequence.id,
    });
    const read = (id: string) => evidence(db, session.tenant.id, id);
    const edited = await read(current.id);
    expect(edited.versions.map(({ version }) => version)).toEqual([1, 2]);
    expect.soft(edited.versions[1]?.origins).toEqual([
      row('preset:postId', 'hr-record', newPost.id, { record: current.id }),
      row('preset:sequenceId', 'derive-edit', newSequence.id, {
        rule: 'post-sequence',
        reference: newPost.id,
        source: current.id,
      }),
      row('preset:departmentId', 'hr-record', org.id, { record: current.id }),
    ]);
    const propagated = await read(future.id);
    expect(propagated.versions.map(({ version }) => version)).toEqual([1, 2]);
    expect.soft(propagated.versions[1]?.origins).toEqual([
      row('preset:postId', 'forward-update', newPost.id, {
        record: future.id,
        source: current.id,
        sourceVersion: 2,
        matchBefore: oldPost.id,
      }),
      row('preset:sequenceId', 'forward-update', newSequence.id, {
        source: current.id,
        sourceVersion: 2,
        matchBefore: oldSequence.id,
      }),
      row('preset:sequenceId', 'derive-edit', newSequence.id, {
        source: current.id,
        rule: 'post-sequence',
        reference: newPost.id,
      }),
    ]);
    expect((await read(independent.id)).versions[1]?.origins).toEqual([
      row('preset:postId', 'forward-update', newPost.id, {
        source: current.id,
        sourceVersion: 2,
        matchBefore: oldPost.id,
      }),
    ]);
  });

  it('导入编辑显式清空工作地并传播到在途草稿，来源业务和记录关联正确', async () => {
    const { db } = database();
    const { session, employee, hired } = await forwardFixture(db, 'f036-s2-import');
    const draft = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-11-01' },
      hired.employeeRevision,
    );
    await ok(
      await session.request('POST', `/employees/${employee.id}/import`, {
        ifMatch: (await session.getEmployee(employee.id)).revision,
        body: {
          items: [{ operation: 'edit', id: hired.id, revision: hired.revision, patch: { fields: { place: null } } }],
        },
      }),
    );
    const read = (id: string) => evidence(db, session.tenant.id, id);
    expect((await read(hired.id)).versions[1]?.origins).toEqual([
      row('preset:place', 'hr-record', null, { record: hired.id }),
    ]);
    expect((await read(draft.id)).versions[1]?.origins).toEqual([
      row('preset:place', 'forward-update', null, {
        record: null,
        source: hired.id,
        sourceVersion: 2,
        matchBefore: '原地点',
      }),
    ]);
  });

  it('办理入职与转正的后续传播只写人员状态，来源自身状态与预置字段隔离', async () => {
    const { db } = database();
    const w = await entryWorld(db, 'f036-s2-status');
    const { session } = w;
    const { employee, recordId, business } = await addPending(w, '2026-09-01');
    const later = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-11-01', fields: { place: '未来地点' } },
      business.employeeRevision,
    );
    await ok(await entryAction(w, recordId, 'complete', { probation: true }));
    const regularization = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-10-01' },
      (await session.getEmployee(employee.id)).revision,
    );
    expect(await session.record(later.id)).toMatchObject({ employeeStatus: 3 });
    const completed = await evidence(db, session.tenant.id, recordId);
    expect
      .soft(completed.versions[1]?.origins)
      .toEqual([row('status:employeeStatus', 'system-input', 2, { record: recordId })]);
    const received = await evidence(db, session.tenant.id, later.id);
    expect(received.versions.map(({ version }) => version)).toEqual([1, 2, 3]);
    expect
      .soft(received.versions[1]?.origins)
      .toEqual([row('status:employeeStatus', 'status-propagate', 2, { record: later.id, source: recordId })]);
    expect(received.versions[2]?.origins).toEqual([
      row('status:employeeStatus', 'status-propagate', 3, { record: later.id, source: regularization.id }),
    ]);
  });

  it('到期调动的负责人联动单独标记系统来源', async () => {
    const { db } = database();
    const w = await activationWorld(db, 'f036-s2-linkage');
    const { employee, hire } = await w.hired('负责人');
    const source = await w.session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-10-10',
        fields: { departmentId: w.to.id, isDepartmentHead: true },
      },
      hire.employeeRevision,
    );
    const later = await w.session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-11-01',
        fields: { departmentId: w.to.id, isDepartmentHead: false },
      },
      source.employeeRevision,
    );
    const result = await w.runScheduler('2026-10-10T01:00:00Z');
    expect(result.errors).toEqual([]);
    expect(result.failed).toEqual([]);
    expect((await w.session.record(later.id)).fields.isDepartmentHead).toBe(true);
    const audit = await evidence(db, w.session.tenant.id, later.id);
    expect(audit.versions.at(-1)?.origins).toEqual([
      row('preset:isDepartmentHead', 'system-input', true, { record: later.id, source: source.id }),
    ]);
  });

  it.each(['posts', 'positions'] as const)('%s 序列同步只写序列并携带实际引用', async (kind) => {
    const { db } = database();
    const s = await scenario(db, kind);
    const read = () => evidence(db, s.world.tenant.id, s.current.id, 'employment.sequence-sync');
    const before = await read();
    await ok(
      await s.call(
        'PATCH',
        `${kind}/${s.target.id}`,
        { sequenceId: s.nextSequence.id, effectiveDate: '2026-10-05' },
        1,
      ),
    );
    await worker(db, s.world.tenant.id);
    // 显式同步接口从被改回旧序列的真实记录重新取候选，不沿用保存职位时排入的任务。
    await ok(
      await s.world.request('PATCH', `/records/${s.current.id}`, {
        ifMatch: await revisionOf(await s.world.request('GET', `/businesses/${s.current.id}`)),
        body: { fields: { sequenceId: s.oldSequence.id } },
      }),
    );
    const reset = await read();
    await ok(await s.call('POST', `${kind}/sync-sequence`, { items: [{ id: s.target.id, revision: 2 }] }), 202);
    await worker(db, s.world.tenant.id);
    const synced = await read();
    expect(synced.versions).toHaveLength(reset.versions.length + 1);
    expect(synced.audits).toHaveLength(reset.audits.length + 1);
    expect(synced.versions.at(-1)?.origins).toEqual([
      row('preset:sequenceId', 'sequence-sync', s.nextSequence.id, {
        rule: kind === 'posts' ? 'post-sequence' : 'position-sequence',
        reference: s.target.id,
        record: s.current.id,
      }),
    ]);
    expect(synced.versions.length).toBeGreaterThan(before.versions.length);
    await worker(db, s.world.tenant.id);
    expect(await read()).toEqual(synced);
  });
});

async function editFixture(label: string, mode: 'application' | 'direct' = 'application') {
  const { db } = database();
  const { session, employee, hired } = await forwardFixture(db, label);
  const current = await session.business(
    employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-20' },
    hired.employeeRevision,
  );
  const later = await session.business(
    employee.id,
    { kind: 'transfer', mode, effectiveDate: '2026-11-01' },
    current.employeeRevision,
  );
  const read = (id: string, action?: string) => evidence(db, session.tenant.id, id, action);
  return { session, current, later, read };
}

async function manualPostFixture(label: string) {
  const { db } = database();
  const { session, employee, hired } = await forwardFixture(db, label);
  const jobs = forwardJobApi(db, session);
  const defaultSequence = await jobs.create('sequences');
  const manualSequence = await jobs.create('sequences');
  const post = await jobs.create('posts', { sequenceId: defaultSequence.id });
  const fields = { postId: post.id, sequenceId: manualSequence.id };
  const current = await session.business(
    employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-20', fields },
    hired.employeeRevision,
  );
  const future = await session.business(
    employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-11-01' },
    current.employeeRevision,
  );
  expect(await session.record(current.id)).toMatchObject({ fields });
  expect(await session.record(future.id)).toMatchObject({ fields });
  const read = (id: string, action?: string) => evidence(db, session.tenant.id, id, action);
  return { session, current, future, post, fields, read };
}

it('AC-EMP-28 同值职务保留人工序列，只确认职务且未来任职零写入', async () => {
  const { session, current, future, post, fields, read } = await manualPostFixture('f036-s2-r1-same-post');
  const futureBefore = await read(future.id);
  const currentBefore = await read(current.id, intent);
  const body = { fields: { postId: post.id } };
  const preview = await session.request('POST', `/records/${current.id}/forward-update-preview`, { body });
  await ok(preview);
  expect.soft(await preview.json(), '同值职务的预览没有传播目标').toMatchObject({ changes: [] });

  const response = await session.request('PATCH', `/records/${current.id}`, { ifMatch: current.revision, body });
  await ok(response);
  expect.soft(await response.json(), '当前序列和 revision 保持原值').toMatchObject({ fields, revision: 1 });
  expect.soft(await session.record(current.id), '实际保存的当前序列和 revision 保持原值').toMatchObject({
    fields,
    revision: 1,
  });
  const currentAfter = await read(current.id, intent);
  expect.soft(currentAfter.versions, '当前记录无新载荷版本').toHaveLength(1);
  expect.soft(currentAfter.versions, '已有人工职务不重复追加来源行').toEqual(currentBefore.versions);
  expect.soft(currentAfter.audits, '只记一次确认审计').toEqual([{ objectType: 'employment-record' }]);
  expect
    .soft(currentAfter.events, '确认审计只携带职务字段编码')
    .toEqual([{ version: 1, payload: { before: null, after: null, meta: { fields: ['preset:postId'] } } }]);

  const futureAfter = await read(future.id);
  const originCount = ({ versions }: typeof futureBefore) =>
    versions.reduce((count, version) => count + version.origins.length, 0);
  expect.soft(futureAfter.versions, '未来记录无新载荷版本').toHaveLength(futureBefore.versions.length);
  expect.soft(originCount(futureAfter), '未来记录无新来源行').toBe(originCount(futureBefore));
  expect.soft(futureAfter.audits, '未来记录无向后更新审计').toHaveLength(futureBefore.audits.length);
  expect.soft(futureAfter.events, '未来记录无向后更新 outbox').toEqual(futureBefore.events);
  expect.soft(await session.record(future.id)).toMatchObject({ fields, revision: future.revision });
});

it('AC-EMP-28 同值职务与变值备注同提交时，只追加备注来源', async () => {
  const { session, current, future, post, fields, read } = await manualPostFixture('f036-s2-r1-mixed-post');
  const futureBefore = await read(future.id);
  const response = await session.request('PATCH', `/records/${current.id}`, {
    ifMatch: current.revision,
    body: { fields: { postId: post.id, remarks: '只改备注' } },
  });
  await ok(response);
  expect.soft(await response.json()).toMatchObject({ fields: { ...fields, remarks: '只改备注' }, revision: 2 });
  const currentAfter = await read(current.id, intent);
  expect.soft(currentAfter.versions.at(-1)?.origins).toEqual([row('preset:remarks', 'hr-record', '只改备注')]);
  expect.soft(currentAfter.audits).toHaveLength(0);
  expect.soft(await read(future.id)).toEqual(futureBefore);
});

it('AC-EMP-24 兼职同值职务保留人工序列及原版本', async () => {
  const { db } = database();
  const w = await httpWorld(db, 'f036-s2-r1-part-time-post');
  const jobs = forwardJobApi(db, w);
  const defaultSequence = await jobs.create('sequences');
  const manualSequence = await jobs.create('sequences');
  const post = await jobs.create('posts', { sequenceId: defaultSequence.id });
  const fields = { postId: post.id, sequenceId: manualSequence.id };
  const record = await w.make({ fields });
  expect(record.fields).toMatchObject(fields);
  const read = () => evidence(db, w.tenantId, record.id, 'employment.part_time.edit');
  const before = await read();
  const response = await w.edit(record.id, { fields: { postId: post.id.toUpperCase() } }, record.revision);
  expect.soft(await w.ok(response), '兼职同值职务保持人工序列及 revision').toMatchObject({ fields, revision: 1 });
  expect.soft(await read(), '兼职同值职务无新版本、来源或编辑审计').toEqual(before);
});

describe('AC-EMP-28 同一个继承工作地夹具的三种 PATCH', () => {
  it('甲：点名同值固定人工意图；重放、换键重复及 409 后回读', async () => {
    const { session, current, later, read } = await editFixture('f036-s2-same');
    const before = await read(current.id, intent);
    const targetBefore = await read(later.id);
    const key = uniqueSuffix();
    const patch = (idempotencyKey: string, ifMatch = current.revision, place = '原地点') =>
      session.request('PATCH', `/records/${current.id}`, { ifMatch, idempotencyKey, body: { fields: { place } } });
    const response = await patch(key);
    await ok(response);
    expect(await response.json()).toMatchObject({ revision: current.revision });
    const first = await read(current.id, intent);
    expect(first.versions).toHaveLength(before.versions.length);
    const original = before.versions[0]!;
    expect
      .soft(first.versions[0]?.origins)
      .toEqual([...original.origins, row('preset:place', 'hr-record', '原地点', { record: current.id })]);
    expect.soft(first.audits).toEqual([{ objectType: 'employment-record' }]);
    expect
      .soft(first.events)
      .toEqual([{ version: 1, payload: { before: null, after: null, meta: { fields: ['preset:place'] } } }]);
    await ok(await patch(key));
    expect(await read(current.id, intent)).toEqual(first);
    await ok(await patch(uniqueSuffix()));
    expect((await read(current.id, intent)).versions).toEqual(first.versions);
    expect(await read(later.id)).toEqual(targetBefore);

    const changed = await patch(uniqueSuffix(), current.revision, '临时地点');
    await ok(changed);
    await ok(await patch(uniqueSuffix(), current.revision), 409);
    expect((await read(current.id, intent)).versions).toHaveLength(2);
    const refreshed = await revisionOf(await session.request('GET', `/businesses/${current.id}`));
    await ok(await patch(uniqueSuffix(), refreshed));
    expect((await read(current.id, intent)).versions[2]?.origins).toEqual([row('preset:place', 'hr-record', '原地点')]);
  });

  it('乙：草稿整版重提只改备注，随表单带回的工作地不入账', async () => {
    const { session, later, read } = await editFixture('f036-s2-form');
    const before = await read(later.id);
    const stored = await session.request('GET', `/businesses/${later.id}`);
    await ok(stored);
    const saved = (await stored.json()) as { fields: Record<string, unknown> };
    const { employType: _employType, ...fields } = saved.fields;
    expect(fields.place).toBe('原地点');
    await ok(
      await session.request('PATCH', `/businesses/${later.id}`, {
        ifMatch: later.revision,
        body: { fields: { ...fields, remarks: '整版只改备注' } },
      }),
    );
    const after = await read(later.id);
    expect(after.versions).toHaveLength(before.versions.length + 1);
    expect(after.versions.at(-1)?.origins.filter(({ field }) => field === 'preset:place')).toEqual([]);
  });

  it('丙：记录 PATCH 只点名备注，继承工作地不入账', async () => {
    const { session, current, later, read } = await editFixture('f036-s2-remarks');
    const before = await read(current.id, intent);
    const targetBefore = await read(later.id);
    await ok(
      await session.request('PATCH', `/records/${current.id}`, {
        ifMatch: current.revision,
        body: { fields: { remarks: '稀疏只改备注' } },
      }),
    );
    const after = await read(current.id, intent);
    expect(after.versions).toHaveLength(before.versions.length + 1);
    expect(after.versions.at(-1)?.origins.filter(({ field }) => field === 'preset:place')).toEqual([]);
    expect(after.audits).toEqual(before.audits);
    expect(await read(later.id)).toEqual(targetBefore);
  });
});

it('AC-EMP-29 批量编辑只为所选记录追加版本和来源，未来记录的三处证据不变', async () => {
  const { session, current, later, read } = await editFixture('f036-s2-batch', 'direct');
  const before = await read(current.id);
  const targetBefore = await read(later.id);
  expect((await session.record(later.id)).fields.place).toBe('原地点');
  const response = await session.request('POST', '/records/batch-edit', {
    body: { items: [{ id: current.id, revision: current.revision }], patch: { fields: { place: '批量新地点' } } },
  });
  await ok(response);
  expect(await response.json()).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
  const targetAfter = await read(later.id);
  expect(targetAfter.versions, '未来记录无新载荷版本').toEqual(targetBefore.versions);
  expect(targetAfter.audits, '未来记录无向后更新审计').toEqual(targetBefore.audits);
  expect(targetAfter.events, '未来记录无向后更新 outbox').toEqual(targetBefore.events);
  expect(await session.record(later.id)).toMatchObject({ revision: later.revision, fields: { place: '原地点' } });

  const after = await read(current.id);
  expect(after.versions).toHaveLength(before.versions.length + 1);
  expect(after.versions.at(-1)?.origins, '批量编辑所选记录的字段来源').toEqual([
    row('preset:place', 'hr-record', '批量新地点', { record: current.id }),
  ]);
});
