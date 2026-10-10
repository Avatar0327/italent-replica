/**
 * 人才评定配置读模型：视图、列表（范围谓词在分页之前生效，DEC-317②）与详情。视图字段名与对象目录一致
 * （packages/domain/src/evaluation/catalog.ts），响应再按字段权限裁剪。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { EvaluationObject } from './access.js';
import { rowsOf, tableOf } from './store.js';

export interface Page {
  readonly limit: number;
  readonly offset: number;
}

/** 视图用 type 而非 interface：要能赋给 `Record<string, unknown>`（响应裁剪按字段键处理）。 */
export type Tracked = {
  readonly id: string;
  readonly revision: number;
  readonly createdBy: string;
};

const INTERNAL = new Set(['tenant_id', 'visible']);
const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** 行 → 视图：列名转驼峰，去掉租户与访问判定列。 */
export function view<T>(row: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => !INTERNAL.has(key))
      .map(([key, value]) => [camel(key), value]),
  ) as T;
}

export type ActivityTypeView = Tracked & {
  readonly name: string;
  readonly displayOrder: number;
  readonly enabled: boolean;
  readonly syncQualification: boolean;
};

/**
 * 列表排序键（字段编码 → 列）：只用查看人看得到的字段排序，否则排序结果会泄露被裁掉字段的相对高低；
 * 都看不到时只按主键（不携带业务含义）。
 */
const ORDER: Readonly<Partial<Record<EvaluationObject, readonly (readonly [string, string])[]>>> = {
  activityType: [
    ['displayOrder', 'display_order'],
    ['name', 'name'],
  ],
  activityCycle: [['name', 'name']],
  generalScoreItem: [['name', 'name']],
  reviewGroup: [['name', 'name']],
  evaluationForm: [['name', 'name']],
  evaluationActivity: [['code', 'code']],
};

export function orderBy(object: EvaluationObject, visible: ReadonlySet<string> | undefined): SQL {
  const keys = (ORDER[object] ?? []).filter(([field]) => visible === undefined || visible.has(field));
  return sql.join([...keys.map(([, column]) => sql`t.${sql.identifier(column)}`), sql`t.id`], sql`, `);
}

/**
 * 读取的列：日期列转成 `YYYY-MM-DD` 文本（业务日期不带时区，不让驱动转成 Date）；其余对象 `t.*`。
 */
const ACTIVITY_COLUMNS = sql`t.id, t.tenant_id, t.code, t.name, t.type_id, t.cycle_id, t.year,
  t.start_date::text AS start_date, t.end_date::text AS end_date, t.owner_id, t.owner_org_id, t.org_range,
  t.manager_employee_id, t.applicant_mode, t.category_ids, t.level_ids, t.max_level_jump,
  t.effective_date::text AS effective_date, t.notice_org_range, t.status, t.apply_count,
  t.revision, t.created_by, t.created_at, t.updated_at`;
const columnsOf = (object: EvaluationObject): SQL => (object === 'evaluationActivity' ? ACTIVITY_COLUMNS : sql`t.*`);

/** 列表：`readable` 是作用在别名 t 上的范围谓词（分页之前生效）。 */
export async function listRows(
  tx: Tx,
  tenantId: string,
  object: EvaluationObject,
  readable: SQL,
  page: Page,
  filter: SQL = sql`true`,
  order: SQL = sql`t.id`,
): Promise<Record<string, unknown>[]> {
  const result = await tx.execute(sql`SELECT ${columnsOf(object)} FROM ${sql.identifier(tableOf(object))} t
    WHERE t.tenant_id = ${tenantId}::uuid AND ${readable} AND ${filter}
    ORDER BY ${order} LIMIT ${page.limit} OFFSET ${page.offset}`);
  return rowsOf(result);
}

export async function loadRow(tx: Tx, tenantId: string, object: EvaluationObject, id: string) {
  const result = await tx.execute(sql`SELECT ${columnsOf(object)} FROM ${sql.identifier(tableOf(object))} t
    WHERE t.tenant_id = ${tenantId}::uuid AND t.id = ${id}::uuid`);
  return rowsOf<Record<string, unknown>>(result)[0];
}

/** 写入后回读一行的视图（同事务内）。 */
export async function reload<T>(tx: Tx, tenantId: string, object: EvaluationObject, id: string): Promise<T> {
  return view<T>((await loadRow(tx, tenantId, object, id))!);
}
