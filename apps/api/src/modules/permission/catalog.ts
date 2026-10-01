/**
 * 对象元数据目录：业务模块在加载时登记自己的对象（字段、系统字段标记、按钮 × 级别、按钮依赖的数据操作），
 * 权限模块据此校验身份对象权限配置（AC-PRM-23）并判定按钮可执行性（REQ-PRM-001 R6）。
 * 权限模块本身不定义任何业务对象。
 */
import { ObjectCatalog, type ObjectDefinition } from '@italent/domain';

export const objectCatalog = new ObjectCatalog();

export function registerObjectDefinition(definition: ObjectDefinition): void {
  objectCatalog.register(definition);
}
