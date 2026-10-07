/** DEC-186 / 195：历史提供命令意图和来源依赖，传播及重建的旧字段快照不作为重算输入。 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { FieldDerivation } from './field-derivations.js';
import { camelRow, rowsOf, snapshotFields, type EmploymentPayloadRow } from './record-store.js';
import {
  PRESET_FIELD_NAMES,
  type CustomFields,
  type EmploymentBusinessPatch,
  type EmploymentContext,
  type EmploymentRecord,
  type PresetFields,
} from './types.js';

export type RecordEditPatch = Pick<EmploymentBusinessPatch, 'fields' | 'customFields'>;
export type AdjustmentCommand =
  | { readonly type: 'initial' }
  | { readonly type: 'manual'; readonly patch: RecordEditPatch; readonly derivations: readonly FieldDerivation[] }
  | {
      readonly type: 'sequence-sync';
      readonly sourceKind: 'posts' | 'positions';
      readonly sourceId: string;
      readonly sequenceId: string | null;
    }
  | {
      readonly type: 'forward';
      readonly sourceId: string;
      readonly sourceVersionNo: number | null;
      /** 传播当时实际改写的字段：来源删除后这些值视为意图（DEC-244②）。 */
      readonly retained: RecordEditPatch;
      /** 传播当时参与值匹配的自定义字段，按传播时的继承配置固定（DEC-244③）；存量无记录时为 null。 */
      readonly customFieldIds: readonly string[] | null;
    }
  | { readonly type: 'output' };
export interface AdjustmentHistory {
  readonly payload: EmploymentPayloadRow;
  readonly command: AdjustmentCommand;
}

/** 最后一版完整业务输入及其后的命令：申请修改前的版本已被整版替换，不再是重建输入。 */
export function effectiveInput(history: readonly AdjustmentHistory[]) {
  const index = history.findLastIndex((item) => item.command.type === 'initial');
  return { initial: history[Math.max(index, 0)]!.payload, commands: history.slice(Math.max(index, 0) + 1) };
}
interface CommandEvent {
  readonly eventType: string;
  readonly payload: {
    readonly before?: Record<string, unknown>;
    readonly after?: Record<string, unknown>;
    readonly meta?: {
      readonly patch?: RecordEditPatch;
      readonly fieldDerivations?: readonly FieldDerivation[];
      readonly sourceKind?: 'posts' | 'positions';
      readonly sourceId?: string;
      readonly sourceVersionNo?: number;
    };
  };
}

export async function orgAdjustmentHistory(tx: Tx, ctx: EmploymentContext, record: EmploymentRecord) {
  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
    SELECT p.*,(SELECT jsonb_build_object('eventType',o.event_type,'payload',o.payload)
        FROM employment_outbox o WHERE o.tenant_id=p.tenant_id AND o.business_id=p.business_id
          AND o.event_type IN ('employment.record.edit','employment.sequence-sync','employment.forward-update',
            'employment.org-adjustment.rebased','employment.business.payload.append')
          AND (o.payload_version_id=p.id OR (o.payload_version_id IS NULL
            AND o.event_type='employment.record.edit' AND o.command_id=p.command_id))
        ORDER BY CASE WHEN o.payload_version_id=p.id THEN 0 ELSE 1 END,o.id LIMIT 1) AS command_event,
      COALESCE((SELECT source.version_no FROM employment_payload_versions source
          WHERE source.tenant_id=p.tenant_id AND source.business_id=p.trigger_business_id
            AND source.command_id=p.command_id ORDER BY source.version_no DESC LIMIT 1),
        (SELECT source.version_no FROM employment_records r JOIN employment_payload_versions source
          ON source.tenant_id=r.tenant_id AND source.id=r.payload_version_id
          WHERE r.tenant_id=p.tenant_id AND r.id=p.trigger_business_id)) AS source_version_no
    FROM employment_payload_versions p WHERE p.tenant_id=${ctx.tenantId} AND p.business_id=${record.id}::uuid
    ORDER BY p.version_no LIMIT 1001`),
  );
  if (rows.length > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '组织调整载荷历史超过处理上限');
  return rows.map((row): AdjustmentHistory => {
    const { commandEvent, sourceVersionNo, ...raw } = camelRow(row);
    const payload = { ...raw, fields: snapshotFields(raw) } as unknown as EmploymentPayloadRow;
    return {
      payload,
      command: classifyCommand(payload, commandEvent as CommandEvent | null, Number(sourceVersionNo) || null),
    };
  });
}

function classifyCommand(
  payload: EmploymentPayloadRow,
  event: CommandEvent | null,
  sourceVersionNo: number | null,
): AdjustmentCommand {
  if (payload.versionNo === 1) return { type: 'initial' };
  // 申请修改（草稿修改、驳回后重提、审批节点编辑、编辑并同意）整版替换业务输入；存量未绑定事件的落地前版本同样如此。
  if (event?.eventType === 'employment.business.payload.append') return { type: 'initial' };
  if (!event && !payload.isRecordSnapshot && !payload.triggerBusinessId) return { type: 'initial' };
  if (!event || event.eventType === 'employment.org-adjustment.rebased') return { type: 'output' };
  const { after = {}, meta = {} } = event.payload;
  if (event.eventType === 'employment.record.edit')
    return {
      type: 'manual',
      patch: meta.patch ?? legacyEditPatch(event.payload.before ?? {}, after),
      derivations: meta.fieldDerivations ?? [],
    };
  if (event.eventType === 'employment.sequence-sync' && meta.sourceKind && meta.sourceId)
    return {
      type: 'sequence-sync',
      sourceKind: meta.sourceKind,
      sourceId: meta.sourceId,
      sequenceId: typeof after.sequenceId === 'string' ? after.sequenceId : null,
    };
  if (event.eventType === 'employment.forward-update' && payload.triggerBusinessId) {
    const retained = patchOf(after);
    return {
      type: 'forward',
      sourceId: payload.triggerBusinessId,
      sourceVersionNo: meta.sourceVersionNo ?? sourceVersionNo,
      retained,
      customFieldIds: event.payload.after ? Object.keys(retained.customFields) : null,
    };
  }
  return { type: 'output' };
}

/** 事件 after 里的预置 / 自定义字段值。 */
function patchOf(after: Record<string, unknown>): RecordEditPatch {
  const fields: Partial<PresetFields> = {};
  const customFields: Record<string, CustomFields[string]> = {};
  for (const [field, value] of Object.entries(after)) {
    if (field.startsWith('custom:')) customFields[field.slice(7)] = value as CustomFields[string];
    else if (PRESET_FIELD_NAMES.includes(field as (typeof PRESET_FIELD_NAMES)[number]))
      Object.assign(fields, { [field]: value });
  }
  return { fields, customFields };
}

/** 兼容未保存 patch 的人工编辑事件；只提取该命令明确改动的输入，不读取载荷版本差值。 */
function legacyEditPatch(before: Record<string, unknown>, after: Record<string, unknown>): RecordEditPatch {
  return patchOf(
    Object.fromEntries(
      Object.entries(after).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(before[field])),
    ),
  );
}
