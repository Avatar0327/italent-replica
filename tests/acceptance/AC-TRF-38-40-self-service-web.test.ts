import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react') as { createElement: (component: unknown, props: unknown) => unknown };
const { renderToStaticMarkup } = webRequire('react-dom/server') as {
  renderToStaticMarkup: (element: unknown) => string;
};
const path = new URL('../../apps/web/src/employee-self-service/EmployeePage.tsx', import.meta.url).pathname;

describe('R1-T13 本人自助页面', () => {
  it('AC-TRF-38：任职表格有审批状态，在途与作废行没有操作按钮', async () => {
    const { EmploymentList } = (await import(path)) as { EmploymentList: unknown };
    const html = renderToStaticMarkup(
      createElement(EmploymentList, {
        name: '合成员工',
        records: [
          {
            id: 'pending',
            effectiveDate: '2026-10-19',
            stopDate: null,
            approvalStatus: '审批中',
            fields: {},
            fieldLabels: {},
          },
          {
            id: 'voided',
            effectiveDate: '2026-10-20',
            stopDate: null,
            approvalStatus: '作废',
            fields: {},
            fieldLabels: {},
          },
        ],
      }),
    );
    expect(html).toContain('<th>审批状态</th>');
    expect(html).toContain('审批中');
    expect(html).toContain('作废');
    expect(html).not.toContain('<button');
  });

  it('AC-TRF-40：我的申请为七列表格，终止后处理人为空，没有撤回/撤销/审批按钮', async () => {
    const { ApplicationList } = (await import(path)) as { ApplicationList: unknown };
    const html = renderToStaticMarkup(
      createElement(ApplicationList, {
        timezone: 'Asia/Shanghai',
        applications: [
          {
            id: 'application',
            title: '合成员工提交的调动申请',
            category: '人事变动',
            initiator: '合成员工',
            currentHandlers: [],
            status: '已终止',
            reason: '',
            createdAt: '2026-10-01T01:00:00Z',
          },
        ],
      }),
    );
    expect(html).toContain('<table>');
    for (const label of ['标题', '类别', '发起人', '当前处理人', '审批状态', '申请理由', '申请时间'])
      expect(html).toContain(`<th>${label}</th>`);
    for (const label of ['撤回', '撤销', '同意', '驳回']) expect(html).not.toContain(label);
    expect(html).not.toContain('<article');
    expect(html).toContain('09:00:00');
  });
});
