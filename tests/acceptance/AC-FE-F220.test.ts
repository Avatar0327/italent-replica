import { describe, expect, it } from 'vitest';
import { appRoute } from '../../apps/web/src/foundation/routes.js';

describe('AC-FE-F220 外壳路由与权限归属大小写一致', () => {
  it.each([
    ['/IDP', '/idp'],
    ['/Idp', '/idp'],
    ['/IDP/', '/idp'],
    ['/Idp/plans', '/idp/plans'],
    ['/TUTORSHIP-INFORMATION', '/tutorship-information'],
    ['/Tutorship-Information/detail', '/tutorship-information/detail'],
    ['/TRANSFER', '/transfer'],
    ['/SELF/idp', '/self/idp'],
  ])('01 %s 使用与 %s 相同的权限入口', (variant, canonical) => {
    expect(appRoute(canonical)).toBeDefined();
    expect(appRoute(variant)).toBe(appRoute(canonical));
  });
});
