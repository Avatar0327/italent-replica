/** §1.5 / #8：本人偏好是 Map.view 的个人配置，不是 Map 数据编辑字段。 */
import { isUuid, sql, type Tx, SUCCESSION_POSITION_PREFERENCES_DEFAULTS } from '@italent/db';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { rowsOf } from './read-sql.js';
import type { ResultAdapter } from './write-support.js';
import { requirePermission } from '../../authorization.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { codeOf } from './access.js';

export type MapKind = 'org' | 'position';
const uuid = z
  .string()
  .refine(isUuid)
  .transform((id) => id.toLowerCase());
/** #265 R2：显示与冻结共用同一条件白名单；省略键由当前设置补齐。 */
export const mapDisplayBody = z
  .strictObject({
    rootOrgId: uuid.nullable(),
    depth: z.number().int().min(2).max(4),
    hiddenOrgIds: z
      .array(uuid)
      .max(200)
      .transform((ids) => [...new Set(ids)].sort()),
  })
  .partial();
export const preferenceBody = mapDisplayBody.required().extend({
  showKeyPositions: z.boolean(),
  showPositionsWithoutSuccessor: z.boolean(),
});
export type MapPreferences = z.output<typeof preferenceBody>;
export interface PreferenceView extends MapPreferences {
  readonly id: string;
  readonly revision: number;
}
export function mapKind(value: string | undefined): MapKind {
  if (value !== 'position') throw new AppError('VALIDATION_FAILED', '个人筛选仅用于职位地图');
  return value;
}
/** DEC-443：可信读端口，地图调用方负责 Map 授权，管理员设置经租户配置入口修改。 */
export async function readMapTenantSettings(tx: Tx, tenantId: string, kind: MapKind) {
  return {
    hideVirtual:
      kind === 'org' && (await readEffectiveSetting(tx, tenantId, 'succession.hide_virtual_org')).value === true,
    showIncumbents: (await readEffectiveSetting(tx, tenantId, 'succession.show_incumbents')).value === true,
  };
}
export async function readPreferences(
  tx: Tx,
  tenantId: string,
  userId: string,
  kind: MapKind,
): Promise<PreferenceView> {
  const [stored] = rowsOf<Omit<PreferenceView, 'id'>>(
    await tx.execute(sql`SELECT root_org_id AS "rootOrgId",
    depth,hidden_org_ids AS "hiddenOrgIds",show_key_positions AS "showKeyPositions",
    show_positions_without_successor AS "showPositionsWithoutSuccessor",revision
    FROM succession_map_preferences WHERE tenant_id=${tenantId}::uuid
      AND user_id=${userId}::uuid AND map_kind=${kind}`),
  );
  const depth =
    stored?.depth ?? Number((await readEffectiveSetting(tx, tenantId, 'succession.map_default_depth')).value);
  // DEC-443：组织地图没有个人筛选；内部默认布局只读，不创建个人行。
  return {
    id: `${userId}:${kind}`,
    rootOrgId: null,
    depth,
    hiddenOrgIds: [],
    ...SUCCESSION_POSITION_PREFERENCES_DEFAULTS,
    revision: 0,
    ...stored,
  };
}
export const preferenceResults: ResultAdapter<PreferenceView> = {
  object: 'map',
  async load(tx, deps, ctx, ids) {
    await requirePermission(authorizeInTransaction(deps.authorize, tx), {
      ...ctx,
      action: 'object.view',
      resource: codeOf('map'),
      fields: [],
    });
    const views = [];
    for (const id of ids) {
      const [owner, kind] = id.split(':');
      if (owner !== ctx.userId) throw new AppError('NOT_FOUND', '个人设置不存在');
      views.push(await readPreferences(tx, ctx.tenantId, owner, mapKind(kind ?? '')));
    }
    return { views, revisions: new Map(views.map((v) => [v.id, v.revision])) };
  },
  project: async (_deps, _ctx, views) => views.map(({ id: _id, ...view }) => view),
};
