/**
 * 继任记录的结果对象适配器（A2；设计 §2.1 第 3 步、§8.4）：写入口返回前按请求人**当时**的对象权限与数据范围重新读出
 * 结果记录（范围外 / SELF 隐藏 / 已删除（回执除外）一律 404），再做 §8.4 投影。供 `authorizeSuccessionResult` 使用。
 */
import { AppError } from '../../errors.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { tenantLocalDate } from '@italent/domain';
import { codeOf } from './access.js';
import { buildRecordViews, projectSuccession, type RecordView } from './projection.js';
import { listRecordRows, type RecordVisibility } from './record-read.js';
import type { ResultAdapter } from './write-support.js';

export const recordResults: ResultAdapter<RecordView> = {
  object: 'record',
  async load(tx, deps, ctx, ids, options) {
    const txDeps = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
    const scope = await resolveModuleScopeInTransaction(txDeps, ctx, tx, codeOf('record'));
    const today = tenantLocalDate(ctx.now, ctx.timezone);
    const visibility: RecordVisibility = { tenantId: ctx.tenantId, userId: ctx.userId, today, asOf: today, scope };
    const { rows } = await listRecordRows(
      tx,
      visibility,
      { status: 'all', ids, includeDeleted: options.includeDeleted },
      { limit: ids.length || 1, offset: 0 },
    );
    if (rows.length !== ids.length) throw new AppError('NOT_FOUND', '继任记录不存在');
    const views = await buildRecordViews(tx, ctx.tenantId, rows, today);
    return { views, revisions: new Map(rows.map((row) => [row.id, row.revision])) };
  },
  project: (deps, ctx, views) => projectSuccession(deps, ctx, 'record', [...views]),
};
