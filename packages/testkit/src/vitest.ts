import type { DbHandle } from '@italent/db';
import { afterAll, beforeAll } from 'vitest';
import { createTestDb, type TestDbOptions } from './test-db.js';

/**
 * 在当前测试文件里注册一个全新测试库：beforeAll 建库并迁移，afterAll 关闭（真 PG 时删库）。
 * 返回取值函数，须在测试体内调用：`const testDb = useTestDb(); ... testDb().db`。
 */
export function useTestDb(options: TestDbOptions = {}): () => DbHandle {
  let handle: DbHandle | undefined;
  beforeAll(async () => {
    handle = await createTestDb(options);
  }, 60_000);
  afterAll(async () => {
    await handle?.close();
  });
  return () => {
    if (!handle) throw new Error('测试库尚未初始化：useTestDb() 返回的函数只能在测试体内调用');
    return handle;
  };
}
