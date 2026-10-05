import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  readTransferCatalog,
  readTransferSettings,
  resolveTransferForm,
  saveTransferForm,
  updateTransferSettings,
} from '../../apps/api/src/modules/transfer/configuration.js';
import {
  prepareInheritance,
  inheritancePreview,
  prepareEmploymentPatch,
} from '../../apps/api/src/modules/employment/inheritance.js';
import { inheritanceFixture } from './AC-EMP-inheritance-support.js';
import { employmentSession, type EmploymentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
function context(session: Pick<EmploymentSession, 'tenant' | 'user'>, expectedRevision = 0) {
  return {
    tenantId: session.tenant.id,
    userId: session.user.id,
    timezone: session.tenant.timezone,
    now: new Date('2026-10-01T01:00:00.000Z'),
    commandId: randomUUID(),
    expectedRevision,
  };
}

describe('AC-TRF-18：真实调动表单配置、字典与 R1-T05 继承矩阵', () => {
  it('预置标准类型与原因含生效日、顺序和状态；排除 YG 演示项；流程由可信入口派生', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'trfcatalog');
    await db.transaction(async (tx: Tx) => {
      const catalog = await readTransferCatalog(tx, session.tenant.id, '2026-10-01');
      expect(catalog.types).toHaveLength(12);
      expect(catalog.types).toContainEqual(
        expect.objectContaining({
          code: 'cross_department',
          name: '跨部门调动',
          effectiveDate: '1900-01-01',
          enabled: true,
          displayOrder: 1,
        }),
      );
      expect(catalog.types.some((type) => type.name.startsWith('YG'))).toBe(false);
      expect(catalog.reasons).toHaveLength(7);
      expect(catalog.reasons).toContainEqual(
        expect.objectContaining({
          code: 'secondment',
          name: '借调',
          transferTypeCode: 'job_post',
          effectiveDate: '2026-02-08',
        }),
      );
      const historic = await readTransferCatalog(tx, session.tenant.id, '2025-12-31');
      expect(historic.reasons.some((reason) => reason.code === 'secondment')).toBe(false);
      expect(
        await resolveTransferForm(tx, session.tenant.id, 'TenantBase.JobLevelTransferMultiFormView'),
      ).toMatchObject({
        isStandard: true,
        processCode: 'TransferProcessNew',
        excludedAutofillFields: ['levelId', 'gradeId'],
      });
      expect(
        await resolveTransferForm(tx, session.tenant.id, 'TenantBase.Customized5TransferMultiFormView'),
      ).toMatchObject({ isStandard: true, processCode: 'Customized5TransferFlow' });
      await expect(resolveTransferForm(tx, session.tenant.id, 'forged-form')).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      await tx.execute(sql`
        INSERT INTO transfer_types(tenant_id,code,name,effective_date,enabled,display_order,form_id)
        VALUES(${session.tenant.id},'job_level','职级调整','1900-01-01',false,3,
          'TenantBase.JobLevelTransferMultiFormView')
      `);
      const overridden = await readTransferCatalog(tx, session.tenant.id, '2026-10-01');
      expect(overridden.types.some((type) => type.code === 'job_level')).toBe(false);
    });
  });

  it('31/66 出厂开启、租户隔离、revision 冲突拒绝；66 关闭后预览不带出可编辑值', async () => {
    const { db } = testDb();
    const session = await inheritanceFixture(db, 'trfswitches');
    const other = await employmentSession(db, 'trfswitchother');
    await db.transaction(async (tx: Tx) => {
      expect(await readTransferSettings(tx, session.tenant.id)).toMatchObject({
        revision: 0,
        unrestrictTargetDepartment: true,
        autoPopulate: true,
      });
      await updateTransferSettings(tx, context(session), { unrestrictTargetDepartment: false, autoPopulate: false });
      expect(await readTransferSettings(tx, other.tenant.id)).toMatchObject({
        revision: 0,
        unrestrictTargetDepartment: true,
        autoPopulate: true,
      });
      await expect(
        updateTransferSettings(tx, context(session), {
          unrestrictTargetDepartment: true,
          autoPopulate: true,
        }),
      ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      const prepared = await prepareInheritance(tx, context(session), {
        employeeId: session.employee.id,
        kind: 'transfer',
        effectiveDate: '2026-02-01',
        formId: 'TenantBase.JobLevelTransferMultiFormView',
      });
      expect(prepared.fields.place).toBeNull();
    });
  });

  it('职级调整不带出职级/职等；跨部门表单不带出部门；其它任职字段继续带出', async () => {
    const { db } = testDb();
    const session = await inheritanceFixture(db, 'trfstandard');
    const department = await session.org('调动前合成部门', { establishedOn: '2026-01-01' });
    const api = tenantApi(db);
    const job = async (kind: string, fields: Record<string, unknown>) => {
      const response = await api.request('POST', `/api/tenant/job/${kind}`, {
        tenant: session.tenant.id,
        user: session.user.id,
        ifMatch: 0,
        body: { name: `合成${kind}`, code: randomUUID(), startDate: '2026-01-01', ...fields },
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    };
    const layer = await job('layers', { layerLevel: 1 });
    const grade = await job('grades', { grade: 1, layerId: layer.id });
    const levelType = await job('level-types', {});
    const level = await job('levels', { level: 1, levelTypeId: levelType.id });
    await session.business(
      session.employee.id,
      {
        kind: 'org_adjustment',
        mode: 'direct',
        effectiveDate: '2026-01-15',
        fields: { departmentId: department.id, gradeId: grade.id, levelId: level.id },
      },
      session.hired.employeeRevision,
    );
    await db.transaction(async (tx: Tx) => {
      const base = { employeeId: session.employee.id, kind: 'transfer' as const, effectiveDate: '2026-02-01' };
      const gradeForm = await prepareInheritance(tx, context(session), {
        ...base,
        formId: 'TenantBase.JobLevelTransferMultiFormView',
      });
      expect(gradeForm.fields).toMatchObject({
        departmentId: department.id,
        place: '上一任职工作地',
        levelId: null,
        gradeId: null,
      });
      expect(gradeForm.formSnapshot.fieldModes['preset:levelId']).toBe('editable');
      const cross = await prepareInheritance(tx, context(session), {
        ...base,
        formId: 'TenantBase.CrossDepartmentTransferMultiFormView',
      });
      expect(cross.fields).toMatchObject({
        departmentId: null,
        place: '上一任职工作地',
        gradeId: grade.id,
        levelId: level.id,
      });
    });
  });

  it('自定义真实表单按字段执行只读/隐藏/未拖出规则，服务端拒绝伪造写入', async () => {
    const { db } = testDb();
    const session = await inheritanceFixture(db, 'trffieldpolicy', false);
    await db.transaction(async (tx: Tx) => {
      await saveTransferForm(tx, context(session), {
        id: 'tenant-grade-review',
        name: '合成逐字段表单',
        group: 'transfer',
        processCode: 'TransferProcessNew',
        fieldModes: {
          'preset:place': 'readonly',
          'preset:remarks': 'hidden',
          'preset:isKeyPerson': 'absent',
          [`custom:${session.field.id}`]: 'readonly',
        },
      });
      const base = {
        employeeId: session.employee.id,
        kind: 'transfer' as const,
        effectiveDate: '2026-02-01',
        formId: 'tenant-grade-review',
      };
      const prepared = await prepareInheritance(tx, context(session), base);
      expect(prepared.fields.place).toBe('上一任职工作地');
      expect(prepared.customFields[session.field.id]).toBe('上一任职字段值');
      expect(prepared.deferredFieldCodes).toContain('preset:isKeyPerson');
      expect(inheritancePreview(prepared).fields).not.toHaveProperty('remarks');
      await expect(
        prepareInheritance(tx, context(session), { ...base, fields: { place: '伪造值' } }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        prepareInheritance(tx, context(session), {
          ...base,
          customFields: { [session.field.id]: '伪造值' },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await resolveTransferForm(tx, session.tenant.id, base.formId)).toMatchObject({ isStandard: false });
      await saveTransferForm(tx, context(session, 1), {
        id: base.formId,
        name: '后改为可编辑表单',
        group: 'transfer',
        fieldModes: {},
      });
      // 原申请已冻结字段策略；后续配置放开不能让原单只读字段经补丁写入。
      await expect(
        prepareEmploymentPatch(
          tx,
          context(session),
          {
            ...base,
            fields: { place: '配置变更后伪造值' },
          },
          prepared,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });
});
