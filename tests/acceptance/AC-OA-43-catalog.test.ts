import * as domain from '@italent/domain';
import { describe, expect, it } from 'vitest';

const MAIN = 'TenantBase.OrganizationApproval';
const DETAIL = 'TenantBase.OrganizationApprovalDetail';
const expected = {
  [MAIN]: [
    ['AddAdjustOrgApprovalBtn', 'list', 'create'],
    ['OrganizationApprovalDelete', 'list_row', 'update'],
    ['EditAdjustOrgDetailBtn', 'detail', 'update'],
    ['EditApprovalIngApply', 'detail', 'update'],
    ['AddSubOrgApprovalDetails', 'app_page', 'update'],
    ['AddPeerOrgApprovalDetail', 'app_page', 'update'],
    ['StopOrgBtn', 'app_page', 'update'],
    ['DragToGenerateOrgApprovalDetails', 'app_page', 'update'],
    ['ChangeOrgBtn', 'app_page', 'update'],
    ['AddOrgBtn', 'app_page', 'update'],
  ],
  [DETAIL]: [
    ['OrgAdjustDetailChange', 'list', 'create'],
    ['OrgAjustDetailCreate', 'list', 'create'],
    ['orgAdjustDetailStop', 'list', 'create'],
    ['AddOrgEstApprovalOfOrgApprovalDetail', 'list_row', 'create'],
    ['EditOrgEstApprovalOfOrgApprovalDetail', 'list_row', 'update'],
    ['EditOrgApprovalDetail', 'list_row', 'update'],
    ['DelteOrgApprovalDetail', 'list_row', 'delete'],
    ['DelOrgEstApprovalOfOrgApprovalDetail', 'list_row', 'delete'],
  ],
};
const catalog = Object.values(domain.MODULE_OBJECTS);

describe('AC-OA-43 目录部分（F273A §2、DEC-659②）', () => {
  it('两对象编码与 18 个按钮精确照抄；不注册旧对象和四个排除项', () => {
    expect(domain.ORG_ADJUSTMENT_OBJECT_CODE).toBe(MAIN);
    expect(domain.ORG_ADJUSTMENT_DETAIL_OBJECT_CODE).toBe(DETAIL);
    expect(catalog.some((o) => o.code === 'TenantBase.OrgAdjustment')).toBe(false);
    for (const [code, buttons] of Object.entries(expected)) {
      expect(catalog.find((o) => o.code === code)?.buttons).toEqual(
        buttons.map(([code, level, requires]) => ({ code, level, requires })),
      );
    }
  });

  it('头字段和全部静态命名空间只挂申请单，明细对象只有系统列', () => {
    const main = catalog.find((o) => o.code === MAIN)!;
    const detail = catalog.find((o) => o.code === DETAIL)!;
    expect(domain.ORG_ADJUSTMENT_HEADER_FIELDS).toContain('adjustmentRange');
    expect(main.fields.filter((f) => !f.system).map((f) => f.code)).toEqual([
      ...domain.ORG_ADJUSTMENT_HEADER_FIELDS,
      ...Object.values(domain.ORG_ADJUSTMENT_SECTION_FIELDS).flat(),
      domain.ORG_ADJUSTMENT_CONTRACT_CONTAINER,
    ]);
    expect(detail.fields.every((f) => f.system)).toBe(true);
    expect(main.fields.some((f) => f.code === 'scopeNote')).toBe(false);
    expect(main.fields.some((f) => f.code === domain.ORG_ADJUSTMENT_CONTRACT_CONTAINER)).toBe(true);
    for (const field of [
      'code',
      'approvalStatus',
      'executionStatus',
      'executionNote',
      'dataVolume',
      'successCount',
      'failureCount',
      'approvedAt',
      'executedAt',
    ]) {
      expect(main.fields).toContainEqual({ code: field, system: true });
    }
  });

  it('路由 4 九种入口的对象、按钮、层级和调整类型固定，拖拽只对应自己的按钮', () => {
    expect(domain.ORG_ITEM_ENTRY_BUTTONS).toEqual({
      'editor.sub': { objectCode: MAIN, code: 'AddSubOrgApprovalDetails', level: 'app_page', adjustType: 1 },
      'editor.peer': { objectCode: MAIN, code: 'AddPeerOrgApprovalDetail', level: 'app_page', adjustType: 1 },
      'editor.create': { objectCode: MAIN, code: 'AddOrgBtn', level: 'app_page', adjustType: 1 },
      'editor.change': { objectCode: MAIN, code: 'ChangeOrgBtn', level: 'app_page', adjustType: 2 },
      'editor.drag': { objectCode: MAIN, code: 'DragToGenerateOrgApprovalDetails', level: 'app_page', adjustType: 2 },
      'editor.stop': { objectCode: MAIN, code: 'StopOrgBtn', level: 'app_page', adjustType: 3 },
      'detail.create': { objectCode: DETAIL, code: 'OrgAjustDetailCreate', level: 'list', adjustType: 1 },
      'detail.change': { objectCode: DETAIL, code: 'OrgAdjustDetailChange', level: 'list', adjustType: 2 },
      'detail.stop': { objectCode: DETAIL, code: 'orgAdjustDetailStop', level: 'list', adjustType: 3 },
    });
  });

  it('DEC-415：仅两管理员获两对象完整权与申请单看全部，明细没有独立范围', () => {
    const admins = ['standard_org_system_admin', 'standard_hr_admin'];
    for (const profile of domain.STANDARD_PROFILES) {
      const objects = profile.objects.filter((o) => o.objectCode === MAIN || o.objectCode === DETAIL);
      const scopes = domain.presetSeeAllTargets(profile).filter((s) => [MAIN, DETAIL].includes(s.targetCode));
      if (!admins.includes(profile.code)) {
        expect(objects, profile.code).toEqual([]);
        expect(scopes, profile.code).toEqual([]);
        continue;
      }
      expect(objects).toHaveLength(2);
      for (const object of objects) {
        expect(object.dataOperations).toEqual({ create: true, update: true, delete: true });
        expect(object.buttons).toEqual(
          expected[object.objectCode]!.map(([buttonCode, level]) => ({ buttonCode, level })),
        );
      }
      expect(scopes).toEqual([{ appCode: 'TenantBase', targetKind: 'entity', targetCode: MAIN }]);
      expect(domain.STANDARD_GRANT_CODES).toContain(`${profile.code}/seeAll:TenantBase:entity:${MAIN}`);
    }
    expect(domain.STANDARD_GRANT_VERSION).toBeGreaterThanOrEqual(33);
  });
});
