/** D1 测试工厂：SQL 提交成功后才发布替身状态；业务异常同时回滚两边。
 * 仅用于进程内替身。不能作为跨存储生产事务或数据库 COMMIT 结果未知的证明；真实端口须用同一 SQL 事务。
 */
import { withTenant, type Db, type Tx } from '@italent/db';
import type { InMemorySyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';

export function syncTestTransaction(db: Db, tenantId: string, port: InMemorySyncPort) {
  return <T>(work: (tx: Tx) => Promise<T>): Promise<T> =>
    port.transaction((memory) =>
      withTenant(db, tenantId, (native) =>
        work(
          new Proxy(native, {
            get(target, property) {
              if (Reflect.has(memory, property)) return Reflect.get(memory, property);
              const value: unknown = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
        ),
      ),
    );
}
