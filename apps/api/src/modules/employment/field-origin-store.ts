import { and, employmentFieldOrigins, eq, sql, type Tx } from '@italent/db';
import {
  FIELD_ORIGIN_ANCHORS,
  FIELD_ORIGIN_OVERRIDES,
  FIELD_ORIGIN_POLICIES,
  foldFieldOrigins,
  type FieldOriginKind,
  type OriginDerivationRule,
} from '@italent/domain';
import type { EmploymentContext } from './types.js';

type StoredOrigin = Omit<typeof employmentFieldOrigins.$inferSelect, 'originKind' | 'derivationRule'> & {
  readonly originKind: FieldOriginKind;
  readonly derivationRule: OriginDerivationRule | null;
};

export type FieldOriginDraft = Pick<StoredOrigin, 'fieldCode' | 'originKind'> &
  Partial<
    Pick<
      StoredOrigin,
      | 'value'
      | 'sourceBusinessId'
      | 'sourceVersionNo'
      | 'sourceRecordId'
      | 'matchBefore'
      | 'derivationRule'
      | 'referenceId'
      | 'refSeq'
      | 'reason'
    >
  >;

type OriginTarget = Pick<StoredOrigin, 'businessId' | 'payloadVersionId' | 'employeeId'> & { recordId?: string };

/** undefined 表示该行没有值（SQL NULL），null 表示显式写入 JSON null。 */
const jsonValue = (value: unknown) => (value === undefined ? undefined : sql`${JSON.stringify(value)}::jsonb`);

export async function appendFieldOrigins(
  tx: Tx,
  ctx: Pick<EmploymentContext, 'tenantId' | 'userId' | 'now'> & { commandId?: string | null },
  rows: readonly (FieldOriginDraft & OriginTarget)[],
) {
  if (!rows.length) return;
  await tx.insert(employmentFieldOrigins).values(
    rows.map((row) => ({
      ...row,
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      commandId: ctx.commandId ?? null,
      createdAt: ctx.now,
      value: jsonValue(row.value),
      matchBefore: jsonValue(row.matchBefore),
    })),
  );
}

const textList = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql`${value}::text`),
    sql`, `,
  );

export async function loadFieldOrigins(
  tx: Tx,
  ctx: Pick<EmploymentContext, 'tenantId'>,
  businessId: string,
  fieldCodes?: readonly string[],
) {
  if (fieldCodes?.length === 0) return foldFieldOrigins<StoredOrigin>([]);
  const target = sql`o.tenant_id = ${ctx.tenantId}::uuid AND o.business_id = ${businessId}::uuid`;
  // 使用字段索引逐个找下一编码，避免 DISTINCT 遍历该业务的全部历史行。
  const fields = fieldCodes
    ? sql`field_codes(field_code) AS (SELECT DISTINCT unnest(ARRAY[${textList(fieldCodes)}]))`
    : sql`field_codes(field_code) AS (
        (SELECT o.field_code FROM employment_field_origins o WHERE ${target} ORDER BY o.field_code LIMIT 1)
        UNION ALL
        SELECT next.field_code FROM field_codes AS f
        CROSS JOIN LATERAL (
          SELECT o.field_code FROM employment_field_origins o
          WHERE ${target} AND o.field_code > f.field_code ORDER BY o.field_code LIMIT 1
        ) AS next
      )`;
  const candidates = [FIELD_ORIGIN_POLICIES, ['resolved'], FIELD_ORIGIN_OVERRIDES].map(
    (kinds) => sql`
    SELECT latest.id, latest.field_code, latest.seq FROM field_codes AS f
    CROSS JOIN LATERAL (
      SELECT head.id, head.field_code, head.seq FROM unnest(ARRAY[${textList(kinds)}]) AS k(kind)
      CROSS JOIN LATERAL (
        SELECT o.id, o.field_code, o.seq FROM employment_field_origins o
        WHERE ${target} AND o.field_code = f.field_code AND o.origin_kind = k.kind
        ORDER BY o.seq DESC NULLS LAST LIMIT 1
      ) AS head
      ORDER BY head.seq DESC LIMIT 1
    ) AS latest`,
  );
  const ids = sql`WITH RECURSIVE ${fields}, candidates AS (${sql.join(candidates, sql` UNION ALL `)})
    SELECT id FROM candidates
    UNION ALL
    SELECT decision.id FROM candidates AS c
    CROSS JOIN LATERAL (
      SELECT o.id FROM employment_field_origins o
      WHERE ${target} AND o.field_code = c.field_code AND o.ref_seq = c.seq
        AND o.origin_kind IN ('fallback', 'restore')
      ORDER BY o.seq DESC NULLS LAST LIMIT 1
    ) AS decision`;
  return foldFieldOrigins(await selectOrigins(tx, ctx.tenantId, businessId, ids));
}

interface DerivationAnchorKey {
  readonly fieldCode: string;
  readonly rule: OriginDerivationRule;
  readonly referenceId: string;
}

export async function loadDerivationAnchors(
  tx: Tx,
  ctx: Pick<EmploymentContext, 'tenantId'>,
  businessId: string,
  keys: readonly DerivationAnchorKey[],
): Promise<readonly StoredOrigin[]> {
  if (!keys.length) return [];
  const tuples = keys.map(
    ({ fieldCode, rule, referenceId }) => sql`(${fieldCode}::text, ${rule}::text, ${referenceId}::uuid)`,
  );
  return selectOrigins(
    tx,
    ctx.tenantId,
    businessId,
    sql`
    SELECT DISTINCT anchor.id FROM (VALUES ${sql.join(tuples, sql`, `)}) AS k(field_code, rule, reference_id)
    CROSS JOIN LATERAL (
      SELECT o.id FROM employment_field_origins AS o
      WHERE o.tenant_id = ${ctx.tenantId}::uuid AND o.business_id = ${businessId}::uuid
        AND o.field_code = k.field_code AND o.derivation_rule = k.rule AND o.reference_id = k.reference_id
        AND o.derivation_rule IS NOT NULL AND o.origin_kind IN (${textList(FIELD_ORIGIN_ANCHORS)})
      ORDER BY o.seq DESC NULLS LAST LIMIT 1
    ) AS anchor`,
  );
}

async function selectOrigins(tx: Tx, tenantId: string, businessId: string, ids: ReturnType<typeof sql>) {
  const table = employmentFieldOrigins;
  // 种类由数据库 CHECK 约束，seq/refSeq 经 schema 的 bigint 解码。
  return (await tx
    .select()
    .from(table)
    .where(
      and(eq(table.tenantId, tenantId), eq(table.businessId, businessId), sql`${table.id} IN (${ids})`),
    )) as StoredOrigin[];
}
