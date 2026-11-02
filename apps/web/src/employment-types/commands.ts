// 人员类别写命令的存储挂在模块级（同离职字典 exit/commands.ts）：切换视图或关掉详情不丢结果未知的命令。
import { createFormStore } from '../foundation/forms/store.js';

export const typeStore = createFormStore();
