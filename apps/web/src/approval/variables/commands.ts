// 变量写命令的存储挂在模块级（同人员类别 employment-types/commands.ts）：切换页签、关掉弹窗不丢结果未知的命令。
import { createFormStore } from '../../foundation/forms/store.js';

export const variableStore = createFormStore();
