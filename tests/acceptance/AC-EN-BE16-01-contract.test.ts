import { sql } from '@italent/db';
import { APPROVAL_TYPES, PRESET_PROCESSES, STANDARD_GRANT_CODES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
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
    expect(
      PRESET_PROCESSES.find((preset) => preset.approvalType === ('entry_info_collection' as string)),
    ).toMatchObject({
      code: 'EntryInfoCollectionProcess',
      publishOnProvision: false,
    });
  });
});
