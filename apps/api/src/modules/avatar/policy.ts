/**
 * 账号头像（F-058，DEC-327）路由的现状声明（F-039 PR-A：处理函数不变）。
 * - /api/tenant/account/avatar*：只操作调用者本人的头像（service.ownMember：在职成员 + 账号有效），没有对象权限、
 *   没有管理员代改分支；写入口同源校验、If-Match revision（REVISION_CONFLICT）、命令台账与审计 / outbox 同事务。
 * - /api/tenant/avatars/:attachmentId/content：头像是租户内展示资料，任何在职成员按附件 ID 读当前有效头像的字节；
 *   不存在 / 未上传 / 属主已停用一律 404「头像不存在」，不提供人员查找与元数据。
 */
import { defineTable, type RoutePolicy } from '../../route-policy/index.js';
import { BAD_REQUEST, fixed, none, own, write } from '../../route-policy/presets.js';

const BASE = '/api/tenant/account/avatar';
/** job/context.ts uuidParam：路径标识非 UUID → 400 VALIDATION_FAILED。 */
const byId = { invalidId: BAD_REQUEST };
/** presentAvatar 回执：revision（ETag 同值）、本人姓名、当前头像引用（id / url）。 */
const PRESENT = fixed(['revision', 'name', 'avatar'], 'avatar/service.ts presentAvatar（DEC-327）');
const owner = 'account.avatar.owner';

/** 本人头像写入：请求体是图片元数据 / 字节，不是对象字段；事务内锁本人头像头并复核在职成员，返回前再按本人投影。 */
function ownWrite(fields: ReturnType<typeof fixed>, extra: { invalidId?: typeof BAD_REQUEST } = {}): RoutePolicy {
  return own({
    predicate: owner,
    fields,
    ...extra,
    write: write(
      none('头像登记元数据 / 图片字节，不经对象字段权限（本人账号资料）'),
      'account.avatar.ownerLock',
      none('回执只含本人头像，返回前按当前在职成员重新投影'),
    ),
  });
}

export const AVATAR_POLICIES = defineTable('avatar', {
  [`GET ${BASE}`]: own({ predicate: owner, fields: PRESENT }),
  // 登记回执 `{ revision, attachment }`（registeredAvatar：id / filename / contentType / byteSize / sha256 / status）
  [`POST ${BASE}/attachments`]: ownWrite(fixed(['revision', 'attachment'], 'avatar/routes.ts 登记回执')),
  [`POST ${BASE}/attachments/:attachmentId/upload`]: ownWrite(PRESENT, byId),
  [`DELETE ${BASE}`]: ownWrite(PRESENT),
  'GET /api/tenant/avatars/:attachmentId/content': {
    kind: 'member',
    reason: 'DEC-327：头像是租户内展示资料，在职成员按附件 ID 读当前有效头像字节；不存在 / 未上传 / 属主停用同为 404',
    fields: fixed(['<binary>'], 'avatarContent：图片字节，nosniff、no-store'),
    ...byId,
  },
});
