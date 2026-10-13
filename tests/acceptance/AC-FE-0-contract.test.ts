import { describe, expect, it } from 'vitest';
import { APP_ROUTES, legacyTarget } from '../../apps/web/src/foundation/routes.js';
import { canButton, fieldAccess } from '../../apps/web/src/foundation/permission-model.js';
import { tenantDate } from '../../apps/web/src/foundation/dates.js';

describe('AC-FE-0-02 前端契约', () => {
  it('15 个应用分区、最长路径匹配及旧链接兼容，保留 query/hash', () => {
    expect(APP_ROUTES.map((route) => route.path)).toEqual([
      '/org',
      '/job',
      '/staff',
      '/transfer',
      '/approval',
      '/self',
      '/manager',
      '/settings',
      '/talent',
      '/qualification',
      '/evaluation',
      '/survey360',
      '/talent-review',
      '/succession',
      '/idp',
    ]);
    expect(legacyTarget('/jobs', '?page=2', '#list')).toBe('/job?page=2#list');
    expect(legacyTarget('/account')).toBe('/settings/account');
    expect(legacyTarget('/')).toBe('/transfer');
    expect(legacyTarget('/org/changes')).toBeNull();
  });

  it('按钮级别分别判断；字段不可见时不可编辑；缺省不授予权限', () => {
    const permission = {
      objectCode: 'example',
      dataOperations: { read: true },
      viewableFields: ['name'],
      editableFields: ['name', 'secret'],
      buttons: [{ buttonCode: 'update', level: 'detail' }],
    };
    expect(canButton(permission, 'update', 'detail')).toBe(true);
    expect(canButton(permission, 'update', 'list')).toBe(false);
    expect(canButton(undefined, 'update', 'detail')).toBe(false);
    expect(fieldAccess(permission, 'name')).toEqual({ visible: true, editable: true });
    expect(fieldAccess(permission, 'secret')).toEqual({ visible: false, editable: false });
    expect(fieldAccess(undefined, 'name')).toEqual({ visible: false, editable: false });
  });

  it('业务日期使用显式租户时区，跨日及夏令时不采用浏览器时区', () => {
    const instant = new Date('2026-10-12T01:30:00Z');
    expect(tenantDate(instant, 'Asia/Shanghai')).toBe('2026-10-12');
    expect(tenantDate(instant, 'America/Chicago')).toBe('2026-10-11');
    expect(tenantDate(new Date('2026-03-08T08:30:00Z'), 'America/Chicago')).toBe('2026-03-08');
    expect(() => tenantDate(instant, '')).toThrow();
  });
});
