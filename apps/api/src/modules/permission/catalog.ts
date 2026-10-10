/**
 * 对象元数据目录：业务模块在加载时登记自己的对象（字段、系统字段标记、按钮 × 级别、按钮依赖的数据操作），
 * 权限模块据此校验身份对象权限配置（AC-PRM-23）并判定按钮可执行性（REQ-PRM-001 R6）。
 * 已上线模块使用与实际 DTO 对应的字段/按钮定义；任职自定义字段由租户目录追加。
 */
import {
  EVALUATION_FLOW_OBJECTS,
  EVALUATION_OBJECTS,
  MODULE_OBJECTS,
  ObjectCatalog,
  type ObjectDefinition,
  QUALIFICATION_OBJECTS,
  QUALIFICATION_PAGES,
  survey360,
} from '@italent/domain';

/**
 * 预先登记已上线模块的真实对象定义（DEC-080）。360 对象随三类内置 360 身份一起登记（DEC-280，R3-T03 基础契约）：
 * 开通与存量回补都按对象目录校验标准身份（standard-profiles.ts），不依赖 360 业务模块是否已加载。
 * 任职资格 / 人才评定的配置对象同样预先登记（R3-T02 PR-0 契约）：数据范围与审计查看规则按对象所属应用解析
 * （module-access.ts scopeAppOf），不依赖业务模块加载顺序。
 * 人才评定的流程对象由 P0 契约冻结、同样预先登记，C1-2 装评定专员身份时按目录校验得到。
 * 页面载体 QUALIFICATION_PAGES（C1-2b）只在这里登记，不进 QUALIFICATION_OBJECTS。
 */
export const objectCatalog = new ObjectCatalog([
  ...Object.values(MODULE_OBJECTS),
  ...Object.values(survey360.SURVEY360_OBJECTS),
  ...Object.values(QUALIFICATION_OBJECTS),
  QUALIFICATION_PAGES,
  ...Object.values(EVALUATION_OBJECTS),
  ...Object.values(EVALUATION_FLOW_OBJECTS),
]);

export function registerObjectDefinition(definition: ObjectDefinition): void {
  objectCatalog.register(definition);
}
