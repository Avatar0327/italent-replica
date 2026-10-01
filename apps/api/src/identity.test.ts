import { describe, expect, it } from 'vitest';
import { createDevIdentityResolver, devIdentityHeaders, identityResolverFromEnv } from './identity.js';

const secret = 'x'.repeat(32);
const userId = '00000000-0000-4000-8000-0000000000a1';

function requestWith(headers: Record<string, string>): Request {
  return new Request('http://test.local/api/tenant/settings/x', { headers });
}

describe('身份解析（B-01 之前的开发实现）', () => {
  it('签名正确时解析出用户；签名被篡改、换了用户或缺头时返回 null', async () => {
    const resolver = createDevIdentityResolver({ secret, nodeEnv: 'test' });
    const headers = devIdentityHeaders(secret, userId);
    expect(await resolver.resolve(requestWith(headers))).toBe(userId);

    const otherUser = '00000000-0000-4000-8000-0000000000b2';
    expect(await resolver.resolve(requestWith({ ...headers, 'x-dev-user-id': otherUser }))).toBeNull();
    expect(await resolver.resolve(requestWith({ ...headers, 'x-dev-identity-signature': 'ab' }))).toBeNull();
    expect(await resolver.resolve(requestWith({ 'x-dev-user-id': userId }))).toBeNull();
  });

  it('非 test / development 环境不允许构造开发实现', () => {
    expect(() => createDevIdentityResolver({ secret, nodeEnv: 'production' })).toThrow();
    expect(() => createDevIdentityResolver({ secret: 'short', nodeEnv: 'test' })).toThrow();
  });

  it('生产环境未接入真实登录时启动即报错，不回退到不安全实现', () => {
    expect(() => identityResolverFromEnv({ NODE_ENV: 'production' })).toThrow(/B-01/);
    expect(() => identityResolverFromEnv({})).toThrow(/B-01/);
    expect(() => identityResolverFromEnv({ NODE_ENV: 'development' })).toThrow(/DEV_IDENTITY_SECRET/);
    expect(identityResolverFromEnv({ NODE_ENV: 'development', DEV_IDENTITY_SECRET: secret })).toBeDefined();
  });
});
