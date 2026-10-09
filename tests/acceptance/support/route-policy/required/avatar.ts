/**
 * 必需项表：本人账号头像（modules/avatar/routes.ts、service.ts，#138 F-058）。四个本人入口的数据都按当前用户定位
 * （whereOwner / lockOwner：tenant_id + user_id = 当前用户），命令前后各复核成员身份；头像内容按成员读取，无对象权限。
 */
import type { RequiredTable } from './types.js';

const ROUTES = 'apps/api/src/modules/avatar/routes.ts';
const SERVICE = 'apps/api/src/modules/avatar/service.ts';
const OWNER = { role: 'const', unit: `${SERVICE}#whereOwner`, anchor: 'eq(A.userId, ctx.userId)' } as const;
const LOCK = { role: 'impl', unit: `${SERVICE}#lockOwner`, anchor: 'eq(S.userId, ctx.userId)' } as const;
const PRESENT = [
  { role: 'impl', unit: `${ROUTES}#present`, anchor: 'service.presentAvatar(tx, ctx)' },
  { role: 'impl', unit: `${SERVICE}#currentImage`, anchor: "where(and(whereOwner(ctx), eq(A.status, 'uploaded')))" },
] as const;
const OWN = 'own:account.avatar.owner';

export const AVATAR: RequiredTable = {
  'GET /api/tenant/account/avatar': [
    {
      perm: OWN,
      at: [
        { role: 'call', unit: `${ROUTES}#route:GET /api/tenant/account/avatar`, anchor: 'present(c, deps)' },
        ...PRESENT,
        OWNER,
      ],
    },
  ],
  'POST /api/tenant/account/avatar/attachments': [
    {
      perm: OWN,
      at: [
        {
          role: 'call',
          unit: `${ROUTES}#route:POST /api/tenant/account/avatar/attachments`,
          anchor: 'service.registerAvatar(tx, ctx, input)',
        },
        { role: 'impl', unit: `${SERVICE}#registerAvatar`, anchor: 'await lockOwner(tx, ctx)' },
        LOCK,
        { role: 'impl', unit: `${SERVICE}#registeredAvatar`, anchor: 'where(and(whereOwner(ctx), eq(A.id, id)))' },
        OWNER,
      ],
    },
  ],
  'POST /api/tenant/account/avatar/attachments/:attachmentId/upload': [
    {
      perm: OWN,
      at: [
        {
          role: 'call',
          unit: `${ROUTES}#route:POST /api/tenant/account/avatar/attachments/:attachmentId/upload`,
          anchor: 'service.uploadAvatar(tx, ctx, id, input.base64)',
        },
        {
          role: 'impl',
          unit: `${SERVICE}#uploadAvatar`,
          anchor: 'const attachment = await registeredAvatar(tx, ctx, id)',
        },
        LOCK,
        { role: 'impl', unit: `${SERVICE}#registeredAvatar`, anchor: 'where(and(whereOwner(ctx), eq(A.id, id)))' },
        OWNER,
      ],
    },
  ],
  'DELETE /api/tenant/account/avatar': [
    {
      perm: OWN,
      at: [
        {
          role: 'call',
          unit: `${ROUTES}#route:DELETE /api/tenant/account/avatar`,
          anchor: 'service.deleteAvatar(tx, ctx)',
        },
        { role: 'impl', unit: `${SERVICE}#deleteAvatar`, anchor: 'where(whereOwner(ctx))' },
        LOCK,
        OWNER,
      ],
    },
  ],
  'GET /api/tenant/avatars/:attachmentId/content': [],
};
