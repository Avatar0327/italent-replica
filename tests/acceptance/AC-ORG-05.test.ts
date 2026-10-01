/** AC-ORG-04/05：服务端编制校验扩展点。真实编制计算由 R1-T04 接入，不采信客户端自报的标志。 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedTenantWithMember } from './support/tenant-api.js';

const testDb = useTestDb();
let tenant: Awaited<ReturnType<typeof seedTenantWithMember>>;

beforeAll(async () => {
  tenant = await seedTenantWithMember(testDb().db, 'org-preflight');
});

function context() {
  return {
    tenantId: tenant.tenant.id,
    userId: tenant.user.id,
    timezone: tenant.tenant.timezone,
    rootName: tenant.tenant.name,
    now: new Date('2026-10-01T01:00:00Z'),
    commandId: randomUUID(),
    expectedRevision: 0,
  };
}

function input(confirmed = false) {
  return { name: '待校验组织', parents: { admin: { parentId: tenant.tenant.id } }, confirmed };
}

describe('AC-ORG-04/05 写前二次校验与强控', () => {
  it('严格控制：超编返回阻止标志，保存仍重新校验并拒绝', async () => {
    const service = await import('../../apps/api/src/modules/org/write-service.js');
    const assess = async () => ({ isBeyondEstablishment: true, strictControl: true });
    await withTenant(testDb().db, tenant.tenant.id, async (tx) => {
      const ctx = context();
      const validation = await service.validateOrganization(tx, ctx, input(), assess);
      expect(validation).toMatchObject({ isBeyondEstablishment: true, strictControl: true, canSubmit: false });
      await expect(service.createOrganization(tx, ctx, input(true), assess)).rejects.toMatchObject({
        code: 'CONFLICT',
        details: { reason: 'ESTABLISHMENT_EXCEEDED' },
      });
    });
  });

  it('非严格控制：先提示；没有确认则阻止，有确认才允许写入', async () => {
    const service = await import('../../apps/api/src/modules/org/write-service.js');
    const assess = async () => ({ isBeyondEstablishment: true, strictControl: false });
    await withTenant(testDb().db, tenant.tenant.id, async (tx) => {
      const validation = await service.validateOrganization(tx, context(), input(), assess);
      expect(validation).toMatchObject({ requiresConfirmation: true, canSubmit: false });
      await expect(service.createOrganization(tx, context(), input(), assess)).rejects.toMatchObject({
        code: 'CONFLICT',
        details: { reason: 'CONFIRMATION_REQUIRED' },
      });
      const org = await service.createOrganization(tx, context(), input(true), assess);
      expect(org).toMatchObject({ name: '待校验组织', broadType: '部门' });
    });
  });

  it('预检后实际条件变化：保存重新评估，不能使用过期的放行结果', async () => {
    const service = await import('../../apps/api/src/modules/org/write-service.js');
    let beyond = false;
    const assess = async () => ({ isBeyondEstablishment: beyond, strictControl: true });
    await withTenant(testDb().db, tenant.tenant.id, async (tx) => {
      const ctx = context();
      expect(await service.validateOrganization(tx, ctx, input(), assess)).toMatchObject({ canSubmit: true });
      beyond = true;
      await expect(service.createOrganization(tx, ctx, input(), assess)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    });
  });
});
