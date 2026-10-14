import { messages as m } from '../self-service/pages/messages.js';

/** DEC-456/470：本人完整人员子集与工作台卡片尚无本入口接口。示例与真实响应隔离，不能提交。 */
export const selfServiceDemo = {
  sections: [
    { key: 'work', title: m.workHistory, rows: [{ key: '1', label: m.company, value: '合成示例公司' }] },
    { key: 'education', title: m.education, rows: [{ key: '1', label: m.school, value: '合成示例大学' }] },
    { key: 'family', title: m.family, rows: [] },
  ],
  widgets: [m.attendance, m.recruiting, m.greetings, m.calendar],
};
