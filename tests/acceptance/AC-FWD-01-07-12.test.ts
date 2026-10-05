import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { customField } from './AC-EMP-inheritance-support.js';
import { forwardFixture, forwardJobApi, preview } from './AC-FWD-support.js';
import { tenantApi } from './support/tenant-api.js';
import { loadJobWriteService } from './AC-JOB-personnel-support.js';

const testDb = useTestDb();

describe('AC-FWD-01~07/12 值匹配向后更新', () => {
  it('AC-FWD-01/02 同周期匹配字段替换，不匹配记录保留，预览无写入且等于实际结果', async () => {
    const { session, employee, org, nextOrg, hired } = await forwardFixture(testDb().db, 'fwd0102');
    const matching = await session.business(
      employee.id,
      {
        kind: 'regularization',
        mode: 'direct',
        effectiveDate: '2026-09-20',
      },
      hired.employeeRevision,
    );
    const otherOrg = await session.org('独立后续部门', { startDate: '2026-01-01' });
    const different = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-25',
        fields: { departmentId: otherOrg.id },
      },
      matching.employeeRevision,
    );
    const input = {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-09-15',
      fields: { departmentId: nextOrg.id },
    } as const;
    const plan = await preview(session, employee.id, input);
    expect(plan.employeeRevision).toBe(different.employeeRevision);
    expect(plan.changes).toEqual([
      expect.objectContaining({
        businessId: matching.id,
        staffId: hired.record!.staffId,
        status: 'effective',
        fields: [{ field: 'departmentId', before: org.id, after: nextOrg.id }],
      }),
    ]);
    expect((await session.record(matching.id)).fields.departmentId).toBe(org.id);
    expect((await session.getEmployee(employee.id)).revision).toBe(different.employeeRevision);
    await session.business(employee.id, input, different.employeeRevision);
    expect((await session.record(matching.id)).fields.departmentId).toBe(nextOrg.id);
    expect((await session.record(different.id)).fields.departmentId).toBe(otherOrg.id);
  });

  it('AC-FWD-03 与插入点前一条相同的字段不参与传播', async () => {
    const { session, employee, hired } = await forwardFixture(testDb().db, 'fwd03');
    const later = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-20',
        fields: { place: '后续独立地点' },
      },
      hired.employeeRevision,
    );
    const input = {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-09-10',
      fields: { place: '原地点' },
    } as const;
    expect((await preview(session, employee.id, input)).changes).toEqual([]);
    await session.business(employee.id, input, later.employeeRevision);
    expect((await session.record(later.id)).fields.place).toBe('后续独立地点');
  });

  it('AC-FWD-04 源日期有效而后续日期已停用的目标部门不传播，其他字段仍传播', async () => {
    const { db } = testDb();
    const { session, employee, org, nextOrg, hired } = await forwardFixture(db, 'fwd04');
    const later = await session.business(
      employee.id,
      {
        kind: 'regularization',
        mode: 'direct',
        effectiveDate: '2026-09-20',
      },
      hired.employeeRevision,
    );
    // DEC-150：已有停用排期后不能新增调动。先建立合法源记录，再用当前记录编辑验证同一向后更新规则。
    const source = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-10' },
      later.employeeRevision,
    );
    const disabled = await tenantApi(db).request('PATCH', `/api/tenant/org/organizations/${nextOrg.id}`, {
      user: session.user.id,
      tenant: session.tenant.id,
      ifMatch: nextOrg.revision,
      body: { enabled: false, effectiveDate: '2026-09-18' },
    });
    expect(disabled.status).toBe(200);
    const input = {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-09-10',
      fields: { departmentId: nextOrg.id, place: '新地点' },
    } as const;
    const plan = await preview(session, employee.id, input);
    expect(plan.changes.flatMap((change) => change.fields.map((field) => field.field))).toEqual(['place']);
    session.setNow('2026-09-10T01:00:00.000Z');
    const edited = await session.request('PATCH', `/records/${source.id}`, {
      ifMatch: source.revision,
      body: { fields: input.fields },
    });
    expect(edited.status).toBe(200);
    expect((await session.record(later.id)).fields).toMatchObject({ departmentId: org.id, place: '新地点' });
  });

  it('AC-FWD-04 DEC-079 只按后续记录生效日判断引用，不受运行当天影响', async () => {
    const { db } = testDb();
    const { session, employee, nextOrg, hired } = await forwardFixture(db, 'fwd04-target-date-only');
    const later = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2027-12-01' },
      hired.employeeRevision,
    );
    // 先建立源记录；编辑时它仍是当前记录，后续记录为未来记录，符合 A7 的真实传播入口。
    const source = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-10' },
      later.employeeRevision,
    );
    const disabled = await tenantApi(db).request('PATCH', `/api/tenant/org/organizations/${nextOrg.id}`, {
      user: session.user.id,
      tenant: session.tenant.id,
      ifMatch: nextOrg.revision,
      body: { enabled: false, effectiveDate: '2027-03-01' },
    });
    expect(disabled.status).toBe(200);
    const restored = await tenantApi(db).request('PATCH', `/api/tenant/org/organizations/${nextOrg.id}`, {
      user: session.user.id,
      tenant: session.tenant.id,
      ifMatch: ((await disabled.json()) as { revision: number }).revision,
      body: { enabled: true, effectiveDate: '2027-05-01' },
    });
    expect(restored.status).toBe(200);
    // 当天停用、源记录日及后续记录日启用：DEC-079 不能拿运行当天过滤后续引用。
    // DEC-150 只限新增任职，已有记录编辑仍按记录自己的生效日校验。
    session.setNow('2027-04-01T01:00:00.000Z');
    const response = await session.request('PATCH', `/records/${source.id}`, {
      ifMatch: source.revision,
      body: { fields: { departmentId: nextOrg.id } },
    });
    expect(response.status).toBe(200);
    expect((await session.record(source.id, '2027-04-01')).fields.departmentId).toBe(nextOrg.id);
    expect((await session.record(later.id, '2027-12-01')).fields.departmentId).toBe(nextOrg.id);
  });

  it('AC-FWD-05 部门和职位同时变化时，两者都匹配才一起传播', async () => {
    const { db } = testDb();
    const { session, employee, org, nextOrg, hired } = await forwardFixture(db, 'fwd05');
    const jobs = forwardJobApi(db, session);
    const post = await jobs.create('posts');
    const oldPosition = await jobs.create('positions', { orgId: org.id, postId: post.id });
    const siblingPosition = await jobs.create('positions', { orgId: org.id, postId: post.id });
    const newPosition = await jobs.create('positions', { orgId: nextOrg.id, postId: post.id });
    const before = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-02',
        fields: { positionId: oldPosition.id, postId: post.id },
      },
      hired.employeeRevision,
    );
    const matching = await session.business(
      employee.id,
      {
        kind: 'regularization',
        mode: 'direct',
        effectiveDate: '2026-09-20',
      },
      before.employeeRevision,
    );
    const partial = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-25',
        fields: { positionId: siblingPosition.id },
      },
      matching.employeeRevision,
    );
    await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-10',
        fields: { departmentId: nextOrg.id, positionId: newPosition.id },
      },
      partial.employeeRevision,
    );
    expect((await session.record(matching.id)).fields).toMatchObject({
      departmentId: nextOrg.id,
      positionId: newPosition.id,
    });
    expect((await session.record(partial.id)).fields).toMatchObject({
      departmentId: org.id,
      positionId: siblingPosition.id,
    });
  });

  it('AC-FWD-04 DEC-079 部门和职位同时变化时，停用引用仅排除自身字段', async () => {
    const { db } = testDb();
    const { session, employee, org, nextOrg, hired } = await forwardFixture(db, 'fwd04-independent-reference');
    const jobs = forwardJobApi(db, session);
    const post = await jobs.create('posts');
    const oldPosition = await jobs.create('positions', { orgId: org.id, postId: post.id });
    const newPosition = await jobs.create('positions', { orgId: nextOrg.id, postId: post.id });
    const baseline = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-05', fields: { positionId: oldPosition.id } },
      hired.employeeRevision,
    );
    const later = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-09-20' },
      baseline.employeeRevision,
    );
    const service = await loadJobWriteService();
    await withTenant(db, session.tenant.id, (tx) =>
      service.updateJobObject(
        tx,
        {
          tenantId: session.tenant.id,
          userId: session.user.id,
          timezone: session.tenant.timezone,
          now: new Date('2026-10-01T01:00:00.000Z'),
          commandId: randomUUID(),
          expectedRevision: newPosition.revision,
        },
        'positions',
        newPosition.id,
        { enabled: false, effectiveDate: '2026-09-18' },
        { listIncumbents: async () => [], appendManagerVersion: async () => undefined },
      ),
    );
    await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-10',
        fields: { departmentId: nextOrg.id, positionId: newPosition.id, place: '新地点' },
      },
      later.employeeRevision,
    );
    expect((await session.record(later.id)).fields).toMatchObject({
      departmentId: nextOrg.id,
      positionId: oldPosition.id,
      place: '新地点',
    });
  });

  it('AC-FWD-06 职务和显式变更的序列一并按原值匹配传播，保留后续独立序列', async () => {
    const { db } = testDb();
    const { session, employee, hired } = await forwardFixture(db, 'fwd06');
    const jobs = forwardJobApi(db, session);
    const oldSequence = await jobs.create('sequences');
    const newSequence = await jobs.create('sequences');
    const independentSequence = await jobs.create('sequences');
    const oldPost = await jobs.create('posts', { sequenceId: oldSequence.id });
    const newPost = await jobs.create('posts', { sequenceId: newSequence.id });
    const before = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-02',
        fields: { postId: oldPost.id, sequenceId: oldSequence.id },
      },
      hired.employeeRevision,
    );
    const later = await session.business(
      employee.id,
      {
        kind: 'regularization',
        mode: 'direct',
        effectiveDate: '2026-09-20',
      },
      before.employeeRevision,
    );
    const independent = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-25',
        fields: { sequenceId: independentSequence.id },
      },
      later.employeeRevision,
    );
    await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-10',
        fields: { postId: newPost.id, sequenceId: newSequence.id },
      },
      independent.employeeRevision,
    );
    expect((await session.record(later.id)).fields).toMatchObject({
      postId: newPost.id,
      sequenceId: newSequence.id,
    });
    expect((await session.record(independent.id)).fields).toMatchObject({
      postId: newPost.id,
      sequenceId: independentSequence.id,
    });
  });

  it('AC-FWD-07 负责人、Remarks、不继承自定义字段不传播，可继承自定义字段传播', async () => {
    const { session, employee, hired } = await forwardFixture(testDb().db, 'fwd07');
    const inherited = await customField(session);
    const excluded = await customField(session, false);
    const before = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-02',
        fields: { isDepartmentHead: false, remarks: '原备注' },
        customFields: { [inherited.id]: '原值', [excluded.id]: '原值' },
      },
      hired.employeeRevision,
    );
    const later = await session.business(
      employee.id,
      {
        kind: 'regularization',
        mode: 'direct',
        effectiveDate: '2026-09-20',
        customFields: { [excluded.id]: '原值' },
      },
      before.employeeRevision,
    );
    const laterBefore = await session.record(later.id);
    await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-10',
        fields: { isDepartmentHead: true, remarks: '新备注' },
        customFields: { [inherited.id]: '新值', [excluded.id]: '新值' },
      },
      later.employeeRevision,
    );
    const after = await session.record(later.id);
    expect(after.fields.isDepartmentHead).toBe(laterBefore.fields.isDepartmentHead);
    expect(after.fields.remarks).toBe('原备注');
    expect(after.customFields[inherited.id]).toBe('新值');
    expect(after.customFields[excluded.id]).toBe(laterBefore.customFields[excluded.id]);
  });

  it('AC-FWD-12 DEC-041 默认取插入点前一条，保留后续独立类别并传播匹配部门', async () => {
    const { session, employee, org, nextOrg, hired } = await forwardFixture(testDb().db, 'fwd12');
    const later = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-20',
        fields: { employmentType: '技术开发' },
      },
      hired.employeeRevision,
    );
    expect((await session.record(later.id)).fields.departmentId).toBe(org.id);
    const inserted = await session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-10',
        fields: { departmentId: nextOrg.id },
      },
      later.employeeRevision,
    );
    expect(inserted.record!.fields.employmentType).toBeNull();
    expect(inserted.record!.previousRecordId).toBe(hired.id);
    expect((await session.record(later.id)).fields).toMatchObject({
      departmentId: nextOrg.id,
      employmentType: '技术开发',
    });
  });
});
