/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../apps/web/src/foundation/client.js';
import { loadSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';

afterEach(() => vi.unstubAllGlobals());
const api = createApiClient(() => ({ tenantId: 'tenant', identityKey: 'user' }));
describe('AC-FE-0-07 菜单适配读取真实权限', () => {
  it('只拥有职层权限而没有职务权限时仍可进入职务体系；不补全数据范围', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        if (path.endsWith('/me/snapshot'))
          return Response.json({
            session: { tenantId: 'tenant', userId: 'user' },
            apps: [{ app: 'job', visible: true, entryObjects: ['TenantBase.JobLayer'] }],
            adminMenus: [],
            scope: [],
          });
        if (path.endsWith('/admin-menus')) return Response.json({ items: [] });
        return Response.json({ error: { code: 'FORBIDDEN' } }, { status: 403 });
      }),
    );
    const { snapshot: result } = await loadSnapshot(api, new AbortController().signal);
    expect(result.menus.map((menu) => menu.key)).toEqual(['job']);
    expect(result.objects['TenantBase.JobLayer']?.summary).toBe(true);
    expect(result.scope.items).toEqual([]);
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
      await expect(loadSnapshot(api, new AbortController().signal)).rejects.toMatchObject({ code });
    }
  });
});
