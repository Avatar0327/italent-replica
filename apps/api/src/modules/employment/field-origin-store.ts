import { and, employmentFieldOrigins, eq, sql, type Tx } from '@italent/db';
import {
  FIELD_ORIGIN_ANCHORS,
  FIELD_ORIGIN_OVERRIDES,
  FIELD_ORIGIN_POLICIES,
  FORM_DEPENDENCY_RESET,
  effectiveOrigin,
  foldFieldOrigins,
  projectOriginMarkers,
  settleValueRows,
  type FieldOriginKind,
  type OriginDerivationRule,
} from '@italent/domain';
import type { EmploymentContext, PresetFields } from './types.js';

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
  return foldFieldOrigins(await loadFieldOriginRows(tx, ctx, businessId, fieldCodes));
}

async function loadFieldOriginRows(
  tx: Tx,
  ctx: Pick<EmploymentContext, 'tenantId'>,
  businessId: string,
  fieldCodes?: readonly string[],
) {
  if (fieldCodes?.length === 0) return [];
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
      ORDER BY (o.origin_kind = 'fallback' AND o.reason IS NOT DISTINCT FROM ${FORM_DEPENDENCY_RESET}) DESC,
        o.seq DESC NULLS LAST LIMIT 1
    ) AS decision`;
  return selectOrigins(tx, ctx.tenantId, businessId, ids);
}

export async function projectPayloadMarkers(
  tx: Tx,
  ctx: Pick<EmploymentContext, 'tenantId'>,
  payload: {
    businessId: string;
    previousVersionId: string | null;
    explicitFieldCodes?: readonly string[];
    deferredFieldCodes?: readonly string[];
  },
  origins: readonly FieldOriginDraft[],
) {
  const stored = payload.previousVersionId ? await loadFieldOriginRows(tx, ctx, payload.businessId) : [];
  const head = stored.reduce((max, row) => (row.seq > max ? row.seq : max), 0n);
  // 外键要求先写载荷。这里只按本事务内的相对顺序折叠拟写行，实际 seq 仍由数据库分配。
  const pending = origins.map((row, index) => ({ ...row, seq: head + BigInt(index + 1), value: row.value }));
  return projectOriginMarkers(foldFieldOrigins([...stored, ...pending]), payload);
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

/** 适用性判定的候选态：字段值与仍待定的延迟字段。返回 undefined 表示暂时无法判断，不写判定行。 */
export interface SettleCandidate {
  readonly fields: PresetFields;
  readonly deferredFieldCodes: readonly string[];
}
export type FieldApplicability = (row: { readonly value?: unknown }, candidate: SettleCandidate) => boolean | undefined;

// F-036 §4.6：谓词由业务规则注册（DEC-232 的“职位属于任职部门”由 #99 重做提供）；S6 只交付机制，产品代码不注册。
const applicability = new Map<string, FieldApplicability>();

/** 为字段注册适用性谓词，返回注销函数。 */
export function registerFieldApplicability(fieldCode: string, predicate: FieldApplicability): () => void {
  applicability.set(fieldCode, predicate);
  return () => {
    if (applicability.get(fieldCode) === predicate) applicability.delete(fieldCode);
  };
}

interface SettleOptions {
  /** 本次保存拟写的来源行；新写的继承行会按谓词判定，等价于台账现有策略行的不重复追加。 */
  readonly pending?: readonly FieldOriginDraft[];
  /** 本次请求自己输入的字段：台账里的旧行照判，但新输入的值原样保留，由校验把关。 */
  readonly skip?: ReadonlySet<string>;
}

export interface SettledFields {
  /** 被台账接管的字段 → 判定之后的有效值。 */
  readonly values: ReadonlyMap<string, unknown>;
  /** 判定之后仍待落地解析的延迟字段。 */
  readonly deferred: ReadonlySet<string>;
  /** 判定之后有效值仍来自人工覆盖的字段。 */
  readonly explicit: ReadonlySet<string>;
  /** 本次保存应写的全部来源行（含判定行）。 */
  readonly origins: FieldOriginDraft[];
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * F-036 §4.6：覆盖值、继承值、落地解析值各自判适用性，各自写 fallback / restore 行；
 * 返回调整后的字段值（只含被台账接管的字段）与应写的全部来源行。草稿修改、落地共用这一个入口。
 */
export async function settleFieldValues(
  tx: Tx,
  ctx: Pick<EmploymentContext, 'tenantId'>,
  businessId: string,
  candidate: SettleCandidate,
  options: SettleOptions = {},
): Promise<SettledFields> {
  const origins = [...(options.pending ?? [])];
  const values = new Map<string, unknown>();
  const deferred = new Set<string>();
  const explicit = new Set<string>();
  const codes = [...applicability.keys()];
  if (!codes.length) return { values, deferred, explicit, origins };
  const states = await loadFieldOrigins(tx, ctx, businessId, codes);
  const decisions: FieldOriginDraft[] = [];
  for (const fieldCode of codes) {
    const applies = applicability.get(fieldCode)!;
    const state = states.get(fieldCode);
    const index = origins.findIndex(
      (row) => row.fieldCode === fieldCode && (row.originKind === 'inherit' || row.originKind === 'copy'),
    );
    const draft = origins[index];
    let replacedPolicy = false;
    if (draft) {
      const saved = state?.policyRow;
      // 已退回（suspended）的策略行被判定遮住了值，重新推导出来的草稿值不可信：沿用台账里的那一条，等它恢复。
      const unchanged = saved && saved.originKind === draft.originKind;
      if (unchanged && (sameValue(saved.value, draft.value) || state.suspended.has(saved.seq)))
        origins.splice(index, 1);
      else if (applies(draft, candidate) === false) {
        // 新写的行还没有 seq，无法被判定行引用：直接记成不继承，值为空。
        origins[index] = { fieldCode, originKind: 'none' };
        values.set(fieldCode, null);
        continue;
      } else replacedPolicy = true;
    }
    if (!state) continue;
    const settled = settleValueRows(state, (row) => applies(row, candidate));
    const suspended = new Set(state.suspended);
    for (const { originKind, refSeq } of settled) {
      if (originKind === 'fallback') suspended.add(refSeq);
      else suspended.delete(refSeq);
      decisions.push({ fieldCode, originKind, refSeq });
    }
    const next = effectiveOrigin({ ...state, suspended });
    const taken = settled.length > 0 || state.suspended.size > 0;
    if (taken && !(replacedPolicy && next.lastWriter === state.policyRow)) {
      values.set(fieldCode, next.value);
      if (next.lastWriter && next.lastWriter === state.override) explicit.add(fieldCode);
      // 覆盖值被退回后，延迟策略的字段重新回到“待定”，由落地时的前驱解析。
      if (state.policy === 'deferred' && (!next.lastWriter || next.lastWriter === state.resolved))
        deferred.add(fieldCode);
    }
  }
  for (const code of options.skip ?? []) {
    values.delete(code);
    deferred.delete(code);
    explicit.delete(code);
  }
  return { values, deferred, explicit, origins: [...origins, ...decisions] };
}
