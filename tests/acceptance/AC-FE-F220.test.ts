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
    ['/%69dp', '/idp'],
    ['/%49DP', '/idp'],
    ['/I%44P/', '/idp'],
    ['/%69dp/plans', '/idp/plans'],
    ['/%74utorship-information', '/tutorship-information'],
  ])('01 %s 使用与 %s 相同的权限入口', (variant, canonical) => {
    expect(appRoute(canonical)).toBeDefined();
    expect(appRoute(variant)).toBe(appRoute(canonical));
  });
  it.each(['/idp/%', '/idp/%GG', '/idp/%E0%A4', '/%2569dp', '/%2574utorship-information', '/idp%2Fplans'])(
    'AC-FE-F220-05 畸形编码或不能匹配的编码路径 %s 没有应用归属',
    (path) => expect(appRoute(path)).toBeUndefined(),
  );
});
