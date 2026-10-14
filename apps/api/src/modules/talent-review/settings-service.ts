/**
 * 盘点租户设置（设计 §2.2 settings、§4.1 系统主体）：每租户一行，首次保存（If-Match 0）建立；未建立等于全部默认值。
 * 没有组织字段，读写都要看全部（DEC-121 / 082）。系统主体必须是本租户的有效成员；它决定计算与同步以谁的授权取数，
 * 指定本身是敏感配置，走字段级编辑权与审计（只记改动字段）。
 */
import { and, eq, pgErrorCode, talentReviewSettings as S, tenantMemberships, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { requireConfigCreatable } from './access.js';
import type { SettingsPatch } from './config-input.js';
import { auditConfig, type WriteContext } from './config-kit.js';

const columns = {
  id: S.id,
  allowSecondaryKeyPositionNomination: S.allowSecondaryKeyPositionNomination,
  selfResultVisible: S.selfResultVisible,
  doneHideSuccession: S.doneHideSuccession,
  systemPrincipalUserId: S.systemPrincipalUserId,
  revision: S.revision,
  createdBy: S.createdBy,
  updatedAt: S.updatedAt,
};
export interface SettingsRow {
  readonly id: string | null;
  readonly allowSecondaryKeyPositionNomination: boolean;
  readonly selfResultVisible: boolean;
  readonly doneHideSuccession: boolean;
  readonly systemPrincipalUserId: string | null;
  readonly revision: number;
  readonly createdBy: string | null;
  readonly updatedAt: Date | null;
}
const DEFAULTS: SettingsRow = {
  id: null,
  allowSecondaryKeyPositionNomination: false,
  selfResultVisible: false,
  doneHideSuccession: false,
  systemPrincipalUserId: null,
  revision: 0,
  createdBy: null,
  updatedAt: null,
};

export async function loadSettings(tx: Tx, tenantId: string): Promise<SettingsRow> {
  const [row] = await tx.select(columns).from(S).where(eq(S.tenantId, tenantId));
  return row ?? DEFAULTS;
}

async function requireActiveMember(tx: Tx, tenantId: string, userId: string) {
  const [member] = await tx
    .select({ id: tenantMemberships.id })
    .from(tenantMemberships)
    .where(
      and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.userId, userId),
        eq(tenantMemberships.status, 'active'),
      ),
    );
  if (!member) {
    throw new AppError('VALIDATION_FAILED', '系统主体必须是本租户的有效成员', {
      reason: 'SYSTEM_PRINCIPAL_NOT_MEMBER',
    });
  }
}

export async function updateSettings(tx: Tx, ctx: WriteContext, patch: SettingsPatch): Promise<SettingsRow> {
  requireConfigCreatable(ctx.scope, 'settings');
  if (patch.systemPrincipalUserId) await requireActiveMember(tx, ctx.tenantId, patch.systemPrincipalUserId);
  const [current] = await tx.select(columns).from(S).where(eq(S.tenantId, ctx.tenantId)).for('update');
  if ((current?.revision ?? 0) !== ctx.expectedRevision) {
    throw new AppError('REVISION_CONFLICT', '盘点设置已变更，请刷新后显式重提', {
      expected: ctx.expectedRevision,
      actual: current?.revision ?? 0,
    });
  }
  const audit = { updatedBy: ctx.userId, updatedAt: ctx.now };
  if (current) {
    await tx
      .update(S)
      .set({ ...patch, ...audit, revision: current.revision + 1 })
      .where(and(eq(S.tenantId, ctx.tenantId), eq(S.id, current.id)));
  } else {
    try {
      await tx
        .insert(S)
        .values({ tenantId: ctx.tenantId, ...patch, ...audit, createdBy: ctx.userId, createdAt: ctx.now });
    } catch (error) {
      // 并发的首次保存：另一个事务已建立，等同 revision 不符
      if (pgErrorCode(error) === '23505') {
        throw new AppError('REVISION_CONFLICT', '盘点设置已变更，请刷新后显式重提', { expected: 0, actual: 1 });
      }
      throw error;
    }
  }
  const after = await loadSettings(tx, ctx.tenantId);
  await auditConfig(tx, ctx, 'settings', current ? 'update' : 'create', after.id!, current ?? null, after);
  return after;
}
