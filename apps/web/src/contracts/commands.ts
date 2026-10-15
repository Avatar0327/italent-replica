// F-127b 第 4 轮：合同模块的命令存储挂在模块级。AppPages 按 pathname 重建页面（PageErrorBoundary 的 key），
// 页面根部的 FormCommands 会随切换子页一起销毁：结果未知的新建命令一丢，回来重填就成了第二条命令。
// 键仍是“会话（租户 + 身份）+ 资源”，由内核 useCommandForm 组成（F-142）；整页刷新后的恢复归 F-110。
import { createFormStore } from '../foundation/forms/store.js';
import { useCommandForm, type CommandForm } from '../foundation/forms/useCommandForm.js';

const store = createFormStore();

/** 内核 useCommandForm，只是存储不随页面卸载。 */
export const useContractCommand = (resource: string): CommandForm => useCommandForm(resource, store);
