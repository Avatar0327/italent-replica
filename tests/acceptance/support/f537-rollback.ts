import { commandLedger, type Db } from '@italent/db';
import { AppError } from '../../../apps/api/src/errors.js';
import { approvalWorld } from '../AC-APV-support.js';
import { tenantApi } from './tenant-api.js';

export const transferPath = '/api/tenant/self-service/transfer';
export const resultPath = (id: string) => `/api/tenant/commands/${id}/result`;

export async function selfTransferWorld(db: Db) {
  const world = await approvalWorld(db, 'f537');
  const from = await world.org('合成原部门');
  const first = await world.org('合成目标部门甲');
  const second = await world.org('合成目标部门乙');
  const person = await world.person('合成申请人', from);
  await world.publishedProcess({
    nodes: [{ key: 'owner_review', approver: { type: 'custom_variable', value: 'owner' } }],
  });
  const api = (target: Db = db) => tenantApi(target, { authorize: undefined, clock: world.clock });
  return { world, first, second, person, api, actor: world.as(person.userId) };
}

/** 只在命令台账 INSERT 执行后注入错误，已发生的业务、审计与台账写由真实数据库一起回滚。 */
export function withLedgerFault(db: Db, afterInsert: () => void | Promise<void>, loseCommit = false): Db {
  const wrapped = Object.create(db) as Db;
  let firstWrite = true;
  wrapped.transaction = (async (fn: Parameters<Db['transaction']>[0]) =>
    db.transaction(async (tx) => {
      let inserted = false;
      const insert = tx.insert.bind(tx) as typeof tx.insert;
      tx.insert = ((table: Parameters<typeof insert>[0]) => {
        const query = insert(table);
        if (table !== commandLedger || !firstWrite) return query;
        return {
          async values(values: Parameters<typeof query.values>[0]) {
            const result = await query.values(values);
            // 故障发生在业务写里，独立的失败审计事务可以正常提交作废台账。
            firstWrite = false;
            inserted = true;
            await afterInsert();
            return result;
          },
        };
      }) as typeof tx.insert;
      const result = await fn(tx);
      if (inserted && loseCommit) throw Object.assign(new Error('合成提交响应丢失'), { code: 'ECONNRESET' });
      return result;
    })) as Db['transaction'];
  return wrapped;
}

export function failWith500(): never {
  throw new AppError('INTERNAL_ERROR', '合成写入异常');
}
