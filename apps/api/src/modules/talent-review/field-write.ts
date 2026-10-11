/**
 * 盘点字段目录的写命令执行（AGENTS §10 权限、DEC-067；照 #211 runGuarded，F-082 #224 第 1 轮 P2-1）：对象 / 按钮 / 提交字段编辑权 /
 * 数据范围（新建带成对字段时另复核另一端的更新权）与改名错误的披露权限，都在**命令事务内**按当前授权重新解析（recheckWrite），
 * 首次执行、直接重放、并发败者失败后回查三条路径经过同一个出口 ledgerExit：撤权后首次执行整体回滚（业务、revision、审计、
 * 台账都不提交），重放按事务内的当前范围复核结果对象（撤范围后 404）。不改 config-kit 的共用签名；分类、角色、租户设置仍走
 * config-routes 的通用 runWrite（不在本任务范围，已报总编排另开任务）。
 */
import type { Tx } from '@italent/db';
import type { Context } from 'hono';
import { runCommand } from '../../commands.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { trimReview, type TalentReviewContext } from './access.js';
import { concurrentOr } from './config-kit.js';
import type { FieldWriteContext } from './field-rename-guard.js';
import { resolveCalcDisclosure, resolveFieldColumnsViewable } from './rename-disclosure.js';
import { type FieldCheck, recheckWrite, requireResultVisible, type Rechecked } from './tx-recheck.js';

interface FieldView {
  readonly createdBy: string | null;
  readonly revision: number;
}

export interface FieldWrite<V extends FieldView> {
  readonly body: object;
  readonly status: 200 | 201;
  readonly operation: 'create' | 'update' | 'delete';
  /** 新建 / 修改：提交字段的编辑权复核（事务内用事务内的依赖调用；删除不提供）。 */
  readonly checkFields?: FieldCheck;
  /** 新建带成对字段时：另一端的更新权（对象 + 按钮 + 字段编辑权）也在事务内复核。 */
  readonly checkPair?: FieldCheck;
  /** 修改里带名称：改名错误载荷的披露权限（CalcRule 查看权 / 范围 / items 列 / 字段目录四列）也在事务内解析。 */
  readonly renaming?: boolean;
  readonly execute: (tx: Tx, w: FieldWriteContext) => Promise<V>;
}

type Current = Rechecked & Pick<FieldWriteContext, 'calcDisclosure' | 'fieldColumnsViewable'>;

async function recheckFieldWrite<V extends FieldView>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  tx: Tx,
  ctx: TalentReviewContext,
  write: FieldWrite<V>,
): Promise<Current> {
  const checked = await recheckWrite(c, deps, tx, 'field', write.operation, ctx.expectedRevision, write.checkFields);
  if (write.checkPair) await recheckWrite(c, deps, tx, 'field', 'update', 0, write.checkPair);
  if (!write.renaming) return checked;
  return {
    ...checked,
    calcDisclosure: await resolveCalcDisclosure(c, checked.txDeps, tx),
    fieldColumnsViewable: await resolveFieldColumnsViewable(c, checked.txDeps, tx),
  };
}

export async function runFieldWrite<V extends FieldView>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentReviewContext,
  write: FieldWrite<V>,
) {
  let current: Current | undefined;
  // 字段目录的写入会在版本行上与计算规则写入互相等待（契约 §3.4），死锁中止映射为受控的 CONCURRENT_WRITE
  const result = await concurrentOr(() =>
    runCommand(deps.db, ctx, {
      id: c.req.header('idempotency-key'),
      fingerprint: {
        method: c.req.method,
        path: c.req.path,
        expectedRevision: ctx.expectedRevision,
        input: write.body,
      },
      guard: {
        before: async (tx) => {
          current = await recheckFieldWrite(c, deps, tx, ctx, write);
        },
        replayed: async (_tx, replay) => requireResultVisible(current!.scope, 'field', replay.body),
      },
      execute: async (tx, commandId) => {
        const { ctx: fresh, scope, calcDisclosure, fieldColumnsViewable } = current!;
        return {
          status: write.status,
          body: await write.execute(tx, { ...fresh, commandId, scope, calcDisclosure, fieldColumnsViewable }),
        };
      },
    }),
  );
  const view = result.body as V;
  requireResultVisible(current!.scope, 'field', view);
  if (c.req.method !== 'DELETE') c.header('ETag', `"${view.revision}"`);
  return c.json((await trimReview(deps, ctx, 'field', [view]))[0], result.status);
}
