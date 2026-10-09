/** F-058：公开头像只使用既有链接上下文的本单具名人员；令牌继续由请求头传递。 */
import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { personAvatars, type AvatarReference } from '../avatar/references.js';
import { avatarContentBytes } from '../avatar/service.js';

export async function linkAvatars(tx: Tx, tenantId: string, personIds: readonly string[]) {
  const avatars = await personAvatars(tx, tenantId, personIds);
  return new Map(
    [...avatars].map(([personId, avatar]) => [
      personId,
      avatar ? { id: avatar.id, url: `/api/survey360/link/avatars/${avatar.id}/content` } : null,
    ]),
  ) satisfies Map<string, AvatarReference | null>;
}

/** allowedPersonIds 必须由当前链接可见的具名人员生成，不能传租户范围或客户端人员编号。 */
export async function linkAvatarContent(
  tx: Tx,
  tenantId: string,
  allowedPersonIds: readonly string[],
  attachmentId: string,
) {
  const avatars = await personAvatars(tx, tenantId, allowedPersonIds);
  if (![...avatars.values()].some((avatar) => avatar?.id === attachmentId)) return undefined;
  try {
    return await avatarContentBytes(tx, tenantId, attachmentId);
  } catch (error) {
    // 引用解析后删除或替换也不能产生与未知 / 他单头像不同的链接错误。
    if (error instanceof AppError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
}
