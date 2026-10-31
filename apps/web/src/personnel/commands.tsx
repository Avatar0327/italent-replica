// F-329 第 2 轮 P2-1：员工档案编辑命令的存储挂在模块级。员工页与实习生页各有页面根部（AppPages 按 pathname 重建），
// 档案详情两处都能打开：存储随页面走时，员工页结果未知的命令在实习生档案里重开就换成新命令再写一次。
// 键仍是“会话（租户 + 身份）+ 恢复槽”，由内核 usePinnedCommand 组成；同 contracts/commands.ts、idp/commands.tsx。
import type { ReactNode } from 'react';
import { createFormStore } from '../foundation/forms/store.js';
import { FormCommands } from '../foundation/forms/useCommandForm.js';

const store = createFormStore();

/** 档案编辑入口（编辑人员、子集、编辑任职）一律包在这里，不取所在页面根部的存储。 */
export const PersonnelCommands = ({ children }: { children: ReactNode }) => (
  <FormCommands store={store}>{children}</FormCommands>
);
