/**
 * AC-DM-30-F493-29 函数部分（F-493 S2，设计 §4.2）：虚拟登录名唯一，且由账号 ID 唯一推出。
 * 执行器整批写入的部分属 S3a；这里只验函数连续开通 50 个账号。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { provisionImportAccount, readUsers, seedTenant } from './AC-F493-s2-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

describe('AC-DM-30-F493-29 虚拟登录名唯一', () => {
  it('同租户连续开通 50 个账号：登录名互不相同，都匹配虚拟格式，各自等于自己账号 ID 推出的值，不含导入邮箱', async () => {
    const { db } = testDb();
    const a = await seedTenant(db, 'f29');
    const imported = Array.from({ length: 50 }, (_, i) => `syn.v${i}-${uniqueSuffix()}@example.com`);
    const ids: string[] = [];
    for (const [i, email] of imported.entries()) {
      const result = await provisionImportAccount(db, a.tenantId, a.userId, email, `合成${i}`);
      expect(result.login_assigned).toBe(true);
      ids.push(result.account_id);
    }
    const accounts = await readUsers(db, ids);
    expect(accounts).toHaveLength(50);
    expect(new Set(accounts.map((x) => x.email)).size).toBe(50);
    for (const account of accounts) {
      expect(account.email).toBe(`va-${account.id.replaceAll('-', '')}@virtualaccount.invalid`);
      expect(account.status).toBe('disabled');
      expect(imported).not.toContain(account.email);
    }
  });
});
