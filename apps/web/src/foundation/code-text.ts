import { ui } from './messages.js';

/** F-493 §3.5：历史离职导入人员工号可空，展示统一使用双短横线。 */
export const codeText = (code: string | null): string => code || ui.emptyCode;
