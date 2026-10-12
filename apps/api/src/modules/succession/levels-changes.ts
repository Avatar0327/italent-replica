/** #11：四个保存／重排入口共用实际内容比较，版本与审计只跟随真实变化。 */
import { sql, type Tx } from '@italent/db';
import type { SuccessionLevelKind } from '@italent/domain';
import type { SuccessionContext } from './access.js';
import { configAudit } from './config-write.js';
import { levelSpec, levelViews, type LevelView } from './levels-store.js';

interface LevelChange {
  id: string;
  before: LevelView | null;
  after: Partial<LevelView> | null;
  write: () => Promise<void>;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function content(view: Partial<LevelView> | null) {
  if (view === null) return 'null';
  const rules = view.rules;
  return JSON.stringify(
    canonical({
      code: view.code,
      name: view.name,
      color: view.color,
      description: view.description,
      enabled: view.enabled,
      displayOrder: view.displayOrder,
      rules: rules ? { ...rules, rows: [...rules.rows].sort((a, b) => a.rowNo - b.rowNo) } : rules,
    }),
  );
}
/** 调用方已持集合与等级行锁；缓存、revision、warnings 等派生字段不参与内容比较。 */
export async function applyLevelChanges(
  tx: Tx,
  ctx: SuccessionContext,
  kind: SuccessionLevelKind,
  operation: 'create' | 'update' | 'delete' | 'reorder',
  changes: readonly LevelChange[],
) {
  const changed = changes.filter((change) => content(change.before) !== content(change.after));
  if (!changed.length) return;
  const spec = levelSpec(kind);
  for (const change of changed) {
    await change.write();
    if (change.before && change.after)
      await tx.execute(sql`UPDATE ${spec.table} SET revision = revision + 1
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${change.id}::uuid`);
  }
  await tx.execute(sql`UPDATE succession_rule_settings SET levels_revision = levels_revision + 1
    WHERE tenant_id = ${ctx.tenantId}::uuid AND kind = ${spec.ruleKind}`);
  const after = await levelViews(
    tx,
    ctx.tenantId,
    kind,
    changed.filter((change) => change.after).map((c) => c.id),
  );
  for (const change of changed)
    await configAudit(
      tx,
      ctx,
      spec.object,
      operation,
      change.id,
      change.before,
      after.find((view) => view.id === change.id) ?? null,
    );
}
