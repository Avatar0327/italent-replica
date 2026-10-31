import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  exits: {
    original:
      '员工管理 > 离职管理：离职中 / 已完成 / 全部三个视图；离职申请与直接离职必填离职员工、最后工作日，' +
      '可选离职类型 / 原因 / 去向与加入黑名单；详情含离职交接。截图只在本机。',
    decision:
      '列表列取后端投影，被裁剪的字段显示占位。提交前先做检查并展示将作废的在途申请；在途申请超过上限时只提示上限、' +
      '不提供“确认并提交”（F-240）。按钮按服务端动作与权限快照给出。列序列宽、整单完成、员工确认、离职证明未验证。',
    decisions: ['DEC-473', 'DEC-524', 'DEC-625', 'DEC-703'],
    level: 'L2',
  },
  'exit-settings': {
    original:
      '组织员工设置 > 离职退休下分别维护离职类型、离职原因、离职去向；可停用，只有启用项可选（DM-R1）。表单字段截图只在本机。',
    decision:
      '三个字典各一页签，字段取名称、编码（保存后不可改）、启用、显示顺序，不提供删除；停用项照常列出并标“已停用”。' +
      '新增 / 改名 / 启停 / 调序经表单内核提交，调序只改本条显示顺序。菜单位置与列序未验证。',
    decisions: ['DEC-577', 'DEC-045', 'DEC-464', 'DEC-502'],
    level: 'L2',
  },
};
