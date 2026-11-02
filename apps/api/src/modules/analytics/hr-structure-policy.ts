/**
 * BE-13a 三个只读看板 / 报表路由的 F-039 声明：权限都是各自对象的查看权（各入口以对象常量调 objectContext，再经 analyticsScope 解析同对象范围），
 * 范围按同一对象的数据范围解析（requestScope，页面编码 <对象>.list）。人员结构分析 / 员工结构报表在取数 SQL 里
 * 先叠加可见谓词再分组（hr-structure.ts structurePeople）；合同情况在每个组件的候选行上叠加（contract-board.ts boardRows）。
 * 响应只含固定键的计数、分组与 ID；报表的列由字典展开，单元格是范围内的计数 / 平均值。
 */
import { CONTRACT_BOARD_OBJECT, HR_STRUCTURE_OBJECT, HR_STRUCTURE_REPORT_OBJECT } from '@italent/domain';
import { defineTable } from '../../route-policy/index.js';
import { fixed, listScope, noButton, object } from '../../route-policy/presets.js';
import { CONTRACT_BOARD_BASE } from './contract-board-routes.js';
import { HR_STRUCTURE_BASE } from './hr-structure-routes.js';

const read = (code: string, predicate: string) => (fields: ReturnType<typeof fixed>) =>
  object({
    object: code,
    operation: 'view',
    button: noButton('看板 / 报表只读，按对象查看权'),
    scope: listScope(predicate),
    fields,
  });
const board = read(HR_STRUCTURE_OBJECT, 'hrStructure.visibility');
const report = read(HR_STRUCTURE_REPORT_OBJECT, 'hrStructure.visibility');
const contract = read(CONTRACT_BOARD_OBJECT, 'contractBoard.visibility');
const DETAIL_KEYS = [
  'asOf',
  'code',
  'name',
  'kind',
  'group',
  'total',
  'items',
  'page',
  'pageSize',
  'hasDataPermission',
];

export const HR_STRUCTURE_POLICIES = defineTable('hr-structure', {
  [`GET ${HR_STRUCTURE_BASE}`]: board(
    fixed(['asOf', 'hasDataPermission', 'components'], 'hr-structure-routes.ts 概览：固定键，组件值是范围内的计数'),
  ),
  [`GET ${HR_STRUCTURE_BASE}/components/:code`]: board(
    fixed(DETAIL_KEYS, 'hr-structure-routes.ts 明细：固定键，items 只含范围内的 ID'),
  ),
  [`GET ${HR_STRUCTURE_BASE}/reports/:report`]: report(
    fixed(
      ['asOf', 'report', 'name', 'employType', 'hasDataPermission', 'columns', 'rows', 'summary'],
      'hr-structure-routes.ts 报表：固定键，单元格是范围内的计数 / 平均值',
    ),
  ),
});

export const CONTRACT_BOARD_POLICIES = defineTable('contract-board', {
  [`GET ${CONTRACT_BOARD_BASE}`]: contract(
    fixed(['asOf', 'hasDataPermission', 'components'], 'contract-board-routes.ts 概览：固定键，组件值是范围内的计数'),
  ),
  [`GET ${CONTRACT_BOARD_BASE}/components/:code`]: contract(
    fixed(DETAIL_KEYS, 'contract-board-routes.ts 明细：固定键，items 只含范围内的 ID'),
  ),
});
