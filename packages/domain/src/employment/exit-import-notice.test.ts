import { describe, expect, it } from 'vitest';
import { EXIT_NOTICE_TEMPLATES, FLOW_TERMINATED_BY_EXIT_TEMPLATE, renderExitNotice } from './exit-notice-templates.js';

// AC-DM-30-F493-33 模板目录部分（设计 §8.1，DEC-839②）
const FILE = '合成导入.xlsx';
const payload = (over: Record<string, unknown> = {}) => ({
  fileName: FILE,
  errors: '1',
  senderName: '合成提交人',
  ...over,
});

describe('F-493 导入结果通知模板', () => {
  it('有错误：标题、正文逐字（含「详情请见附件。」后的半角空格）、发送人', () => {
    expect(renderExitNotice('exit_import_finished', payload())).toEqual({
      title: '历史离职人员导入结果',
      body: '合成导入.xlsx导入已结束，出现1个错误。详情请见附件。 文件将于15天后过期，请尽快下载',
      sender: '合成提交人',
    });
  });

  it('全部成功：正文逐字，没有附件提示；发送人同样是提交人', () => {
    expect(renderExitNotice('exit_import_finished_clean', payload({ errors: '0' }))).toEqual({
      title: '历史离职人员导入结果',
      body: '合成导入.xlsx导入已结束，出现0个错误。',
      sender: '合成提交人',
    });
  });

  it('错误数取错误条数字符串：10 条错误显示「出现10个错误」', () => {
    expect(renderExitNotice('exit_import_finished', payload({ errors: '10' }))!.body).toContain('出现10个错误。');
  });

  it('发送人为空串或缺失 → sender = null，正文照常；正文变量缺失 → body = null 但 sender 保留', () => {
    expect(renderExitNotice('exit_import_finished', payload({ senderName: '' }))!.sender).toBeNull();
    expect(renderExitNotice('exit_import_finished', { fileName: FILE, errors: '1' })!.sender).toBeNull();
    expect(renderExitNotice('exit_import_finished', { senderName: '合成提交人' })).toMatchObject({
      body: null,
      sender: '合成提交人',
    });
  });

  it('flow_terminated_by_exit 没有发送人：sender = null', () => {
    const rendered = renderExitNotice(FLOW_TERMINATED_BY_EXIT_TEMPLATE, {
      flowName: '员工信息变更申请',
      employeeName: '张三',
      effectiveDate: '2026-10-01',
    });
    expect(rendered!.sender).toBeNull();
  });

  it('目录自检：正文占位符 = variables；sender 键指向的变量不在正文里，只有导入模板声明 sender', () => {
    for (const code of ['exit_import_finished', 'exit_import_finished_clean']) {
      const template = EXIT_NOTICE_TEMPLATES[code]!;
      expect(template, code).toBeDefined();
      const used = [...template.body.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(new Set(used), code).toEqual(new Set(template.variables));
      expect(template.sender, code).toBe('senderName');
      expect(template.variables, code).not.toContain('senderName');
      expect(template.title, code).not.toMatch(/[{}]/);
    }
    expect(EXIT_NOTICE_TEMPLATES.exit_import_finished!.variables).toEqual(['fileName', 'errors']);
    expect(EXIT_NOTICE_TEMPLATES.exit_import_finished_clean!.variables).toEqual(['fileName']);
    expect(EXIT_NOTICE_TEMPLATES[FLOW_TERMINATED_BY_EXIT_TEMPLATE]!.sender).toBeUndefined();
  });
});
