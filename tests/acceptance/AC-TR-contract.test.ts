/**
 * R3-T04 PR-A 契约项（设计 §11.4、§12）：
 * - C-02 引擎定点舍入导出（roundDecimal 与 Round 系列同一实现）；
 * - C-06 应用 TalentReview 的对象目录、预置身份“盘点管理员（人才盘点）”（只对设置类对象预置看全部）、审计标签、
 *   租户动态字段目录扩展点（按对象登记的字段来源）；
 * - C-08 审批类型 talent_review_result、业务类型 talent_review（check 约束）、适配器占位（PR-D 前一律 409）、出厂预置；
 * - SP-15 OrgHealthComputePort 登记（未登记 400 HEALTH_COMPUTE_UNAVAILABLE）。
 */
import { sql, withTenant } from '@italent/db';
import {
  APPROVAL_TYPES,
  auditObjectMeta,
  ObjectCatalog,
  PRESET_PROCESSES,
  roundDecimal,
  TALENT_REVIEW_APP,
  TALENT_REVIEW_OBJECTS,
} from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { ADAPTERS } from '../../apps/api/src/modules/approval/adapters.js';
import {
  registerTenantFieldSource,
  tenantObjectCatalog,
} from '../../apps/api/src/modules/permission/tenant-catalog.js';
import {
  orgHealthComputePort,
  registerOrgHealthComputePort,
  requireOrgHealthComputePort,
  resetOrgHealthComputePortForTest,
  type OrgHealthComputePort,
} from '../../apps/api/src/modules/talent-review/health-port.js';
import { BASE } from './AC-PRM-support.js';
import { newUser, provisioned, seedOperator } from './support/platform-api.js';
import { seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

describe('C-02 定点舍入导出', () => {
  it('按十进制表示精确舍入：四舍五入远离 0、进位、舍去', () => {
    expect(roundDecimal(1.005, 2, 'half-up')).toBe(1.01);
    expect(roundDecimal(-2.5, 0, 'half-up')).toBe(-3);
    expect(roundDecimal(1.1 * 3, 1, 'up')).toBe(3.4);
    expect(roundDecimal(0.9999999999999999, 0, 'down')).toBe(0);
  });
});

describe('C-06 应用、预置身份、审计标签、租户字段来源', () => {
  it('开通预置“盘点管理员（人才盘点）”：只带 TalentReview 应用、全部对象全部功能；只对准备度预置看全部', async () => {
    const { db } = testDb();
    const api = tenantApi(db, { authorize: undefined });
    const admin = await newUser(db, 'tr-preset-admin');
    const result = await provisioned(api, await seedOperator(db), {
      firstAdminUserId: admin.id,
      exceptionAdminUserId: admin.id,
    });
    const asAdmin = { user: admin.id, tenant: result.tenant.id };
    const preset = result.profiles.find((profile) => profile.code === 'standard_talent_review_admin')!;
    expect(preset).toMatchObject({ name: '盘点管理员（人才盘点）', licenseType: null });
    const detail = (await (await api.request('GET', `${BASE}/profiles/${preset.id}`, asAdmin)).json()) as {
      apps: string[];
      objects: { objectCode: string; dataOperations: object; buttons: unknown[] }[];
    };
    expect(detail.apps).toEqual([TALENT_REVIEW_APP]);
    const definitions = Object.values(TALENT_REVIEW_OBJECTS);
    expect(detail.objects.map((object) => object.objectCode).sort()).toEqual(definitions.map((d) => d.code).sort());
    for (const object of detail.objects) {
      expect(object.dataOperations).toEqual({ create: true, update: true, delete: true });
    }
    for (const definition of definitions) {
      const response = await api.request(
        'GET',
        `${BASE}/profiles/${preset.id}/data-scopes/${TALENT_REVIEW_APP}?targetKind=entity&targetCode=${
          definition.code
        }`,
        asAdmin,
      );
      const { seeAll } = (await response.json()) as { seeAll: boolean };
      expect(seeAll, definition.code).toBe(definition.code === TALENT_REVIEW_OBJECTS.readiness.code);
    }
  });

  it('审计日志按领域目录显示对象中文名与应用', () => {
    expect(auditObjectMeta(TALENT_REVIEW_OBJECTS.readiness.code)).toEqual({ label: '准备度', app: '人才盘点' });
    expect(auditObjectMeta(TALENT_REVIEW_OBJECTS.resultApproval.code)).toEqual({
      label: '盘点结果审批',
      app: '人才盘点',
    });
  });

  it('租户字段来源按对象登记：追加字段；超过上限一个都不追加；同一对象不能登记两个来源', async () => {
    const { db } = testDb();
    const { tenant } = await seedTenantWithMember(db, 'tr-field-source');
    const definition = { code: 'TalentReview.TestObject', application: TALENT_REVIEW_APP, fields: [], buttons: [] };
    const catalog = new ObjectCatalog([definition]);
    let count = 2;
    const source = async (_tx: unknown, limit: number) =>
      Array.from({ length: Math.min(count, limit) }, (_, index) => `field:f${index}`);
    registerTenantFieldSource(definition.code, source);
    registerTenantFieldSource(definition.code, source);
    expect(() => registerTenantFieldSource(definition.code, async () => [])).toThrow();
    const fields = (n: number) => {
      count = n;
      return withTenant(db, tenant.id, async (tx) =>
        (await tenantObjectCatalog(tx, catalog, definition.code)).get(definition.code)!.fields.map((f) => f.code),
      );
    };
    expect(await fields(2)).toEqual(['field:f0', 'field:f1']);
    expect(await fields(1001)).toEqual([]);
  });
});

describe('C-08 盘点结果审批类型', () => {
  it('类型登记在 TalentReview.ResultApproval 上，适配器种类 talent_review；出厂预置节点显式开启发起人回避', () => {
    expect(APPROVAL_TYPES.talent_review_result).toMatchObject({
      objectCode: TALENT_REVIEW_OBJECTS.resultApproval.code,
      adapter: 'talent_review',
      approvalEdit: false,
    });
    const preset = PRESET_PROCESSES.find((process) => process.approvalType === 'talent_review_result')!;
    expect(preset.definition.nodes.length).toBeGreaterThan(0);
    for (const node of preset.definition.nodes) {
      expect(node.actions).toMatchObject({ avoidSelf: true, avoidSubjects: false });
    }
  });

  it('业务类型 talent_review 进 check 约束；适配器在 PR-D 接入前一律 409，不静默放行', async () => {
    const { db } = testDb();
    const result = (await db.execute(
      sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'approval_instances_business_type'`,
    )) as unknown as { def: string }[] | { rows: { def: string }[] };
    const rows = Array.isArray(result) ? result : result.rows;
    expect(rows[0]?.def).toContain("'talent_review'");
    const ctx = {} as Parameters<(typeof ADAPTERS)['talent_review']['snapshot']>[1];
    await expect(ADAPTERS.talent_review.snapshot({} as never, ctx, 'x')).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'TALENT_REVIEW_APPROVAL_UNAVAILABLE' },
    });
  });
});

describe('SP-15 组织健康度计算端口登记', () => {
  it('未登记 400 HEALTH_COMPUTE_UNAVAILABLE；同一实现重复登记幂等，另一个实现拒绝', () => {
    resetOrgHealthComputePortForTest();
    expect(orgHealthComputePort()).toBeNull();
    expect(() => requireOrgHealthComputePort()).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED', details: { reason: 'HEALTH_COMPUTE_UNAVAILABLE' } }),
    );
    const port: OrgHealthComputePort = { compute: async () => [], listLevels: async () => [] };
    registerOrgHealthComputePort(port);
    registerOrgHealthComputePort(port);
    expect(requireOrgHealthComputePort()).toBe(port);
    expect(() => registerOrgHealthComputePort({ ...port })).toThrow();
    resetOrgHealthComputePortForTest();
  });
});
