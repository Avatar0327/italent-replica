/**
 * F-141 ⑤（DEC-500）：数据范围相关的审计对象类型要有中文名，日志页不再露出 permission_user_app_scope 这类编码。
 * 筛选仍只收编码（apps/api/src/audit/routes.ts 的 CODE 校验不变），中文名只用于展示。
 */
import { AUDIT_CONFIG_OBJECT_TYPES, auditObjectMeta } from '@italent/domain';
import { describe, expect, it } from 'vitest';

const SCOPE_TYPES = [
  'permission_identity_scope',
  'permission_user_app_scope',
  'permission_scope_policy',
  'permission_scope_app',
  'permission_dynamic_org_grant',
] as const;

describe('AC-F141-audit-scope-labels 数据范围审计对象的中文映射（DEC-500⑤）', () => {
  it.each(SCOPE_TYPES)('%s 有中文名，归企业设置', (type) => {
    const meta = auditObjectMeta(type);
    expect(meta.label).not.toBe(type);
    expect(meta.label).toMatch(/[一-龥]/);
    expect(meta.app).toBe(auditObjectMeta('permission_grant').app);
  });

  it('五个中文名互不相同，且不与已有对象重名', () => {
    const labels = SCOPE_TYPES.map((type) => auditObjectMeta(type).label);
    expect(new Set(labels).size).toBe(SCOPE_TYPES.length);
    for (const other of ['permission_admin', 'permission_profile', 'permission_grant', 'permission_mou'])
      expect(labels).not.toContain(auditObjectMeta(other).label);
  });

  it('可见性口径不变：这五类仍是配置对象，按“日志审计”查看权放行', () => {
    for (const type of SCOPE_TYPES) expect(AUDIT_CONFIG_OBJECT_TYPES.has(type), type).toBe(true);
  });
});
