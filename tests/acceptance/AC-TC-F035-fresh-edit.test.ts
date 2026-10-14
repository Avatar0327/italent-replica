/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

const ID = '00000000-0000-4000-8000-000000000035';
const OTHER = '00000000-0000-4000-8000-000000000036';
const LIBRARY = { id: 'library', name: '候选指标库', type: 'ability', enabled: true };
const CATEGORY = { id: 'category', name: '候选分类' };
const TYPE = { id: 'type', name: '启用类型', enabled: true };
const UNIT = { id: 'unit', name: '授权管理单元' };
const panels = [
  { module: 'LibraryPanel', object: 'library', path: 'libraries', field: 'displayOrder', label: '顺序', value: '7' },
  {
    module: 'CategoryPanel',
    object: 'criterionCategory',
    path: 'criterion-categories',
    field: 'displayOrder',
    label: '顺序',
    value: '7',
  },
  {
    module: 'DimensionCategoryPanel',
    object: 'dimensionCategory',
    path: 'dimension-categories',
    field: 'displayOrder',
    label: '顺序',
    value: '7',
  },
  {
    module: 'DescriptionTypePanel',
    object: 'descriptionType',
    path: 'description-types',
    field: 'displayOrder',
    label: '顺序',
    value: '7',
  },
  {
    module: 'DimensionPanel',
    object: 'dimension',
    path: 'dimensions',
    field: 'definition',
    label: '定义',
    value: '最新指标定义',
  },
  {
    module: 'CriterionPanel',
    object: 'criterion',
    path: 'criteria',
    field: 'potentialNote',
    label: '潜力说明',
    value: '最新潜力说明',
  },
] as const;
type Panel = (typeof panels)[number];
type Item = Record<string, unknown>;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function currentItem(path: string): Item {
  const base = { id: ID, revision: 9, name: '最新名称', displayOrder: 7, enabled: false };
  if (path === 'libraries') return { ...base, type: 'ability' };
  if (path === 'dimension-categories') return { ...base, libraryId: LIBRARY.id };
  if (path === 'dimensions')
    return {
      ...base,
      libraryId: LIBRARY.id,
      type: 'ability',
      code: 'CURRENT',
      definition: '最新指标定义',
      categoryId: null,
      grades: [{ gradeOrder: 1, alias: '原等级', description: '原等级说明' }],
      behaviors: [{ description: '原行为说明', keyPoints: '原行为关键点', displayOrder: 1 }],
      suggestions: [{ id: 'suggestion', typeId: TYPE.id, description: '原建议说明', displayOrder: 1 }],
      questions: [{ question: '原面试问题', keyPoints: '原问题关键点', displayOrder: 1 }],
    };
  if (path === 'criteria')
    return {
      ...base,
      categoryId: CATEGORY.id,
      abilityNote: null,
      potentialNote: '最新潜力说明',
      experienceNote: null,
      achievementNote: null,
      dimensions: [],
    };
  return base;
}

// 列表在授权前生成；详情在打开编辑后生成。PATCH 状态模型模拟服务端对显式集合的整组替换。
function requests({
  panel,
  editableFields,
  omitted = [],
  detail,
  listItems,
}: {
  panel: Panel;
  editableFields: readonly string[];
  omitted?: readonly string[];
  detail?: (id: string, tenantId: string) => Response | Promise<Response>;
  listItems?: readonly Item[];
}) {
  const state = currentItem(panel.path);
  const oldList: Item = { ...state, revision: 3, name: '旧列表名称' };
  for (const field of omitted) delete oldList[field];
  const writes: { body: Item; revision: string | undefined }[] = [];
  const reads: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options: RequestInit = {}) => {
      const route = new URL(input, 'http://localhost').pathname.replace('/api/tenant/talent/', '');
      if (options.method === 'PATCH') {
        const body = JSON.parse(String(options.body)) as Item;
        writes.push({ body, revision: (options.headers as Record<string, string>)['if-match'] });
        Object.assign(state, body);
        return json(state);
      }
      if (route.startsWith('forms/')) return json({ editableFields, requiredFields: [] });
      if (route.startsWith(`${panel.path}/`)) {
        const id = route.slice(panel.path.length + 1);
        reads.push(id);
        const tenantId = (options.headers as Record<string, string>)['x-tenant-id'] ?? '';
        return detail ? detail(id, tenantId) : json(state);
      }
      if (route === panel.path) return json({ items: listItems ?? [oldList], hasDataPermission: true });
      if (route === 'libraries') return json({ items: [LIBRARY], hasDataPermission: true });
      if (route === 'criterion-categories' || route === 'dimension-categories')
        return json({ items: [CATEGORY], hasDataPermission: true });
      if (route === 'candidates/owner-orgs') return json({ items: [UNIT] });
      if (route === 'candidates/description-types') return json({ items: [TYPE] });
      if (route === 'candidates/dimensions')
        return json({ items: [{ id: 'candidate', name: '新候选指标', type: 'ability', enabled: true }] });
      return json({ items: [], hasDataPermission: true });
    }),
  );
  return { state, writes, reads };
}

async function renderPanel(module: string, tenantId = 'tenant-a') {
  const components = (await import(resolve(`apps/web/src/talent/${module}.tsx`))) as Record<string, unknown>;
  await act(async () => root.render(createElement(components[module], { tenantId })));
}

async function click(label: string, index = 0, container: Element = host) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter(
    (item) => item.textContent === label,
  )[index];
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}

function field(label: string) {
  const element = Array.from(host.querySelectorAll('form label')).find(
    (item) => item.firstChild?.textContent === label,
  );
  return element?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select');
}

async function enter(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  const form = host.querySelector('form');
  expect(form).toBeTruthy();
  await act(async () => form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

function rowEditor(legend: string) {
  return Array.from(host.querySelectorAll('form fieldset')).find(
    (element) => element.querySelector(':scope > legend')?.textContent === legend,
  );
}

function deferred() {
  let complete!: (response: Response) => void;
  const pending = new Promise<Response>((resolvePromise) => {
    complete = resolvePromise;
  });
  return { pending, complete };
}

it.each(panels)('AC-TC-F035 $object 权限变更后编辑以当前详情及 revision 为基线', async (panel) => {
  const model = requests({ panel, editableFields: ['name', panel.field], omitted: [panel.field] });
  await renderPanel(panel.module);
  await click('编辑');
  expect(field('名称')?.value).toBe('最新名称');
  expect(field(panel.label)?.value).toBe(panel.value);
  await enter(field('名称') as HTMLInputElement, '只修改名称');
  await submit();
  expect(model.reads).toEqual([ID]);
  expect(model.writes).toEqual([{ body: { name: '只修改名称' }, revision: '9' }]);
  expect(model.state[panel.field]).toBe(panel.field === 'displayOrder' ? 7 : panel.value);
});

it('AC-TC-F035 分类原顺序7在旧列表被裁剪，授权后不刷新只改名称仍保留7', async () => {
  const panel = panels[2];
  const model = requests({ panel, editableFields: ['name', 'displayOrder'], omitted: ['displayOrder'] });
  await renderPanel(panel.module);
  await click('编辑');
  await enter(field('名称') as HTMLInputElement, '仅修改分类名称');
  await submit();
  expect(model.state.displayOrder).toBe(7);
  expect(model.writes[0]?.body).toEqual({ name: '仅修改分类名称' });
});

const groups = [
  { field: 'grades', legend: '等级描述', label: '说明', original: '原等级说明', next: '新增等级说明' },
  { field: 'behaviors', legend: '行为描述', label: '说明', original: '原行为说明', next: '新增行为说明' },
  { field: 'suggestions', legend: '发展建议', label: '说明', original: '原建议说明', next: '新增建议说明' },
  { field: 'questions', legend: '面试问题', label: '问题', original: '原面试问题', next: '新增面试问题' },
] as const;

it.each(groups)('AC-TC-F035 $field 原有明细在旧列表被裁剪，重新授权后添加一行保留旧行', async (group) => {
  const model = requests({ panel: panels[4], editableFields: [group.field], omitted: [group.field] });
  const original = structuredClone((model.state[group.field] as Item[])[0]);
  await renderPanel('DimensionPanel');
  await click('编辑');
  const editor = rowEditor(group.legend)!;
  expect(editor).toBeTruthy();
  await click('添加一行', 0, editor);
  const rows = editor.querySelectorAll('tbody tr');
  const last = rows[rows.length - 1]!;
  await enter(last.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${group.label}"]`)!, group.next);
  if (group.field === 'suggestions') {
    await act(async () => {
      const type = last.querySelector<HTMLSelectElement>('select')!;
      type.value = TYPE.id;
      type.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  await submit();
  const saved = model.state[group.field] as Item[];
  expect(saved).toHaveLength(2);
  expect(saved[0]).toEqual(original);
  expect(JSON.stringify(saved[1])).toContain(group.next);
  expect(model.writes[0]?.body[group.field]).toEqual(saved);
});

it('AC-TC-F035 当前详情未读到字段时不以默认值形成可提交草稿', async () => {
  const detail = currentItem('dimension-categories');
  delete detail.displayOrder;
  const model = requests({
    panel: panels[2],
    editableFields: ['name', 'displayOrder'],
    omitted: ['displayOrder'],
    detail: () => json(detail),
  });
  await renderPanel('DimensionCategoryPanel');
  await click('编辑');
  const order = field('顺序');
  expect(!order || order.disabled).toBe(true);
  await enter(field('名称') as HTMLInputElement, '其他已读字段');
  await submit();
  expect(model.writes[0]?.body).toEqual({ name: '其他已读字段' });
  expect(model.state.displayOrder).toBe(7);
});

it.each(groups)('AC-TC-F035 当前详情未读到 $field 时不能从空集合整组替换', async (group) => {
  const detail = currentItem('dimensions');
  delete detail[group.field];
  const model = requests({
    panel: panels[4],
    editableFields: ['name', group.field],
    omitted: [group.field],
    detail: () => json(detail),
  });
  await renderPanel('DimensionPanel');
  await click('编辑');
  const editor = rowEditor(group.legend);
  const add = editor?.querySelector<HTMLButtonElement>('button');
  expect(!add || add.disabled).toBe(true);
  await enter(field('名称') as HTMLInputElement, '保留未读集合');
  await submit();
  expect(model.writes[0]?.body).toEqual({ name: '保留未读集合' });
  expect(model.state[group.field]).toHaveLength(1);
});

it('AC-TC-F035 当前详情返回真实空等级集合仍能添加和显式清空', async () => {
  const model = requests({
    panel: panels[4],
    editableFields: ['grades'],
    omitted: ['grades'],
  });
  model.state.grades = [];
  await renderPanel('DimensionPanel');
  await click('编辑');
  await click('添加一行', 0, rowEditor('等级描述')!);
  await enter(rowEditor('等级描述')!.querySelector<HTMLTextAreaElement>('textarea[aria-label="说明"]')!, '新增说明');
  await submit();
  expect(model.state.grades).toHaveLength(1);
  await click('编辑');
  await click('移除', 0, rowEditor('等级描述')!);
  await submit();
  expect(model.writes[1]?.body).toEqual({ grades: [] });
  expect(model.state.grades).toEqual([]);
});

it('AC-TC-F035 当前详情真实null、false和0保留为已读值，改名称不写默认值', async () => {
  const item = { ...currentItem('dimensions'), definition: null, enabled: false, displayOrder: 0 };
  const model = requests({
    panel: panels[4],
    editableFields: ['name', 'definition', 'enabled', 'displayOrder'],
    listItems: [item],
  });
  Object.assign(model.state, item);
  await renderPanel('DimensionPanel');
  await click('编辑');
  expect(field('定义')?.value).toBe('');
  expect(field('顺序')?.value).toBe('0');
  expect(host.querySelector<HTMLInputElement>('form input[type="checkbox"]')?.checked).toBe(false);
  await enter(field('名称') as HTMLInputElement, '仅改已读名称');
  await submit();
  expect(model.writes[0]?.body).toEqual({ name: '仅改已读名称' });
  expect(model.state).toMatchObject({ definition: null, enabled: false, displayOrder: 0 });
});

it('AC-TC-F035 当前详情未读到标准引用集合时不能从空集合添加整组替换', async () => {
  const detail = currentItem('criteria');
  delete detail.dimensions;
  const model = requests({
    panel: panels[5],
    editableFields: ['name', 'dimensions'],
    omitted: ['dimensions'],
    detail: () => json(detail),
  });
  model.state.dimensions = [{ dimensionId: 'existing', type: 'ability', displayOrder: 1, weight: 2, target: 3 }];
  await renderPanel('CriterionPanel');
  await click('编辑');
  const add = field('添加指标');
  expect(!add || add.disabled).toBe(true);
  await enter(field('名称') as HTMLInputElement, '保留未读引用');
  await submit();
  expect(model.writes[0]?.body).toEqual({ name: '保留未读引用' });
  expect(model.state.dimensions).toHaveLength(1);
});

it('AC-TC-F035 标准旧列表缺少引用集合，当前详情的旧引用与新增引用一起保留', async () => {
  const model = requests({ panel: panels[5], editableFields: ['dimensions'], omitted: ['dimensions'] });
  const reference = { dimensionId: 'existing', weight: 2, target: 3, displayOrder: 1, dimensionCategory: null };
  model.state.dimensions = [{ ...reference, type: 'ability' }];
  await renderPanel('CriterionPanel');
  await click('编辑');
  await act(async () => {
    const add = field('添加指标') as HTMLSelectElement;
    add.value = 'candidate';
    add.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await submit();
  expect(model.state.dimensions).toEqual([reference, { dimensionId: 'candidate', displayOrder: 2 }]);
});

it('AC-TC-F035 编辑详情加载期间不能保存旧列表默认值', async () => {
  const response = deferred();
  const model = requests({
    panel: panels[2],
    editableFields: ['name', 'displayOrder'],
    omitted: ['displayOrder'],
    detail: () => response.pending,
  });
  await renderPanel('DimensionCategoryPanel');
  await click('编辑');
  const save = host.querySelector<HTMLButtonElement>('form button[type="submit"]');
  expect(!save || save.disabled).toBe(true);
  if (host.querySelector('form')) await submit();
  expect(model.writes).toEqual([]);
  await act(async () => response.complete(json(model.state)));
  expect(field('顺序')?.value).toBe('7');
});

it('AC-TC-F035 当前详情读取失败给出原因且不能保存旧列表数据', async () => {
  const model = requests({
    panel: panels[2],
    editableFields: ['name', 'displayOrder'],
    omitted: ['displayOrder'],
    detail: () => json({ error: { code: 'FORBIDDEN', message: '当前详情没有查看权限' } }, 403),
  });
  await renderPanel('DimensionCategoryPanel');
  await click('编辑');
  expect(host.textContent).toContain('当前详情没有查看权限');
  const save = host.querySelector<HTMLButtonElement>('form button[type="submit"]');
  expect(!save || save.disabled).toBe(true);
  if (host.querySelector('form')) await submit();
  expect(model.writes).toEqual([]);
});

it('AC-TC-F035 换对象后迟到的旧详情不能替换当前编辑草稿', async () => {
  const first = deferred();
  requests({
    panel: panels[5],
    editableFields: ['name'],
    listItems: [
      { id: ID, revision: 3, name: '旧列表甲' },
      { id: OTHER, revision: 3, name: '旧列表乙' },
    ],
    detail: (id) =>
      id === ID ? first.pending : json({ ...currentItem('criteria'), id: OTHER, name: '对象乙的最新名称' }),
  });
  await renderPanel('CriterionPanel');
  await click('编辑', 0);
  await click('编辑', 1);
  expect(field('名称')?.value).toBe('对象乙的最新名称');
  await act(async () => first.complete(json({ ...currentItem('criteria'), name: '迟到的对象甲' })));
  expect(field('名称')?.value).toBe('对象乙的最新名称');
});

it('AC-TC-F035 改为新建后迟到的编辑详情不能恢复旧对象表单', async () => {
  const old = deferred();
  requests({ panel: panels[5], editableFields: ['name'], detail: () => old.pending });
  await renderPanel('CriterionPanel');
  await click('编辑');
  await click('新建');
  await enter(field('名称') as HTMLInputElement, '新建草稿');
  await act(async () => old.complete(json(currentItem('criteria'))));
  expect(field('名称')?.value).toBe('新建草稿');
});

it('AC-TC-F035 关闭新建表单后迟到的编辑详情不能重新打开表单', async () => {
  const old = deferred();
  requests({ panel: panels[5], editableFields: ['name'], detail: () => old.pending });
  await renderPanel('CriterionPanel');
  await click('编辑');
  await click('新建');
  await click('取消');
  await act(async () => old.complete(json(currentItem('criteria'))));
  expect(host.querySelector('form')).toBeNull();
});

it('AC-TC-F035 详情加载中取消再重开同对象，旧请求迟到不替换当前草稿', async () => {
  const old = deferred();
  let opened = 0;
  requests({
    panel: panels[5],
    editableFields: ['name'],
    detail: () => {
      opened += 1;
      return opened === 1 ? old.pending : json({ ...currentItem('criteria'), revision: 10, name: '重开后的最新名称' });
    },
  });
  await renderPanel('CriterionPanel');
  await click('编辑');
  await click('取消');
  await click('编辑');
  expect(field('名称')?.value).toBe('重开后的最新名称');
  await enter(field('名称') as HTMLInputElement, '本次重开草稿');
  await act(async () => old.complete(json({ ...currentItem('criteria'), name: '第一次迟到详情' })));
  expect(field('名称')?.value).toBe('本次重开草稿');
});

it('AC-TC-F035 切换租户后旧租户迟到详情不恢复编辑表单', async () => {
  const old = deferred();
  requests({
    panel: panels[5],
    editableFields: ['name'],
    detail: (_id, tenantId) =>
      tenantId === 'tenant-a' ? old.pending : json({ ...currentItem('criteria'), name: '新租户名称' }),
  });
  await renderPanel('CriterionPanel', 'tenant-a');
  await click('编辑');
  await renderPanel('CriterionPanel', 'tenant-b');
  await act(async () => old.complete(json({ ...currentItem('criteria'), name: '旧租户迟到详情' })));
  expect(host.querySelector('form')).toBeNull();
  expect(host.textContent).not.toContain('旧租户迟到详情');
});
