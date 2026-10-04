import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { EmploymentBusiness } from './AC-EMP-support.js';
import { forwardFixture, forwardJobApi, preview } from './AC-FWD-support.js';

const testDb = useTestDb();

async function sequenceFixture(label: string) {
  const { db } = testDb();
  const fixture = await forwardFixture(db, label);
  const jobs = forwardJobApi(db, fixture.session);
  const oldSequence = await jobs.create('sequences');
  const newSequence = await jobs.create('sequences');
  const otherSequence = await jobs.create('sequences');
  const oldPost = await jobs.create('posts', { sequenceId: oldSequence.id });
  const newPost = await jobs.create('posts', { sequenceId: newSequence.id });
  const otherPost = await jobs.create('posts', { sequenceId: otherSequence.id });
  const before = await fixture.session.business(
    fixture.employee.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-09-02',
      fields: { postId: oldPost.id, sequenceId: oldSequence.id },
    },
    fixture.hired.employeeRevision,
  );
  return { ...fixture, jobs, oldSequence, newSequence, otherSequence, oldPost, newPost, otherPost, before };
}

describe('AC-FWD-06 DEC-107 选了新职务而未传职务序列时由服务端按新职务带出', () => {
  it('接口只传新职务：新记录带出该职务序列，并按特殊规则③与职务一并向后更新', async () => {
    const { session, employee, oldPost, newPost, oldSequence, newSequence, otherSequence, before } =
      await sequenceFixture('fwd06-derive-direct');
    const later = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-09-20' },
      before.employeeRevision,
    );
    const independent = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-25', fields: { sequenceId: otherSequence.id } },
      later.employeeRevision,
    );
    const input = {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-09-10',
      fields: { postId: newPost.id },
    } as const;
    const plan = await preview(session, employee.id, input);
    expect(plan.changes).toEqual([
      expect.objectContaining({
        businessId: later.id,
        fields: [
          { field: 'postId', before: oldPost.id, after: newPost.id },
          { field: 'sequenceId', before: oldSequence.id, after: newSequence.id },
        ],
      }),
      expect.objectContaining({
        businessId: independent.id,
        fields: [{ field: 'postId', before: oldPost.id, after: newPost.id }],
      }),
    ]);
    const inserted = await session.business(employee.id, input, independent.employeeRevision);
    expect(inserted.record!.fields).toMatchObject({ postId: newPost.id, sequenceId: newSequence.id });
    expect((await session.record(later.id)).fields).toMatchObject({ postId: newPost.id, sequenceId: newSequence.id });
    expect((await session.record(independent.id)).fields).toMatchObject({
      postId: newPost.id,
      sequenceId: otherSequence.id,
    });
  });

  it('导入新增与编辑任职未传序列时同样按新职务带出，编辑后一并向后更新', async () => {
    const { session, employee, newPost, otherPost, newSequence, otherSequence, before } =
      await sequenceFixture('fwd06-derive-import-edit');
    const imported = await session.request('POST', `/employees/${employee.id}/import`, {
      ifMatch: before.employeeRevision,
      body: {
        items: [
          {
            operation: 'create',
            business: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-11-01', fields: { postId: newPost.id } },
          },
        ],
      },
    });
    expect(imported.status).toBe(200);
    const [future] = ((await imported.json()) as { items: EmploymentBusiness[] }).items;
    expect(future!.record!.fields).toMatchObject({ postId: newPost.id, sequenceId: newSequence.id });
    const later = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-12-01' },
      (await session.getEmployee(employee.id)).revision,
    );
    const current = (await (await session.request('GET', `/businesses/${future!.id}`)).json()) as EmploymentBusiness;
    const edited = await session.request('PATCH', `/records/${future!.id}`, {
      ifMatch: current.revision,
      body: { fields: { postId: otherPost.id } },
    });
    expect(edited.status).toBe(200);
    expect((await session.record(future!.id)).fields).toMatchObject({
      postId: otherPost.id,
      sequenceId: otherSequence.id,
    });
    expect((await session.record(later.id)).fields).toMatchObject({
      postId: otherPost.id,
      sequenceId: otherSequence.id,
    });
  });

  it('草稿申请改选职务时重新带出序列；只改其他字段时保留已带出的序列', async () => {
    const { session, employee, newPost, otherPost, newSequence, otherSequence, before } =
      await sequenceFixture('fwd06-derive-draft');
    const draft = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-11-01', fields: { postId: newPost.id } },
      before.employeeRevision,
    );
    const stored = async (id: string) => {
      const response = await session.request('GET', `/businesses/${id}`);
      expect(response.status).toBe(200);
      return (await response.json()) as EmploymentBusiness & { fields: Record<string, unknown> };
    };
    expect((await stored(draft.id)).fields).toMatchObject({ postId: newPost.id, sequenceId: newSequence.id });
    const repost = await session.request('PATCH', `/businesses/${draft.id}`, {
      ifMatch: draft.revision,
      body: { fields: { postId: otherPost.id } },
    });
    expect(repost.status).toBe(200);
    const reposted = (await repost.json()) as EmploymentBusiness;
    expect((await stored(draft.id)).fields).toMatchObject({ postId: otherPost.id, sequenceId: otherSequence.id });
    const remarked = await session.request('PATCH', `/businesses/${draft.id}`, {
      ifMatch: reposted.revision,
      body: { fields: { remarks: '只改备注' } },
    });
    expect(remarked.status).toBe(200);
    expect((await stored(draft.id)).fields).toMatchObject({
      postId: otherPost.id,
      sequenceId: otherSequence.id,
      remarks: '只改备注',
    });
  });

  it('显式传入序列（含清空）时以传入值为准；新职务未配置序列时保留原序列', async () => {
    const { session, employee, jobs, newPost, oldSequence, otherSequence, before } =
      await sequenceFixture('fwd06-explicit-sequence');
    const explicit = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-10',
        fields: { postId: newPost.id, sequenceId: otherSequence.id },
      },
      before.employeeRevision,
    );
    expect(explicit.record!.fields.sequenceId).toBe(otherSequence.id);
    const cleared = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-15',
        fields: { postId: newPost.id, sequenceId: null },
      },
      explicit.employeeRevision,
    );
    expect(cleared.record!.fields.sequenceId).toBeNull();
    const restored = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-18', fields: { sequenceId: oldSequence.id } },
      cleared.employeeRevision,
    );
    const unsequencedPost = await jobs.create('posts');
    const unsequenced = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-20', fields: { postId: unsequencedPost.id } },
      restored.employeeRevision,
    );
    expect(unsequenced.record!.fields).toMatchObject({ postId: unsequencedPost.id, sequenceId: oldSequence.id });
  });
});
