/**
 * BE-13b 人员流动分析看板 / 流动情况报表三个只读路由的 F-039 声明：权限是各自对象的查看权（入口以对象常量调
 * objectContext，再经 analyticsScope 解析同对象范围），范围按同一对象的数据范围解析（页面编码 <对象>.list）。
 * 取数 SQL 在时点 / 离职 / 入职 / 调动四类行集上先叠加可见谓词再计算（hr-movement.ts）。
 * 响应只含固定键的计数、分组与 ID；报表的列由离职类型 / 原因字典（零计数填 0）与职务序列字典展开，单元格是范围内的计数 / 比率。
 */
import { HR_MOVEMENT_OBJECT, HR_MOVEMENT_REPORT_OBJECT } from '@italent/domain';
import { defineTable } from '../../route-policy/index.js';
import { fixed, listScope, noButton, object } from '../../route-policy/presets.js';
import { HR_MOVEMENT_BASE } from './hr-movement-routes.js';

const read = (code: string) => (fields: ReturnType<typeof fixed>) =>
  object({
    object: code,
    operation: 'view',
    button: noButton('看板 / 报表只读，按对象查看权'),
    scope: listScope('hrMovement.visibility'),
    fields,
  });
const board = read(HR_MOVEMENT_OBJECT);
const report = read(HR_MOVEMENT_REPORT_OBJECT);

export const HR_MOVEMENT_POLICIES = defineTable('hr-movement', {
  [`GET ${HR_MOVEMENT_BASE}`]: board(
    fixed(['asOf', 'hasDataPermission', 'components'], 'hr-movement-routes.ts 概览：固定键，组件值是范围内的计数'),
  ),
  [`GET ${HR_MOVEMENT_BASE}/components/:code`]: board(
    fixed(
      ['asOf', 'code', 'name', 'kind', 'group', 'total', 'items', 'page', 'pageSize', 'hasDataPermission'],
      'hr-movement-routes.ts 明细：固定键，items 只含范围内的 ID',
    ),
  ),
  [`GET ${HR_MOVEMENT_BASE}/reports/:report`]: report(
    fixed(
      ['asOf', 'report', 'name', 'kind', 'year', 'month', 'hasDataPermission', 'tables'],
      'hr-movement-routes.ts 报表：固定键，单元格是范围内的计数 / 比率',
    ),
  ),
});
