import { randomUUID } from 'node:crypto';
import {
  approvalInstances,
  approvalProcesses,
  approvalProcessVersions,
  eq,
  grantMembership,
  sql,
  withTenant,
} from '@italent/db';
import {
  APPROVAL_TYPES,
  buttonResource,
  MODULE_OBJECTS,
  ONBOARDING_BUTTONS,
  PRESET_PROCESSES,
  STANDARD_GRANT_CODES,
} from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { startOrResume } from '../../apps/api/src/modules/approval/engine.js';
import { createPermissionAuthorizer } from '../../apps/api/src/modules/permission/authorizer.js';
import { grantStandardProfile } from '../../apps/api/src/modules/permission/standard-profiles.js';
import { provisionTenant } from '../../apps/api/src/modules/platform/provisioning.js';
import { newUser, seedOperator } from './support/platform-api.js';
import { cmd } from './support/tenant-api.js';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';

const testDb = useTestDb();

const hrProfiles = ['standard_hr_admin', 'standard_hr_specialist', 'standard_org_system_admin'] as const;

describe('AC-EN-BE16-01 入职共享契约', () => {
  it('迁移登记入职阶段表并强制租户隔离', async () => {
    const rows = rowsOf<{ enabled: boolean; forced: boolean }>(
      await testDb().db.execute(sql`
        SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class WHERE oid = to_regclass('public.onboarding_entry_cases')
      `),
    );
    expect(rows).toEqual([{ enabled: true, forced: true }]);
  });

  it.each([
    ['OnboardingCollection', 'comment', 'EmploymentRecord', 'CollectionComment@detail'],
    ['OnboardingQrCode', 'expiresAt', 'OnboardingQrCode', 'QrShare@detail'],
    ['OnboardingPreparation', 'status', 'EmploymentRecord', 'PreparationStart@list_row'],
    ['OnboardingMaterial', 'attachmentId', 'EmploymentRecord', 'MaterialReceive@detail'],
    ['OnboardingIntegration', 'status', 'OnboardingIntegration', 'IntegrationStart@list_row'],
  ])('登记 %s 的字段与 HR 业务按钮', (object, field, buttonObject, button) => {
    const expected = hrProfiles.map((profile) => `${profile}/TenantBase.${buttonObject}/button:BE16.${button}`).sort();
    const installed = STANDARD_GRANT_CODES.filter((code) =>
      code.endsWith(`/TenantBase.${buttonObject}/button:BE16.${button}`),
    ).sort();
    expect(installed).toEqual(expected);
    expect(objectCatalog.get(`TenantBase.${object}`)?.fields.map(({ code }) => code)).toContain(field);
    for (const profile of hrProfiles)
      expect(STANDARD_GRANT_CODES).toContain(`${profile}/TenantBase.${object}/field:${field}:view`);
  });

  it('信息采集登记独立的审批类型和出厂仅草稿流程', () => {
    expect(APPROVAL_TYPES).toHaveProperty('entry_info_collection');
    expect(PRESET_PROCESSES.find((preset) => preset.approvalType === 'entry_info_collection')).toMatchObject({
      code: 'EntryInfoCollectionProcess',
      publishOnProvision: false,
    });
  });
});

it('租户开通装入 HR 按钮，配置仍仅给租户管理员，采集草稿不可发起实例', async () => {
  const { db } = testDb();
  const now = new Date('2026-10-20T08:00:00Z');
  const ops = await seedOperator(db, 'ZZ_BE16_OPS');
  const admin = await newUser(db, 'ZZ_BE16_ADMIN');
  const hr = await newUser(db, 'ZZ_BE16_HR');
  const provisioned = await provisionTenant(
    db,
    {
      code: `ZZ_BE16_${randomUUID()}`,
      name: 'ZZ_BE16_CONTRACT',
      firstAdminUserId: admin.id,
      exceptionAdminUserId: admin.id,
    },
    cmd(ops.id),
    now,
  );
  const tenantId = provisioned.tenant.id;
  await grantMembership(db, { tenantId, userId: hr.id, expectedRevision: 0 }, cmd(ops.id));
  const profile = provisioned.profiles.find(({ code }) => code === 'standard_hr_specialist')!;
  await withTenant(db, tenantId, (tx) =>
    grantStandardProfile(
      tx,
      { tenantId, actorUserId: ops.id, now, commandId: randomUUID() },
      { userId: hr.id, profile },
    ),
  );

  const authorize = createPermissionAuthorizer(db, objectCatalog, () => now);
  const businessButtons = [
    [MODULE_OBJECTS.employmentRecord.code, ONBOARDING_BUTTONS.employmentRecord],
    [MODULE_OBJECTS.onboardingQrCode.code, ONBOARDING_BUTTONS.qrCode],
    [MODULE_OBJECTS.onboardingPreparation.code, ONBOARDING_BUTTONS.preparation],
    [MODULE_OBJECTS.onboardingIntegration.code, ONBOARDING_BUTTONS.integration],
  ] as const;
  for (const [object, buttons] of businessButtons) {
    for (const button of buttons) {
      const resource = buttonResource(object, button.code, button.level);
      expect(await authorize({ tenantId, userId: hr.id, action: 'object.button', resource }), resource).toBe(true);
    }
  }
  for (const user of [hr, admin]) {
    const context = { tenantId, userId: user.id };
    expect(await authorize({ ...context, action: 'tenant.employment.configuration.write' })).toBe(user === admin);
    expect(
      await authorize({
        ...context,
        action: 'object.update',
        resource: MODULE_OBJECTS.employmentSettings.code,
        fields: ['collectionSettings'],
      }),
    ).toBe(user === admin);
  }

  await withTenant(db, tenantId, async (tx) => {
    const drafts = await tx
      .select({
        code: approvalProcesses.code,
        type: approvalProcesses.approvalType,
        status: approvalProcessVersions.status,
      })
      .from(approvalProcesses)
      .innerJoin(approvalProcessVersions, eq(approvalProcesses.id, approvalProcessVersions.processId))
      .where(eq(approvalProcesses.approvalType, 'entry_info_collection'));
    expect(drafts).toEqual([{ code: 'EntryInfoCollectionProcess', type: 'entry_info_collection', status: 'draft' }]);
    const ctx = {
      tenantId,
      userId: hr.id,
      now,
      commandId: randomUUID(),
      timezone: provisioned.tenant.timezone,
      expectedRevision: 0,
    };
    await expect(
      startOrResume(tx, ctx, { businessType: 'entry_info_collection', businessId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'ENTRY_INFO_COLLECTION_UNAVAILABLE' } });
    expect(
      await tx.select().from(approvalInstances).where(eq(approvalInstances.businessType, 'entry_info_collection')),
    ).toEqual([]);
  });
});
