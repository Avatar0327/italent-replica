/**
 * 隔离测试库标记：只有测试夹具 `createTestDb()` / `useTestDb()` 建出来的库带这个标记（进程内、按对象身份）。
 * 用途：F-082 总开关的依赖注入覆盖只允许作用于隔离测试库，`createApp` 在库没有该标记时拒绝覆盖（契约 §10）。
 * 标记不落库、不随连接传播，生产连接永远没有它。
 */
import type { Db } from './client.js';

const ISOLATED_TEST_DBS = new WeakSet<object>();

export function markIsolatedTestDb(db: Db): void {
  ISOLATED_TEST_DBS.add(db);
}

export function isIsolatedTestDb(db: Db): boolean {
  return ISOLATED_TEST_DBS.has(db);
}
