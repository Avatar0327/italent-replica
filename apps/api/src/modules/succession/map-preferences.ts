/** §1.5 / #8：本人偏好是 Map.view 的个人配置，不是 Map 数据编辑字段。 */
import { isUuid, sql, type Tx, SUCCESSION_MAP_DISPLAY_DEFAULTS } from '@italent/db';
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
export const preferenceBody = z.strictObject({
  rootOrgId: uuid.nullable(),
  depth: z.number().int().min(2).max(4),
  hiddenOrgIds: z
    .array(uuid)
    .max(200)
    .transform((ids) => [...new Set(ids)].sort()),
  hideVirtual: z.boolean(),
  showKeyPositions: z.boolean(),
  showPositionsWithoutSuccessor: z.boolean(),
  showIncumbents: z.boolean(),
});
export type MapPreferences = z.output<typeof preferenceBody>;
export interface PreferenceView extends MapPreferences {
  readonly id: string;
  readonly revision: number;
}
export function mapKind(value: string | undefined): MapKind {
  if (value !== 'org' && value !== 'position') throw new AppError('VALIDATION_FAILED', '地图类型不合法');
  return value;
}
export async function readPreferences(
  tx: Tx,
  tenantId: string,
  userId: string,
  kind: MapKind,
): Promise<PreferenceView> {
  const [stored] = rowsOf<Omit<PreferenceView, 'id'>>(
    await tx.execute(sql`SELECT root_org_id AS "rootOrgId",
    depth,hidden_org_ids AS "hiddenOrgIds",hide_virtual AS "hideVirtual",show_key_positions AS "showKeyPositions",
    show_positions_without_successor AS "showPositionsWithoutSuccessor",show_incumbents AS "showIncumbents",revision
    FROM succession_map_preferences WHERE tenant_id=${tenantId}::uuid
      AND user_id=${userId}::uuid AND map_kind=${kind}`),
  );
  const depth =
    stored?.depth ?? Number((await readEffectiveSetting(tx, tenantId, 'succession.map_default_depth')).value);
  // DEC-439① 暂定，口径讨论中；未经原站证实，取证中（#263）。
  return {
    id: `${userId}:${kind}`,
    rootOrgId: null,
    depth,
    hiddenOrgIds: [],
    ...SUCCESSION_MAP_DISPLAY_DEFAULTS,
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
