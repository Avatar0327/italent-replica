// 离职字典的命令存储挂在模块级（同合同 commands.ts）：AppPages 按 pathname 重建页面，切换字典页签会连同页面根部的
// 存储一起销毁，结果未知的命令一丢，回来重做就成了第二条命令。键仍是“会话（租户 + 身份）+ 恢复槽”，由内核组成（F-142）。
import { createFormStore } from '../foundation/forms/store.js';

export const exitStore = createFormStore();
