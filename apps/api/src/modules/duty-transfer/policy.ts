/**
 * 职责转交菜单路由的 F-039 声明（R2-T09a；DEC-602② / DEC-726）。对象 TenantBase.DutyTransferCommon，数据范围按被转交人
 * （DT-R9）：单人入口经 requireVisiblePerson 用同一范围谓词判定，范围外与不存在同为 404；列表在 SQL 里叠加范围谓词。
 * 写入口经 runCommand（同键同内容重放），守卫 before / replayed 在命令事务内按当前范围复核被转交人；
 * 改写的组织角色 / 下属上级另按真实对象授权（service.authorizeDuty，与联动子项同口径）。
 * 本文件新起的登记名：守卫 dutyTransfer.person，形状 dutyTransfer.duties / dutyTransfer.records，
 * 列表谓词 dutyTransfer.visibility，前提 dutyTransfer.lock / revision / dutyHeld / receiverActive。
 */
import { DUTY_TRANSFER_OBJECT, DUTY_TRANSFER_SET_RECEIVER_BUTTON } from '@italent/domain';
import { defineTable } from '../../route-policy/index.js';
import {
  BAD_REQUEST,
  button,
  fixed,
  guardScope,
  listScope,
  noButton,
  noFields,
  none,
  NOT_FOUND,
  object,
  shape,
  write,
} from '../../route-policy/presets.js';
import { DUTY_TRANSFER_BASE } from './routes.js';

const OBJECT = DUTY_TRANSFER_OBJECT;
const PEOPLE = `${DUTY_TRANSFER_BASE}/people/:id`;
const byId = { invalidId: BAD_REQUEST };
/** requireVisiblePerson：被转交人不在 DutyTransferCommon 范围（或不存在）→ 404「员工不存在」。 */
const person = guardScope('dutyTransfer.person', NOT_FOUND);
const SET_RECEIVER = button(DUTY_TRANSFER_SET_RECEIVER_BUTTON, 'list');
const records = shape('dutyTransfer.records');
const visibility = listScope('dutyTransfer.visibility');

export const DUTY_TRANSFER_POLICIES = defineTable('duty-transfer', {
  [`GET ${PEOPLE}/duties`]: object({
    object: OBJECT,
    operation: 'view',
    button: noButton('菜单回填只读，按对象查看权'),
    scope: person,
    fields: fixed(
      ['employeeId', 'total', 'pendingCount', 'hint', 'items'],
      'routes.ts 职责清单：固定键，items 是被转交人当前职责与未完成转交（职责描述、接收人 ID、转交日期）',
    ),
    ...byId,
  }),
  // 确认信息：只读，不进台账、不写数据；结果为确认信封（条数、接收人、提示）
  [`POST ${PEOPLE}/check`]: object({
    object: OBJECT,
    operation: 'create',
    button: SET_RECEIVER,
    scope: person,
    fields: noFields('确认信封（count / receivers / message / warnings），不是对象字段'),
    write: write(none('只读确认，不提取字段'), none('只读确认，不进台账'), 'dutyTransfer.person'),
    ...byId,
  }),
  [`POST ${PEOPLE}`]: object({
    object: OBJECT,
    operation: 'create',
    button: SET_RECEIVER,
    scope: person,
    fields: records,
    write: write('body', 'dutyTransfer.person', 'dutyTransfer.person', {
      ledger: 'single',
      preconditions: [
        'dutyTransfer.lock',
        'dutyTransfer.revision',
        'dutyTransfer.dutyHeld',
        'dutyTransfer.receiverActive',
      ],
    }),
    ...byId,
  }),
  [`GET ${DUTY_TRANSFER_BASE}/records`]: object({
    object: OBJECT,
    operation: 'view',
    button: noButton('转交记录只读，按对象查看权'),
    scope: visibility,
    fields: records,
  }),
  [`GET ${DUTY_TRANSFER_BASE}/departed`]: object({
    object: OBJECT,
    operation: 'view',
    button: noButton('检查离职退休人员只读，按对象查看权'),
    scope: visibility,
    fields: fixed(['total', 'items'], 'routes.ts 离职退休人员：固定键，items 只含范围内人员的 ID、类型、日期与职责数'),
  }),
});
