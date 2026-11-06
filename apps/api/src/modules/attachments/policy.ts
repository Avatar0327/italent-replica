/**
 * 通用附件（F-479 S1）路由声明。五个入口都经 selfAccess（员工自助，仅本人）：
 * - 写（登记 / 上传 / 删除）：绑定员工 + Exit.Self 按钮 + TenantBase.SelfExit.attachmentRefs 可编辑，同源校验、
 *   命令台账（CommandGuard.before 在查台账前复核）、If-Match revision、审计 / outbox 同事务；
 * - 读（元数据 / 内容）：绑定员工 + Exit.Self 按钮 + attachmentRefs 可查看；只给本人名下未绑定文件，别人的、
 *   跨租户的、已绑定的、已删除的一律 404「附件不存在」，registered 只有元数据，内容 404。
 */
import { defineTable, type RoutePolicy } from '../../route-policy/index.js';
import { BAD_REQUEST, button, fixed, none, self, write } from '../../route-policy/presets.js';

const BASE = '/api/tenant/attachments';
const byId = { invalidId: BAD_REQUEST };
const EXIT_SELF = button('Exit.Self', 'detail');
const RECEIPT = fixed(
  [
    'kind',
    'id',
    'revision',
    'status',
    'purpose',
    'filename',
    'contentType',
    'byteSize',
    'sha256',
    'expiresAt',
    'uploadedAt',
    'createdAt',
  ],
  'attachments/service.ts receipt（F-479 设计 §5.1.1）',
);

/** 写入口：Exit.Self 按钮 + 固定字段 attachmentRefs 的可编辑复核（requireAttachmentWrite → requireEmploymentWrite）。 */
function ownWrite(extra: { invalidId?: typeof BAD_REQUEST } = {}): RoutePolicy {
  return self({
    button: EXIT_SELF,
    fields: RECEIPT,
    ...extra,
    write: write(
      'body',
      { none: true, reason: '附件元数据 / 图片字节，无对象足迹；用途守卫已复核按钮与字段' },
      none('回执只含本人名下附件元数据，不含字节'),
      {
        ledger: 'single',
      },
    ),
  });
}

export const ATTACHMENT_POLICIES = defineTable('attachments', {
  [`POST ${BASE}`]: ownWrite(),
  [`POST ${BASE}/:id/upload`]: ownWrite(byId),
  [`DELETE ${BASE}/:id`]: ownWrite(byId),
  [`GET ${BASE}/:id`]: self({ button: EXIT_SELF, fields: RECEIPT, ...byId }),
  [`GET ${BASE}/:id/content`]: self({
    button: EXIT_SELF,
    fields: fixed(['<binary>'], '附件字节：attachment、nosniff、sandbox CSP、no-store'),
    ...byId,
  }),
});
