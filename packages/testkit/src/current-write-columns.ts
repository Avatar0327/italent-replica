import type { Db } from '@italent/db';

/** F-524 红测试桩：保持旧结构，验证当前查询会因缺列失败。 */
export async function withCurrentWriteColumns<T>(_db: Db, run: () => Promise<T>): Promise<T> {
  return run();
}
