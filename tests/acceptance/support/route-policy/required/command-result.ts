/**
 * 必需项表：本人命令结果查询（modules/command-result，F-120）。唯一入口按当前用户定位：命令台账与失败命令审计都固定
 * tenant_id（RLS + 显式条件）与 actor_user_id = 当前用户，别人的命令与不存在同为 404；只读，无对象权限、按钮、范围。
 */
import type { RequiredTable } from './types.js';

const ROUTES = 'apps/api/src/modules/command-result/routes.ts';
const SERVICE = 'apps/api/src/modules/command-result/service.ts';

export const COMMAND_RESULT: RequiredTable = {
  'GET /api/tenant/commands/:commandId/result': [
    {
      perm: 'own:command.result.initiator',
      at: [
        {
          role: 'call',
          unit: `${ROUTES}#route:GET /api/tenant/commands/:commandId/result`,
          anchor: 'readOwnCommandResult(tx, ctx, commandId)',
        },
        { role: 'impl', unit: `${SERVICE}#readOwnCommandResult`, anchor: 'eq(commandLedger.actorUserId, ctx.userId)' },
        {
          role: 'impl',
          unit: `${SERVICE}#readOwnCommandResult`,
          anchor: 'eq(auditCommandFailures.actorUserId, ctx.userId)',
        },
      ],
    },
  ],
};
