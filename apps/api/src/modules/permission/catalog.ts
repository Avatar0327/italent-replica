/**
 * 对象元数据目录：业务模块在加载时登记自己的对象（字段、系统字段标记、按钮 × 级别、按钮依赖的数据操作），
 * 权限模块据此校验身份对象权限配置（AC-PRM-23）并判定按钮可执行性（REQ-PRM-001 R6）。
 * 权限模块本身不定义业务对象的字段与按钮；只为已上线模块的路由动作登记对象占位（应用归属）。
 */
import { MODULE_OBJECTS, ObjectCatalog, type ObjectDefinition } from '@italent/domain';

/** 预先登记已上线模块路由动作对应的对象（占位定义，见 @italent/domain module-actions.ts）。 */
export const objectCatalog = new ObjectCatalog(Object.values(MODULE_OBJECTS));

export function registerObjectDefinition(definition: ObjectDefinition): void {
  objectCatalog.register(definition);
}
