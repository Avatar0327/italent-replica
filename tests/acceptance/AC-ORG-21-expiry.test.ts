/** PR #82 第三轮 P2：stopDate 的次日起与显式停用具有相同的整段校验语义。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentDepartmentDisable } from '../../apps/api/src/modules/org/employment-validity.js';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const expected = {
  reason: 'EMPLOYMENT_DEPARTMENT_DISABLED',
  disabledOn: '2026-10-10',
};

async function world(label: string) {
  const w = await activationWorld(database().db, `org21-expiry-${label}`);
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-02T01:00:00Z') });
  let revision = w.to.revision;
  async function change(body: object) {
    const response = await api.request('PATCH', `/api/tenant/org/organizations/${w.to.id}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: revision,
      body,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    revision = ((await response.json()) as { revision: number }).revision;
  }
  const expire = () => change({ stopDate: '2026-10-09', effectiveDate: '2026-10-02' });
  const unavailable = (date: string) =>
    withTenant(w.db, w.session.tenant.id, (tx) => employmentDepartmentDisable(tx, w.session.tenant.id, w.to.id, date));
  return { ...w, change, expire, unavailable };
}

/** 正常入口已拒绝停用在途单据；仅构造旧版遗留数据，独立验证审批 / 落地防线，不能绕过生产状态机。 */
async function seedLegacyExpiry(w: ActivationWorld) {
  const versionId = randomUUID();
  await withTenant(w.db, w.session.tenant.id, async (tx) => {
    await tx.execute(sql`
      INSERT INTO org_versions SELECT (jsonb_populate_record(NULL::org_versions, to_jsonb(v) || jsonb_build_object(
        'id', ${versionId}::text, 'version_no', v.version_no+1, 'previous_version_id', v.id,
        'start_date', '2026-10-02', 'stop_date', '2026-10-09'))).*
      FROM org_versions v WHERE tenant_id=${w.session.tenant.id} AND org_id=${w.to.id}::uuid
      ORDER BY version_no DESC LIMIT 1
    `);
    await tx.execute(sql`
      INSERT INTO org_hierarchy_links (tenant_id, version_id, dimension, parent_org_id, sequence)
      SELECT l.tenant_id, ${versionId}::uuid, l.dimension, l.parent_org_id, l.sequence FROM org_hierarchy_links l
      JOIN org_versions v ON v.tenant_id=l.tenant_id AND v.previous_version_id=l.version_id
      WHERE v.tenant_id=${w.session.tenant.id} AND v.id=${versionId}::uuid
    `);
    await tx.execute(sql`UPDATE org_objects SET revision=revision+1
      WHERE tenant_id=${w.session.tenant.id} AND id=${w.to.id}::uuid`);
  });
}

describe('AC-ORG-21 失效日期反向顺序', () => {
  it.each(['2026-10-05', '2026-10-09', '2026-10-10'])(
    '先保存 %s 调入草稿，再缩短失效日期：提交拒绝且不改变单据',
    async (date) => {
      const w = await world(`submit-${date}`);
      const { employee, hire } = await w.hired();
      const draft = await w.session.business(
        employee.id,
        {
          kind: 'transfer',
          mode: 'application',
          effectiveDate: date,
          fields: { departmentId: w.to.id },
        },
        hire.employeeRevision,
      );
      await w.expire();
      const response = await w.session.request('POST', `/businesses/${draft.id}/submit`, {
        ifMatch: draft.revision,
        body: {},
      });
      expect(response.status, await response.clone().text()).toBe(400);
      expect(await response.json()).toMatchObject({ error: { details: expected } });
      expect(await w.business(draft.id)).toMatchObject({ status: 'draft', revision: draft.revision, record: null });
    },
  );

  it('旧版审批中申请遇失效日期：审批通过前拒绝', async () => {
    const w = await world('approve');
    const { employee } = await w.hired();
    const application = await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id });
    await seedLegacyExpiry(w);
    await expect(
      runEmploymentTransition(
        w.db,
        {
          tenantId: w.session.tenant.id,
          userId: w.session.user.id,
          timezone: w.session.tenant.timezone,
          now: new Date('2026-10-02T01:00:00Z'),
          commandId: randomUUID(),
          expectedRevision: application.revision,
        },
        { id: application.id, action: 'approve' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: expected });
    expect(await w.business(application.id)).toMatchObject({
      status: 'in_review',
      revision: application.revision,
      record: null,
    });
  });

  it('旧版已批申请遇失效日期：到期与重试均失败，不生成跨越失效日期的任职', async () => {
    const w = await world('activate');
    const { employee } = await w.hired();
    const approved = await w.approve(
      await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id }),
      '2026-10-02T01:00:00Z',
    );
    await seedLegacyExpiry(w);
    expect(await w.runScheduler('2026-10-05T01:00:00Z')).toMatchObject({
      activated: [],
      failed: [approved.id],
      errors: [],
    });
    expect(await w.business(approved.id)).toMatchObject({
      status: 'approved',
      record: null,
      activation: { status: 'failed', failureCount: 1 },
    });
    expect((await w.todos()).map((todo) => todo.id)).toContain(approved.id);
    expect((await w.retry(approved, '2026-10-06T01:00:00Z')).status).toBe(200);
    expect(await w.business(approved.id)).toMatchObject({
      status: 'approved',
      record: null,
      activation: { status: 'failed', failureCount: 2 },
    });
    expect((await w.session.records(employee.id, '2026-10-10')).map((record) => record.id)).not.toContain(approved.id);
  });

  it('直接保存调入也检查整个时段，不能在失效日前落下无限任职', async () => {
    const w = await world('direct');
    const { employee, hire } = await w.hired();
    await w.expire();
    const response = await w.session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: hire.employeeRevision,
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { departmentId: w.to.id } },
    });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await response.json()).toMatchObject({ error: { details: expected } });
  });

  it('DEC-173 已保存的直接未来调动到期复查失效日期：生成失败提醒', async () => {
    const w = await world('materialized');
    const { employee, hire } = await w.hired();
    const direct = await w.session.business(
      employee.id,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-10-05',
        fields: { departmentId: w.to.id },
      },
      hire.employeeRevision,
    );
    await seedLegacyExpiry(w);
    expect(await w.runScheduler('2026-10-05T01:00:00Z')).toMatchObject({
      failed: [direct.id],
      suspended: [],
      errors: [],
    });
    expect(await w.business(direct.id)).toMatchObject({
      status: 'effective',
      activation: { status: 'failed', failureReason: 'TARGET_ORG_DISABLED' },
    });
  });
});

describe('AC-ORG-21 失效日期版本边界', () => {
  it.each(['2026-10-02', '2026-10-08', '2026-10-10'])(
    '同日覆盖 / 到期前 / 无缝延长（%s）不被旧 stopDate 误拦',
    async (effectiveDate) => {
      const w = await world(`extend-${effectiveDate}`);
      await w.expire();
      await w.change({ stopDate: '9999-12-31', effectiveDate });
      expect(await w.unavailable('2026-10-05')).toBeNull();
    },
  );

  it('中间失效空档仍拦截；空档后恢复、开始日前的历史失效不拦截', async () => {
    const w = await world('gap');
    await w.expire();
    await w.change({ stopDate: '9999-12-31', effectiveDate: '2026-10-11' });
    expect(await w.unavailable('2026-10-05')).toMatchObject({ disabledOn: '2026-10-10' });
    expect(await w.unavailable('2026-10-10')).toMatchObject({ disabledOn: '2026-10-10' });
    expect(await w.unavailable('2026-10-11')).toBeNull();
  });

  it('失效后再显式停用并更名，提示连续不可用段最初日期', async () => {
    const w = await world('continuous');
    await w.expire();
    await w.change({ enabled: false, stopDate: '9999-12-31', effectiveDate: '2026-10-11' });
    await w.change({ name: '连续不可用部门', effectiveDate: '2026-10-12', addEmployment: false });
    expect(await w.unavailable('2026-10-13')).toEqual({ name: '连续不可用部门', disabledOn: '2026-10-10' });
  });
});
