import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { ChangeModel, Organization } from '../../apps/web/src/org/types.js';
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react') as { createElement: (component: unknown, props: unknown) => unknown };
const { renderToStaticMarkup } = webRequire('react-dom/server') as {
  renderToStaticMarkup: (element: unknown) => string;
};
const path = new URL('../../apps/web/src/org/OrgChangeForm.tsx', import.meta.url).pathname;
const original: Organization = {
  id: 'a',
  name: '原部门',
  revision: 1,
  remarks: null,
  parents: { admin: { parentId: 'parent', sequence: 7 } },
};
const base: ChangeModel = { name: '原部门', parentId: 'parent', remarks: '', addEmployment: '' };
async function render(model: ChangeModel) {
  const { OrgChangeForm } = await import(path);
  return renderToStaticMarkup(
    createElement(OrgChangeForm, {
      original,
      model,
      parents: [],
      busy: false,
      onChange: () => undefined,
      onSave: () => undefined,
    }),
  );
}
describe('AC-ORG-29 页面条件字段与请求契约', () => {
  it('改名或改行政上级显示必填选择，备注变更不显示', async () => {
    for (const model of [
      { ...base, name: '新部门' },
      { ...base, parentId: 'new' },
    ]) {
      const html = await render(model);
      expect(html).toContain('是否新增任职');
      expect(html).toMatch(/<select[^>]*required=""[^>]*name="addEmployment"/);
    }
    expect(await render({ ...base, remarks: '新备注' })).not.toContain('是否新增任职');
  });
  it('未改层级时不提交 parent；改上级保留顺序号；隐藏选择不随请求发送', async () => {
    const { changeInput } = await import(path);
    expect(changeInput(original, { ...base, name: '新部门', addEmployment: 'yes' }, '2026-10-08')).toEqual({
      name: '新部门',
      effectiveDate: '2026-10-08',
      addEmployment: true,
    });
    expect(changeInput(original, { ...base, parentId: 'new', addEmployment: 'no' }, '2026-10-08')).toMatchObject({
      parents: { admin: { parentId: 'new', sequence: 7 } },
      addEmployment: false,
    });
    expect(changeInput(original, { ...base, remarks: '备注', addEmployment: 'yes' }, '2026-10-08')).toEqual({
      remarks: '备注',
      effectiveDate: '2026-10-08',
    });
  });
});
