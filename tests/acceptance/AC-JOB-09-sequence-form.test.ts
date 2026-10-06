import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react') as { createElement: (component: unknown, props: unknown) => unknown };
const { renderToStaticMarkup } = webRequire('react-dom/server') as {
  renderToStaticMarkup: (element: unknown) => string;
};
async function render(editing: boolean, sequenceId: string | null, originalSequenceId: string | null) {
  const path = '../../apps/web/src/job/JobForm.js';
  const { JobForm } = await import(path);
  return renderToStaticMarkup(
    createElement(JobForm, {
      kind: 'posts',
      editing,
      originalSequenceId,
      value: { name: '测试职务', sequenceId, effectiveDate: '2026-10-05' },
      sequences: [{ id: 'new', name: '新序列' }],
      onChange: () => {},
      onSubmit: () => {},
    }),
  );
}
describe('AC-JOB-09 序列同步表单', () => {
  it('编辑改为非空才出现，选项锁定为是', async () => {
    const html = await render(true, 'new', 'old');
    expect(html).toContain('同步序列到任职');
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*checked=""/);
  });
  it('新建、未改动、清空时无同步字段', async () => {
    for (const html of [
      await render(false, 'new', null),
      await render(true, 'new', 'new'),
      await render(true, null, 'old'),
    ]) {
      expect(html).not.toContain('同步序列到任职');
    }
  });
});
