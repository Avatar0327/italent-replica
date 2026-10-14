/**
 * 开通租户时的人才标准预置（R1-T17；DEC-281④）：发展建议类型下拉的样本选项“行动建议”。原站完整选项未取到（🟡），
 * 租户之后可在发展建议类型里自行增改、停用。与开通的其他预置同一事务写入，并写数据变更日志（系统写入）。
 */
import { talentDescriptionTypes, type Tx } from '@italent/db';
import { TALENT_DESCRIPTION_TYPE_PRESETS } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { codeOf, TALENT_AUDIT_ACTIONS } from './access.js';
import { loadDescriptionType } from './read-model.js';

export interface TalentPresetContext {
  readonly tenantId: string;
  readonly actorUserId: string | null;
  readonly now: Date;
  readonly commandId: string;
}

export async function installTalentPresets(tx: Tx, write: TalentPresetContext): Promise<void> {
  for (const preset of TALENT_DESCRIPTION_TYPE_PRESETS) {
    const [row] = await tx
      .insert(talentDescriptionTypes)
      .values({
        tenantId: write.tenantId,
        ...preset,
        createdBy: write.actorUserId,
        createdAt: write.now,
        updatedAt: write.now,
      })
      .returning({ id: talentDescriptionTypes.id });
    const after = await loadDescriptionType(tx, write.tenantId, row!.id);
    await recordAudit(tx, {
      tenantId: write.tenantId,
      actorUserId: write.actorUserId,
      action: `${TALENT_AUDIT_ACTIONS.descriptionType}.create`,
      objectType: codeOf('descriptionType'),
      objectId: row!.id,
      before: null,
      after,
      commandId: write.commandId,
      occurredAt: write.now,
    });
  }
}
