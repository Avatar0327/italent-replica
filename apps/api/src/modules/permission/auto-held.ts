/**
 * 自动持有的标准身份（目前只有“员工”，DEC-399 / DEC-402③；契约 §2.2）：全体员工经本人入口的叠加授权器按关系自动适用，
 * 不发授权行，所以不能手工授予、不进任何管理员的可授权业务身份集合。只认 source='standard' 且定义里 autoHeld 的身份：
 * 租户手工建的同编码 custom 行（CODE_TAKEN）不受这些约束，保持原状。
 */
import { inArray, permissionProfiles, type Tx } from '@italent/db';
import { STANDARD_PROFILES } from '@italent/domain';
import { AppError } from '../../errors.js';

const AUTO_HELD_CODES: readonly string[] = STANDARD_PROFILES.filter((p) => p.autoHeld).map((p) => p.code);

export const isAutoHeld = (profile: { readonly source: string; readonly code: string }): boolean =>
  profile.source === 'standard' && AUTO_HELD_CODES.includes(profile.code);

/** ids 里有自动持有的标准身份即 403 PROFILE_AUTO_HELD（不存在的 id 不在这里判，交给各自原有的校验）。 */
export async function assertNotAutoHeld(tx: Tx, profileIds: readonly string[]): Promise<void> {
  if (profileIds.length === 0) return;
  const rows = await tx
    .select({ id: permissionProfiles.id, code: permissionProfiles.code, source: permissionProfiles.source })
    .from(permissionProfiles)
    .where(inArray(permissionProfiles.id, [...profileIds]));
  const held = rows.filter(isAutoHeld);
  if (held.length > 0)
    throw new AppError('FORBIDDEN', '该身份自动适用于全体员工，不能手工授予', {
      reason: 'PROFILE_AUTO_HELD',
      profileIds: held.map((p) => p.id),
    });
}
