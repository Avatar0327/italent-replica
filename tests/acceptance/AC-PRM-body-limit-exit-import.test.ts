/**
 * F-493 S2（设计 §5）：POST /api/tenant/employment/exits/import 的请求体放宽到 1 MiB（EXIT_IMPORT_BODY_LIMIT），
 * 超过仍 413；同一前缀下的其他接口仍按默认 32KB（预览路由已在 S3a 删除）。
 */
import { EXIT_IMPORT_BODY_LIMIT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { type PermissionWorld, seedPermissionWorld } from './AC-PRM-support.js';
import { errorCode } from './support/tenant-api.js';

const testDb = useTestDb();
const DEFAULT_LIMIT = 32 * 1024;
const IMPORT = '/api/tenant/employment/exits/import';

describe('AC-PRM-body-limit F-493 历史离职导入请求体 1 MiB', () => {
  let world: PermissionWorld;
  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
  });

  const post = (path: string, padding: number) =>
    world.api.request('POST', path, {
      ...world.asAdmin,
      body: { fileName: '合成导入.xlsx', rows: [], padding: 'x'.repeat(padding) },
    });

  it('常量为 1 MiB', () => {
    expect(EXIT_IMPORT_BODY_LIMIT).toBe(1024 * 1024);
  });

  it('import：约 200KB 的请求体不再被 413 拦下（进入业务校验，另行报 4xx）', async () => {
    const res = await post(IMPORT, 200 * 1024);
    expect(res.status).not.toBe(413);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('import：超过 1 MiB → 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await post(IMPORT, EXIT_IMPORT_BODY_LIMIT + 1024);
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe('PAYLOAD_TOO_LARGE');
  });

  it('同前缀的其他接口仍为默认 32KB', async () => {
    expect((await post('/api/tenant/employment/exits/import-other', DEFAULT_LIMIT)).status).toBe(413);
  });
});
