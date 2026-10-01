import { describe, expect, expectTypeOf, it } from 'vitest';
import { ORG_DIMENSIONS, type OrgDimension, type OrgHierarchyReader, type OrgId } from './org-hierarchy.js';

describe('契约 OrgHierarchyReader（只校验类型形状，实现由 R1-T03 提供）', () => {
  it('组织维度为 1 个行政维度 + 4 个扩展维度，不含成本中心', () => {
    expect(ORG_DIMENSIONS).toEqual(['admin', 'business', 'product', 'reserve4', 'reserve5']);
    expectTypeOf<OrgDimension>().toEqualTypeOf<'admin' | 'business' | 'product' | 'reserve4' | 'reserve5'>();
  });

  it('OrgId 带品牌标记，裸字符串不能直接当 OrgId', () => {
    expectTypeOf<OrgId>().toExtend<string>();
    expectTypeOf<string>().not.toExtend<OrgId>();
  });

  it('接口签名：按租户、维度、时点查下级；按租户、时点查是否启用', () => {
    expectTypeOf<OrgHierarchyReader['listDescendantIds']>().parameter(0).toEqualTypeOf<{
      readonly tenantId: string;
      readonly dimension: OrgDimension;
      readonly orgId: OrgId;
      readonly asOf: string;
    }>();
    expectTypeOf<OrgHierarchyReader['listDescendantIds']>().returns.toEqualTypeOf<Promise<readonly OrgId[]>>();
    expectTypeOf<OrgHierarchyReader['isEnabled']>().parameter(0).toEqualTypeOf<{
      readonly tenantId: string;
      readonly orgId: OrgId;
      readonly asOf: string;
    }>();
    expectTypeOf<OrgHierarchyReader['isEnabled']>().returns.toEqualTypeOf<Promise<boolean>>();
  });
});
