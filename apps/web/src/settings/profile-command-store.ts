import { createFormStore } from '../foundation/forms/store.js';
// 同一身份的页面与对象权限共享恢复槽，导航卸载后仍保留未确认命令（F-474-9a §4.1）。
export const profileCommandStore = createFormStore();
