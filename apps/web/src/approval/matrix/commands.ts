// 矩阵写命令的存储挂在模块级（同 employment-types/commands.ts）：切换页签、关弹窗或离开页面都不丢结果未知的命令。
import { createFormStore } from '../../foundation/forms/store.js';

export const matrixStore = createFormStore();
