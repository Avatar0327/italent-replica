/**
 * 把本测试文件固定在 F-082 总开关**关闭**的路径（B5 原状，契约 §10、AC-23）：
 * F082-5 把开关默认值改为 true 之后，B5 / #184 时代的计算规则套件断言的仍是名称存储与 B5 响应形状，
 * 它们验证的是“开关关闭时与 B5 完全一致”这一条（契约 AC-23 的关闭态要求）；开关打开后的对应覆盖在 AC-TR-F082-* 与各模块的默认应用测试里。
 * 用法：在测试文件顶部 `import './support/b5-path.js';`（模块实例按测试文件隔离，不影响其他文件）。
 */
import { pinFormulaIdBinding } from './tenant-api.js';

pinFormulaIdBinding(false);
