import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { loadFieldOrigins } from '../../apps/api/src/modules/employment/field-origin-store.js';
import { forwardFixture, forwardJobApi } from './AC-FWD-support.js';
import { resultRows } from './AC-ORG-people-support.js';

const database = useTestDb();
const explicit = ['preset:departmentId', 'preset:postId'];

async function fixture(db: Db, label: string) {
  const { session, employee, hired, org } = await forwardFixture(db, label);
  const jobs = forwardJobApi(db, session);
  const manual = await jobs.create('sequences');
  const post = await jobs.create('posts');
  const draft = await session.business(
    employee.id,
    {
      kind: 'transfer',
      mode: 'application',
      effectiveDate: '2026-11-01',
      fields: { departmentId: org.id, postId: post.id, sequenceId: manual.id },
    },
    hired.employeeRevision,
  );
  const patch = async (revision: number, fields: { postId?: string | null; sequenceId?: string | null }) => {
    const response = await session.request('PATCH', `/businesses/${draft.id}`, { ifMatch: revision, body: { fields } });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as {
      revision: number;
      fields: { postId: string | null; sequenceId: string | null };
    };
  };
  const read = () =>
    withTenant(db, session.tenant.id, async (tx) => {
      const versions = resultRows<{ version: number; explicit: string[]; deferred: string[]; sequence: string | null }>(
        await tx.execute(sql`
          SELECT version_no AS version, explicit_field_codes AS explicit, deferred_field_codes AS deferred,
                 sequence_id AS sequence
          FROM employment_payload_versions WHERE tenant_id=${session.tenant.id} AND business_id=${draft.id}
          ORDER BY version_no`),
      );
      const states = await loadFieldOrigins(tx, { tenantId: session.tenant.id }, draft.id, ['preset:sequenceId']);
      return { versions, state: states.get('preset:sequenceId') };
    });
  return { session, jobs, manual, post, draft, patch, read };
}

it('AC-EMP-26 DEC-976：清空职务结束旧手填序列，重填时登记新的手填来源', async () => {
  const x = await fixture(database().db, 'f036s3-clear-post');
  const cleared = await x.patch(x.draft.revision, { postId: null });
  expect(cleared.fields).toMatchObject({ postId: null, sequenceId: null });
  const afterClear = await x.read();
  expect.soft(afterClear.versions).toEqual([
    { version: 1, explicit: [...explicit, 'preset:sequenceId'], deferred: [], sequence: x.manual.id },
    { version: 2, explicit, deferred: [], sequence: null },
  ]);
  expect.soft(afterClear.state, '清空职务后的序列来源为空值').toMatchObject({
    policy: 'none',
    policyRow: { originKind: 'none', value: null },
    override: null,
    lastWriter: null,
  });
  const replacement = await x.jobs.create('sequences');
  const refilled = await x.patch(cleared.revision, { sequenceId: replacement.id });
  expect(refilled.fields.sequenceId).toBe(replacement.id);
  const afterRefill = await x.read();
  expect(afterRefill.versions).toHaveLength(3);
  expect(afterRefill.versions[2]).toEqual({
    version: 3,
    explicit: [...explicit, 'preset:sequenceId'],
    deferred: [],
    sequence: replacement.id,
  });
  expect(afterRefill.state?.lastWriter).toMatchObject({
    originKind: 'hr-input',
    value: replacement.id,
    actorUserId: x.session.user.id,
  });
});

it('AC-EMP-26 DEC-976：换职务时结束旧手填，记录新职务带出的序列', async () => {
  const x = await fixture(database().db, 'f036s3-switch-post');
  const sequence = await x.jobs.create('sequences');
  const post = await x.jobs.create('posts', { sequenceId: sequence.id });
  const changed = await x.patch(x.draft.revision, { postId: post.id });
  expect(changed.fields).toMatchObject({ postId: post.id, sequenceId: sequence.id });
  const result = await x.read();
  expect(result.versions[1]).toEqual({ version: 2, explicit, deferred: [], sequence: sequence.id });
  expect(result.state?.lastWriter).toMatchObject({
    originKind: 'derive',
    derivationRule: 'post-sequence',
    referenceId: post.id,
    value: sequence.id,
  });
});
