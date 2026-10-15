// 审批动作的命令存储挂在模块级（同 contracts/commands.ts，F-127b 先例）：AppPages 按 pathname 重建页面，
// 审批中心切换子页、合同页行内打开审批详情都没有共同的 FormCommands；结果未知的动作一丢，重开就成了第二条命令。
// 键仍是“会话（租户 + 身份）+ 资源”，由内核 useCommandForm 组成（F-142）；资源只带流程实例 ID，
// 不带动作、视图或入口（F-123 页面片接入 2）。
import { createFormStore } from '../foundation/forms/store.js';
import { useCommandForm, type CommandForm } from '../foundation/forms/useCommandForm.js';

const store = createFormStore();

/** 内核 useCommandForm，只是存储不随页面卸载。 */
export const useApprovalCommand = (resource: string): CommandForm => useCommandForm(resource, store);
