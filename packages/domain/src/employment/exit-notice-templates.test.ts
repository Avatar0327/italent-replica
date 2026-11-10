import { describe, expect, it } from 'vitest';
import { EXIT_NOTICE_TEMPLATES, FLOW_TERMINATED_BY_EXIT_TEMPLATE, renderExitNotice } from './exit-notice-templates.js';

const PAYLOAD = { flowName: '员工信息变更申请', employeeName: '张三', effectiveDate: '2026-10-01' };

describe('F-420 离职终止流程的消息模板', () => {
  it('flow_terminated_by_exit 在目录中，正文占位符与登记的变量一一对应', () => {
    for (const [code, template] of Object.entries(EXIT_NOTICE_TEMPLATES)) {
      const used = [...template.body.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(new Set(used), code).toEqual(new Set(template.variables));
      expect(template.title, code).not.toMatch(/[{}]/);
    }
    expect(EXIT_NOTICE_TEMPLATES[FLOW_TERMINATED_BY_EXIT_TEMPLATE]).toBeDefined();
  });

  it('变量齐全时渲染：标题说明因离职生效流程已终止，正文带流程名称、员工、生效日，无占位符', () => {
    const rendered = renderExitNotice(FLOW_TERMINATED_BY_EXIT_TEMPLATE, PAYLOAD)!;
    expect(rendered.title).toBe('因员工离职生效，流程已终止');
    expect(rendered.body).toContain('员工信息变更申请');
    expect(rendered.body).toContain('张三');
    expect(rendered.body).toContain('2026-10-01');
    expect(rendered.body).not.toMatch(/[{}]/);
  });

  it('没有变量快照或缺变量时正文为 null（不输出占位符），标题照常', () => {
    expect(renderExitNotice(FLOW_TERMINATED_BY_EXIT_TEMPLATE, null)).toEqual({
      title: '因员工离职生效，流程已终止',
      body: null,
      sender: null,
    });
    const { employeeName: _omitted, ...partial } = PAYLOAD;
    expect(renderExitNotice(FLOW_TERMINATED_BY_EXIT_TEMPLATE, partial)!.body).toBeNull();
    expect(renderExitNotice(FLOW_TERMINATED_BY_EXIT_TEMPLATE, { ...PAYLOAD, flowName: '' })!.body).toBeNull();
  });

  it('目录之外的模板码（含 null）不渲染', () => {
    expect(renderExitNotice('TenantBase.Ygddtz', PAYLOAD)).toBeNull();
    expect(renderExitNotice(null, PAYLOAD)).toBeNull();
  });
});
