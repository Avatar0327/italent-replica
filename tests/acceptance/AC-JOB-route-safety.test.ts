import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { orgSession } from './AC-ORG-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

describe('AC-JOB 路由装配与只读校验权限', () => {
  it('租户模块使用顶部静态 import，注册数组不执行动态 import', async () => {
    const source = await readFile(new URL('../../apps/api/src/app.ts', import.meta.url), 'utf8');
    expect(source).toContain("import { registerJobEstablishmentRoutes } from './modules/job/register.js';");
    expect(source).not.toContain("await import('./modules/job/register.js')");
  });

  it('validate-assignment 只要求职务体系读权限', async () => {
    const { db } = testDb();
    const session = await orgSession(db, 'job-validation-read');
    const authorize = vi.fn((request: { action: string }) => request.action === 'tenant.job.read');
    const response = await tenantApi(db, { authorize }).request('POST', '/api/tenant/job/validate-assignment', {
      tenant: session.tenant.id,
      user: session.user.id,
      body: { postId: randomUUID(), asOf: '2026-10-01' },
    });
    expect(response.status).toBe(400);
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: session.user.id,
        tenantId: session.tenant.id,
        action: 'tenant.job.read',
      }),
    );
    expect(authorize).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'tenant.job.write' }));
  });
});
