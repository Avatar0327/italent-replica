// F-164 第 1 轮 P2-1：IDP 的命令存储挂在模块级。AppPages 按 pathname 重建页面（PageErrorBoundary 的 key），
// 个人发展计划、我辅导的发展计划、发展计划管理各是一页，页面根部的 FormCommands 随切换入口一起销毁：
// 结果未知的命令一丢，回来重开计划就能以新命令 ID 重发。同 contracts/commands.ts。
// 三个入口的根部都用这份存储，新建、编辑弹窗（useRecordForm）与行内、批量命令同在一处，同一对象互相锁定（F-147）。
// 键仍是“会话（租户 + 身份）+ 资源”，由内核组成（F-142）。
import type { ReactNode } from 'react';
import { createFormStore } from '../foundation/forms/store.js';
import { FormCommands } from '../foundation/forms/useCommandForm.js';

const store = createFormStore();

/** IDP 各入口的页面根部：内核 FormCommands，只是存储不随页面卸载。 */
export const IdpCommands = ({ children }: { children: ReactNode }) => (
  <FormCommands store={store}>{children}</FormCommands>
);
