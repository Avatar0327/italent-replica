import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { signWorld, SIGN_AT } from './AC-TRF-F481-s2-support.js';

const database = useTestDb();
describe('AC-TRF-F481-03～07 调动签署发起', () => {
  it('03 当天直接调动：201、生效、两份变量快照、48 小时且无通知', async () => {
    const w = await signWorld(database().db, '03');
    const business = await w.direct();
    expect(business.status).toBe('effective');
    const tasks = await w.tasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      businessId: business.id,
      status: 'signing',
      currentNode: 'employee',
      origin: 'activation',
      initiatorUserId: w.session.user.id,
      ownerDepartmentId: w.to.id,
    });
    expect(tasks[0]!.expiresAt.toISOString()).toBe('2026-10-12T01:00:00.000Z');
    const files = await w.files(tasks[0]!.id);
    expect(files.map((f) => f.templateId)).toEqual(w.templates.slice(0, 2).map((t) => t.id));
    for (const file of files) {
      expect(file.content).toContain('ZZ_F481_EMP_01|');
      expect(file.content).toContain('|2026-10-10|调出部门|调入部门|2026-10-10|2029-10-09|2026-10-10|');
      expect(file.content).not.toMatch(/\{[^}]+\}/);
    }
    expect(await w.notices()).toEqual([]);
    await w.runScheduler('2026-10-11T01:00:00Z');
    expect(await w.tasks()).toHaveLength(1);
  });

  it('04 不变更合同带 esign 返回指定原因；非法模板不落调动', async () => {
    const w = await signWorld(database().db, '04');
    const missing = await w.transfer(w.person, { linkage: { esign: { templateIds: [w.templates[0]!.id] } } });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { details: { reason: 'TRANSFER_ESIGN_REQUIRES_CONTRACT' } } });
    for (const ids of [
      [],
      Array.from({ length: 21 }, () => crypto.randomUUID()),
      [w.templates[0]!.id, w.templates[0]!.id],
    ]) {
      expect((await w.transfer(w.person, { linkage: w.linkage(ids) })).status).toBe(400);
    }
    await w.call('PATCH', `/templates/${w.templates[0]!.id}`, { ifMatch: 1, body: { status: 'disabled' } });
    const disabled = await w.transfer(w.person, { linkage: w.linkage() });
    expect(disabled.status).toBe(400);
    expect(await disabled.json()).toMatchObject({ error: { details: { reason: 'ESIGN_TEMPLATE_UNAVAILABLE' } } });
    expect(await w.session.records(w.person.employee.id)).toHaveLength(1);
    expect(await w.tasks()).toEqual([]);
  });

  it('05 未来调动生效前换 C：新版本生效且调度幂等', async () => {
    const w = await signWorld(database().db, '05');
    w.session.setNow('2026-10-07T01:00:00Z');
    const business = await w.saved(await w.transfer(w.person, { mode: 'direct', submit: false, linkage: w.linkage() }));
    expect(await w.tasks()).toEqual([]);
    const edit = await w.session.request('PUT', `/transfers/${business.id}/linkage`, {
      ifMatch: business.revision,
      body: w.linkage([w.templates[2]!.id]),
    });
    expect(edit.status, await edit.clone().text()).toBe(200);
    await withTenant(w.db, w.tenantId, async (tx) => {
      const versions = await tx.execute(sql`SELECT version_no FROM transfer_linkage_versions
        WHERE tenant_id=${w.tenantId} AND business_id=${business.id}::uuid ORDER BY version_no`);
      expect(Array.isArray(versions) ? versions : versions.rows).toEqual([{ version_no: 1 }, { version_no: 2 }]);
    });
    const run = await w.runScheduler(SIGN_AT);
    expect(run).toMatchObject({ failed: [], errors: [] });
    const [task] = await w.tasks();
    expect(task?.status).toBe('signing');
    expect((await w.files(task!.id)).map((f) => f.templateId)).toEqual([w.templates[2]!.id]);
    await w.runScheduler(SIGN_AT);
    expect(await w.tasks()).toHaveLength(1);
  });

  it('06 申请审批通过且到日才发起，发起人为提交人', async () => {
    const w = await signWorld(database().db, '06');
    const business = await w.saved(await w.transfer(w.person, { linkage: w.linkage() }));
    expect(business.status).toBe('in_review');
    expect(await w.tasks()).toEqual([]);
    await w.approve(business, SIGN_AT);
    expect(await w.tasks()).toEqual([
      expect.objectContaining({
        status: 'signing',
        initiatorUserId: w.session.user.id,
        businessId: business.id,
      }),
    ]);
  });

  it('07 模板生效前停用：调动仍生效，失败任务仅一条、不发通知', async () => {
    const w = await signWorld(database().db, '07-template');
    const business = await w.saved(await w.transfer(w.person, { mode: 'direct', submit: false, linkage: w.linkage() }));
    await w.call('PATCH', `/templates/${w.templates[0]!.id}`, { ifMatch: 1, body: { status: 'disabled' } });
    expect(await w.tasks()).toEqual([]);
    expect(await w.runScheduler(SIGN_AT)).toMatchObject({ failed: [], errors: [] });
    const [task] = await w.tasks();
    expect(task).toMatchObject({ businessId: business.id, status: 'failed', failureReason: 'TEMPLATE_UNAVAILABLE' });
    expect(task!.failureDetail).toContain(w.templates[0]!.id);
    expect((await w.business(business.id)).status).toBe('effective');
    expect(await w.notices()).toEqual([]);
    await w.runScheduler('2026-10-13T01:00:00Z');
    expect(await w.tasks()).toHaveLength(1);
  });

  it('07 员工无绑定账号：失败可见、不回滚、不自动重发', async () => {
    const w = await signWorld(database().db, '07-account');
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`DELETE FROM permission_user_person_links
      WHERE tenant_id=${w.tenantId} AND employee_id=${w.person.employee.id}::uuid`),
    );
    const business = await w.direct();
    expect(business.status).toBe('effective');
    expect(await w.tasks()).toEqual([
      expect.objectContaining({ status: 'failed', failureReason: 'EMPLOYEE_NO_ACCOUNT' }),
    ]);
    expect(await w.notices()).toEqual([]);
    await w.runScheduler('2026-10-13T01:00:00Z');
    expect(await w.tasks()).toHaveLength(1);
  });
});
