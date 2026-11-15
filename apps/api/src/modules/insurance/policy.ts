/**
 * 社保读取路由的 F-039 声明（F-474-8c-2b；DEC-896④：社保对象按授权类授权，预设给系统管理员与 HR 管理员的查看权；
 * 设计 F-474-8b §4.1 / §4.4）。四条路由全是只读，没有写入口：
 * - 原值读取：社保档案对象查看权 + 三个原值字段全部可见（缺一整体 403），员工经 readPageContext 按任职数据范围判定，
 *   范围外与不存在同为 404（守卫 insurance.employeeScope）；业务编号归属不符同为 404；
 * - 缴交地：全局公开字典，只要求登录成员；
 * - 方案候选：方案对象查看权，方案是租户级配置，没有按员工的数据范围；字段随对象可见字段裁剪（planId 保留）；
 * - 公司候选：合同公司对象查看权 + 看全部（DEC-121 无归属对象，没有看全部 → 200 空列表），与合同公司主数据同一规则。
 * 本文件新起的登记名：守卫 insurance.employeeScope。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { defineTable } from '../../route-policy/index.js';
import {
  BAD_REQUEST,
  EMPTY_LIST,
  fixed,
  guardScope,
  member,
  noButton,
  noScope,
  NOT_FOUND,
  object,
  seeAll,
} from '../../route-policy/presets.js';
import { INSURANCE_BASE, INSURANCE_ORIGIN_PATH } from './routes.js';

const PROFILE = MODULE_OBJECTS.socialSecurityProfile.code;
const PLAN = MODULE_OBJECTS.socialInsurancePlan.code;
const COMPANY = MODULE_OBJECTS.contractCompany.code;
const invalid = { invalidId: BAD_REQUEST };

export const INSURANCE_POLICIES = defineTable('insurance', {
  [`GET ${INSURANCE_ORIGIN_PATH}`]: object({
    object: PROFILE,
    operation: 'view',
    button: noButton('原值读取是调动表单的只读回填，按对象查看权，没有按钮'),
    scope: guardScope('insurance.employeeScope', NOT_FOUND),
    fields: fixed(
      ['regionCode', 'planId', 'companyId'],
      'DEC-896④：三个原值字段整体可见才给，缺一整体 403（routes.ts ORIGIN_FIELDS）',
    ),
    ...invalid,
  }),
  [`GET ${INSURANCE_BASE}/regions`]: member(
    '缴交地是全局公开字典（admin_regions），不含租户数据，登录成员即可下钻',
    fixed(['code', 'parentCode', 'level', 'name'], '设计 §4.1：固定四个键，没有租户字段'),
    invalid,
  ),
  [`GET ${INSURANCE_BASE}/plans`]: object({
    object: PLAN,
    operation: 'view',
    button: noButton('候选读取只读，按对象查看权'),
    scope: noScope('缴交方案是租户级配置，没有归属员工 / 组织；租户隔离由 withTenant + tenant_id 谓词保证'),
    fields: fixed(
      ['planId', 'code', 'name', 'regionCode', 'effectiveMonth', 'stopMonth', 'enabled'],
      '设计 §4.1：候选键随方案对象的可见字段裁剪，planId 是标识始终保留',
    ),
    ...invalid,
  }),
  [`GET ${INSURANCE_BASE}/companies`]: object({
    object: COMPANY,
    operation: 'view',
    button: noButton('候选读取只读，按对象查看权'),
    // `WHERE tenant_id = ? AND ${scope.all}`：无看全部 → 200、items: []（与合同公司主数据同一规则）
    scope: seeAll(EMPTY_LIST),
    fields: fixed(['id', 'code', 'name'], '设计 §4.1：候选键随合同公司对象的可见字段裁剪，id 始终保留'),
  }),
});
