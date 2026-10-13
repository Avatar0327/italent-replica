/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../apps/web/src/foundation/client.js';
import { loadPermissions } from '../../apps/web/src/demo-stubs/navigation.js';

afterEach(() => vi.unstubAllGlobals());
const api = createApiClient(() => ({ tenantId: 'tenant', identityKey: 'user' }));
const permission = (code: string) => ({
  objectCode: code,
  dataOperations: { read: true },
  viewableFields: ['name'],
  editableFields: [],
  buttons: [],
});
describe('AC-FE-0-07 菜单适配读取真实权限', () => {
  it('只拥有职层权限而没有职务权限时仍可进入职务体系；不补全数据范围', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        if (path.endsWith('TenantBase.JobLayer')) return Response.json(permission('TenantBase.JobLayer'));
        if (path.endsWith('/admin-menus')) return Response.json({ items: [] });
        return Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
      }),
    );
    const result = await loadPermissions(api, new AbortController().signal);
    expect(result.menus.map((menu) => menu.key)).toEqual(['job']);
    expect(result.objects['TenantBase.JobLayer']?.viewableFields).toEqual(['name']);
    expect(result.scope.organizationIds).toEqual([]);
  });
  it('授权失败不会退回演示全菜单，租户不可用与后端故障必须冒泡', async () => {
    for (const [status, code] of [
      [403, 'TENANT_NOT_MEMBER'],
      [503, 'SERVICE_UNAVAILABLE'],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ error: { code } }, { status })),
      );
      await expect(loadPermissions(api, new AbortController().signal)).rejects.toMatchObject({ code });
    }
  });
});
