/** 最终时间轴是重建目标与前驱关系的唯一依据，创建时的 inheritance_source_id 不决定重建顺序。 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { ForwardValues } from './forward-rules.js';
import { orgAdjustmentHistory, type AdjustmentHistory } from './org-adjustment-history.js';
import { calculateOrgAdjustment } from './org-adjustment-recompute.js';
import { loadEmploymentRecord, snapshotFields } from './read-model.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext, EmploymentRecord } from './types.js';

interface Point {
  readonly id: string;
  readonly date: string;
  readonly order: number;
}
export interface AdjustmentCalculation {
  readonly record: EmploymentRecord;
  readonly history: readonly AdjustmentHistory[];
  readonly values: ForwardValues;
}
interface TimelineReader {
  record(id: string): Promise<EmploymentRecord | null>;
  point(id: string): Promise<Point | null>;
  history(record: EmploymentRecord): Promise<readonly AdjustmentHistory[]>;
  deleted(id: string): Promise<boolean>;
}

export async function calculateAdjustmentTimeline(
  tx: Tx,
  ctx: EmploymentContext,
  source: EmploymentRecord,
  actualDate: string,
): Promise<AdjustmentCalculation[]> {
  const targets = rowsOf<Point>(
    await tx.execute(sql`
    SELECT t.record_id AS id,t.start_date::text AS date,t.sort_order AS "order"
    FROM employment_timeline t JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${source.employeeId}::uuid
      AND t.staff_id=${source.staffId}::uuid AND r.kind='org_adjustment'
      AND t.start_date>=${source.effectiveDate}::date AND t.start_date<${actualDate}::date
    ORDER BY t.start_date,t.sort_order LIMIT 1001`),
  );
  if (targets.length > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '派生组织调整超过单次处理上限');
  const reader = timelineReader(tx, ctx, source, actualDate, targets);
  const compute = timelineCalculator(tx, ctx, reader, new Set(targets.map((point) => point.id)));
  const result: AdjustmentCalculation[] = [];
  for (const target of targets) {
    const record = await reader.record(target.id);
    if (!record?.previousRecordId) continue;
    const previous = await reader.record(record.previousRecordId);
    if (previous?.staffId !== record.staffId) continue;
    result.push({ record, history: await reader.history(record), values: await compute(record) });
  }
  return result;
}

function timelineReader(
  tx: Tx,
  ctx: EmploymentContext,
  source: EmploymentRecord,
  date: string,
  targets: readonly Point[],
): TimelineReader {
  const records = new Map<string, EmploymentRecord | null>();
  const histories = new Map<string, readonly AdjustmentHistory[]>();
  const points = new Map<string, Point | null>(targets.map((point) => [point.id, point]));
  const tombstones = new Map<string, boolean>();
  return {
    async record(id) {
      if (!records.has(id)) records.set(id, await loadEmploymentRecord(tx, ctx.tenantId, id, date));
      const record = records.get(id) ?? null;
      return record?.employeeId === source.employeeId && record.staffId === source.staffId ? record : null;
    },
    async point(id) {
      if (!points.has(id)) {
        const [point] = rowsOf<Point>(
          await tx.execute(sql`SELECT record_id AS id,start_date::text AS date,sort_order AS "order"
          FROM employment_timeline WHERE tenant_id=${ctx.tenantId} AND employee_id=${source.employeeId}::uuid
            AND staff_id=${source.staffId}::uuid AND record_id=${id}::uuid`),
        );
        points.set(id, point ?? null);
      }
      return points.get(id) ?? null;
    },
    async history(record) {
      if (!histories.has(record.id)) histories.set(record.id, await orgAdjustmentHistory(tx, ctx, record));
      return histories.get(record.id)!;
    },
    async deleted(id) {
      if (!tombstones.has(id)) {
        const [row] = rowsOf<{ id: string }>(
          await tx.execute(sql`SELECT id FROM employment_record_tombstones
          WHERE tenant_id=${ctx.tenantId} AND employee_id=${source.employeeId}::uuid AND record_id=${id}::uuid`),
        );
        tombstones.set(id, !!row);
      }
      return tombstones.get(id)!;
    },
  };
}

function timelineCalculator(tx: Tx, ctx: EmploymentContext, reader: TimelineReader, targets: ReadonlySet<string>) {
  const calculated = new Map<string, ForwardValues>();
  const compute = async (record: EmploymentRecord, versionNo = Infinity): Promise<ForwardValues> => {
    const key = `${record.id}:${versionNo}`;
    const cached = calculated.get(key);
    if (cached) return cached;
    let values: ForwardValues = record;
    if (record.kind !== 'org_adjustment' && Number.isFinite(versionNo)) {
      values = await sourceSnapshot(tx, ctx, record, versionNo);
    } else if (record.kind === 'org_adjustment' && (targets.has(record.id) || Number.isFinite(versionNo))) {
      const previous = record.previousRecordId ? await reader.record(record.previousRecordId) : null;
      if (previous) {
        const history = (await reader.history(record)).filter((item) => item.payload.versionNo <= versionNo);
        if (history.length)
          values = await calculateOrgAdjustment(tx, ctx, record, history, await compute(previous), {
            deleted: (id) => reader.deleted(id),
            resolve: async (id, cut) => {
              const targetPoint = await reader.point(record.id);
              const sourcePoint = await reader.point(id);
              if (!targetPoint || !sourcePoint || !pointBefore(sourcePoint, targetPoint) || cut === null) return null;
              const source = await reader.record(id);
              if (!source) return null;
              const sourceHistory = (await reader.history(source)).filter((item) => item.payload.versionNo <= cut);
              const command = sourceHistory.at(-1)?.command.type;
              const previousSource = source.previousRecordId ? await reader.record(source.previousRecordId) : null;
              const edit = command === 'manual' || command === 'forward' || command === 'sequence-sync';
              const before = edit ? await compute(source, cut - 1) : previousSource && (await compute(previousSource));
              return before ? { before, after: await compute(source, cut) } : null;
            },
          });
      }
    }
    calculated.set(key, values);
    return values;
  };
  return compute;
}

function pointBefore(source: Point, target: Point) {
  return source.date < target.date || (source.date === target.date && source.order < target.order);
}

/** 独立业务不重写；依赖读取曾传播的事件版本，不能把后来的、不传播的历史更正倒灌到目标。 */
async function sourceSnapshot(tx: Tx, ctx: EmploymentContext, record: EmploymentRecord, versionNo: number) {
  const [row] = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
    SELECT COALESCE(p.body,to_jsonb(r)) AS body FROM employment_records r
    LEFT JOIN LATERAL (SELECT to_jsonb(v) AS body FROM employment_payload_versions v
      WHERE v.tenant_id=r.tenant_id AND v.business_id=r.id AND v.employee_id=r.employee_id
        AND v.is_record_snapshot AND v.version_no<=${versionNo}
      ORDER BY v.version_no DESC LIMIT 1) p ON true
    WHERE r.tenant_id=${ctx.tenantId} AND r.employee_id=${record.employeeId}::uuid AND r.id=${record.id}::uuid`),
  );
  const body = row!.body as Record<string, unknown>;
  return { fields: snapshotFields(body), customFields: body.custom_fields as EmploymentRecord['customFields'] };
}
