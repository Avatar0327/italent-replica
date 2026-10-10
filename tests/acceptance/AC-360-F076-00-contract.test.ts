/**
 * F-076 PR-0 共享契约（docs/08_设计/F-076 §3.7、§5.1、§8.2）：
 * - 两类 429 错误码（AGENTS §10；与 409 业务冷却分开）；
 * - F-039 声明类型 `write.ledger: 'none'`（认证专用例外，DEC-377③），必须写理由；
 * - `.env.example` 只加键名，不带任何值。
 */
import { readFileSync } from 'node:fs';
import { AppError, defineTable, ERROR_STATUS, Hono, type RoutePolicy, type WritePolicy } from '@italent/api';
import { describe, expect, it } from 'vitest';
import { handleError } from '../../apps/api/src/errors.js';

const baseWrite = {
  fields: { none: true as const, reason: '登录请求体含凭据，不提取业务字段' },
  footprint: { none: true as const, reason: '无业务写足迹' },
  result: { none: true as const, reason: '回执只有会话令牌' },
};

/** 故意绕过类型的夹具：运行时检查必须独立于编译期检查。 */
const withWrite = (write: Record<string, unknown>): RoutePolicy =>
  ({
    kind: 'public',
    reason: '测试夹具',
    dec: 'DEC-291 Q2 / F-076',
    guards: ['survey360.credentialExchange'],
    write: { ...baseWrite, ...write },
  }) as RoutePolicy;

describe('AC-360-F076-00 F-076 PR-0 错误码：REQUEST_RATE_LIMITED / AUTH_LOCKED', () => {
  it('两类都是 429，且与 401 / 409 / 503 分开', () => {
    expect(ERROR_STATUS.REQUEST_RATE_LIMITED).toBe(429);
    expect(ERROR_STATUS.AUTH_LOCKED).toBe(429);
    expect(ERROR_STATUS.UNAUTHENTICATED).toBe(401);
    expect(ERROR_STATUS.CONFLICT).toBe(409);
    expect(ERROR_STATUS.SERVICE_UNAVAILABLE).toBe(503);
  });

  it('AppError 经统一错误处理返回 429 与机器可读错误码，details 原样带出', async () => {
    const app = new Hono();
    app.onError(handleError);
    app.get('/limited', () => {
      throw new AppError('REQUEST_RATE_LIMITED', '请求过于频繁');
    });
    app.get('/locked', () => {
      throw new AppError('AUTH_LOCKED', '已锁定', { unlockAt: '2026-10-10T00:15:00.000Z' });
    });

    const limited = await app.request('/limited');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: { code: 'REQUEST_RATE_LIMITED', message: '请求过于频繁' } });

    const locked = await app.request('/locked');
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({
      error: { code: 'AUTH_LOCKED', message: '已锁定', details: { unlockAt: '2026-10-10T00:15:00.000Z' } },
    });
  });
});

describe("AC-360-F076-00 F-076 PR-0 F-039：write.ledger = 'none' 必须写理由", () => {
  it('带理由登记成功', () => {
    const table = defineTable('survey360-portal', {
      'POST /login': withWrite({ ledger: 'none', ledgerReason: '认证入口不走命令台账（DEC-377③，设计 §4.8）' }),
    });
    const hit = table.lookup('POST /login');
    expect(hit?.policy.write?.ledger).toBe('none');
    expect(hit?.policy.write?.ledgerReason).toContain('DEC-377');
  });

  it('缺理由或理由为空白，模块加载时就报错（fail-closed，不到运行时才发现）', () => {
    expect(() => defineTable('t', { 'POST /login': withWrite({ ledger: 'none' }) })).toThrow(/ledgerReason/);
    expect(() => defineTable('t', { 'POST /login': withWrite({ ledger: 'none', ledgerReason: '   ' }) })).toThrow(
      /ledgerReason/,
    );
  });

  it("理由只属于 'none'：single / perItem / 未写 ledger 时带理由同样报错，避免理由与取值脱节", () => {
    for (const ledger of ['single', 'perItem', undefined]) {
      const write = ledger === undefined ? { ledgerReason: '多余' } : { ledger, ledgerReason: '多余' };
      expect(() => defineTable('t', { 'POST /x': withWrite(write) }), String(ledger)).toThrow(/ledgerReason/);
    }
  });

  it('组合声明里的子节点同样检查（any / all 的 of）', () => {
    const bad = withWrite({ ledger: 'none' });
    const nested = { kind: 'any', of: [bad] } as unknown as RoutePolicy;
    expect(() => defineTable('t', { 'POST /x': nested })).toThrow(/ledgerReason/);
  });

  it('现有取值 single / perItem 不受影响', () => {
    expect(() =>
      defineTable('t', { 'POST /a': withWrite({ ledger: 'single' }), 'POST /b': withWrite({ ledger: 'perItem' }) }),
    ).not.toThrow();
  });

  it('类型层：none 必须带 ledgerReason（编译期强制，与运行时检查双保险）', () => {
    const noReason = { ...baseWrite, ledger: 'none' as const };
    // @ts-expect-error ledger 为 none 时缺 ledgerReason
    const rejected: WritePolicy = noReason;
    const accepted: WritePolicy = { ...noReason, ledgerReason: '认证入口不走命令台账' };
    expect([rejected, accepted]).toHaveLength(2);
  });
});

describe('AC-360-F076-00 F-076 PR-0 .env.example：只加键名，不带值', () => {
  const text = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  const assignments = text
    .split('\n')
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => {
      const at = line.indexOf('=');
      return { key: line.slice(0, at), value: line.slice(at + 1) };
    });
  const keys = assignments.map((a) => a.key);

  it('凭据密钥、限频密钥、outbox 密钥、可信代理、对外网址、开关与维护任务键名齐全（设计 §2.4、§2.5、§2.6、§3.6）', () => {
    expect(keys).toEqual(
      expect.arrayContaining([
        'SURVEY360_CREDENTIAL_KEYS',
        'SURVEY360_CREDENTIAL_KEY_CURRENT',
        'SURVEY360_CREDENTIAL_KEYS_RETIRED',
        'SURVEY360_CREDENTIAL_KEYS_COMPROMISED',
        'SURVEY360_THROTTLE_KEY',
        'SURVEY360_OUTBOX_KEYS',
        'SURVEY360_OUTBOX_KEY_CURRENT',
        'TRUSTED_PROXY_CIDRS',
        'PUBLIC_BASE_URL',
        'SURVEY360_PORTAL_CREDENTIALS',
        'SURVEY360_CREDENTIAL_MAINTENANCE_SCHEDULER',
        'SURVEY360_CREDENTIAL_MAINTENANCE_INTERVAL_MS',
      ]),
    );
  });

  it('键名不重复，且全部键的值都为空（模板里不得出现任何真实值）', () => {
    expect(new Set(keys).size).toBe(keys.length);
    expect(assignments.filter((a) => a.value.trim() !== '').map((a) => a.key)).toEqual([]);
  });

  it('新增键都带中文注释行（说明用途与放哪里），且开关默认关闭的约定写在注释里', () => {
    const lines = text.split('\n');
    const at = lines.findIndex((line) => line.startsWith('SURVEY360_PORTAL_CREDENTIALS='));
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toMatch(/^#/);
    expect(lines.slice(Math.max(0, at - 3), at).join('\n')).toMatch(/默认|缺省/);
  });
});
