/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * AC-APV-F326-24 前端：矩阵列表、头部编辑弹窗、启停、查看引用（F-326 F2a，设计 §6.2 / §8）。
 * 经企业设置路由 /settings/menu/matrix.manage 渲染；后端为按真实契约的合成后端（matrix-test-kit.ts）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASE,
  click,
  clickNode,
  dialog,
  fakeBackend,
  find,
  harness,
  head,
  ids,
  reference,
  roleColumn,
  text,
  type,
  type FakeBackend,
} from './matrix-test-kit.js';

const menus = vi.hoisted(() => ({ editable: true }));
vi.mock('../../foundation/Permissions.js', async (original) => ({
  ...(await original<object>()),
  usePermissions: () => ({
    menus: [{ key: 'settings', children: [{ key: 'matrix.manage', editable: menus.editable }] }],
  }),
}));

let backend: FakeBackend;
let ui: ReturnType<typeof harness>;
beforeEach(() => {
  menus.editable = true;
  backend = fakeBackend();
  ui = harness(backend);
});
afterEach(async () => ui.close());

const listReads = () => backend.reads.filter((url) => url.pathname === BASE);
const lastList = () => listReads().at(-1)!;
const listText = () => text(document.querySelector('.matrix-list') ?? document.body);
const headText = () => text(document.querySelector('.matrix-head') ?? document.body);
const row = (name: string) =>
  [...document.querySelectorAll('.matrix-list tbody tr')].find((tr) => text(tr).includes(name));
const select = (name: string) => clickNode(row(name));
const field = (name: string) => dialog()!.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${name}`);
const radio = (label: string) =>
  [...dialog()!.querySelectorAll('label.ant-radio-wrapper')].find((node) => text(node) === label);
const disabled = (label: string) => (find(label) as HTMLButtonElement | undefined)?.disabled;
const reset = async () => ui.remount();
/** 结果未知会把命令钉在模块级存储里（设计如此），锁定类用例各用一条独有矩阵，排在列表首位，不影响别的用例。 */
let lockSeq = 0;
function lone() {
  lockSeq += 1;
  const id = `81000000-0000-4000-8000-0000000005${String(lockSeq).padStart(2, '0')}`;
  backend.db.set(id, head({ id, code: `A0_LOCK${lockSeq}`, name: '合成锁定矩阵', revision: 3 }));
  return id;
}

describe('AC-APV-F326-24 矩阵列表', () => {
  it('启用的 / 停用的两个页签按服务端状态过滤，默认选中第一项并显示头部', async () => {
    await ui.render();
    expect(lastList().searchParams.get('status')).toBe('active');
    expect(listText()).toContain('合成矩阵甲');
    expect(listText()).toContain('BUDGET_B');
    expect(listText()).toContain('草稿');
    expect(listText()).not.toContain('合成矩阵丙');
    expect(headText()).toContain('合成矩阵甲');
    expect(headText()).toContain('APPROVE_A');
    expect(headText()).toContain('合成描述');
    expect(headText()).toContain('启用');

    await click('停用的');
    expect(lastList().searchParams.get('status')).toBe('disabled');
    expect(listText()).toContain('合成矩阵丙');
    expect(listText()).not.toContain('合成矩阵甲');
    expect(headText()).toContain('COST_C');
  });

  it('关键字原样交给服务端（含通配字符），翻页按 offset / hasMore', async () => {
    for (let i = 0; i < 60; i += 1) {
      const id = `81000000-0000-4000-8000-1000000000${String(i).padStart(2, '0')}`;
      backend.db.set(id, head({ id, code: `Z_${String(i).padStart(2, '0')}`, name: `批量矩阵${i}` }));
    }
    await ui.render();
    expect(lastList().searchParams.get('offset')).toBe('0');
    expect(disabled('上一页')).toBe(true);
    await click('下一页');
    expect(lastList().searchParams.get('offset')).toBe('50');
    expect(listText()).toContain('Z_59');
    expect(disabled('下一页')).toBe(true);
    await click('上一页');
    expect(lastList().searchParams.get('offset')).toBe('0');

    await type(document.querySelector<HTMLInputElement>('.matrix-list input'), ' 50%_甲 ');
    await clickNode(document.querySelector('.matrix-list .ant-input-search-button'));
    expect(lastList().searchParams.get('q')).toBe('50%_甲');
    expect(lastList().searchParams.get('offset')).toBe('0');
    expect(text()).toContain('暂无矩阵');
  });

  it('没有写权限的账号：只能看列表、头部与引用，不出现新建 / 编辑 / 启停', async () => {
    menus.editable = false;
    await ui.render();
    expect(listText()).toContain('合成矩阵甲');
    for (const label of ['新建矩阵', '编辑', '启用', '停用']) expect(find(label), label).toBeUndefined();
    await click('查看引用');
    expect(text(dialog())).toContain('合成来源流程');
  });
});

describe('AC-APV-F326-24 头部编辑弹窗', () => {
  it('新建：名称去首尾空格、描述留空发 null、默认草稿；保存后列表刷新并选中新矩阵', async () => {
    await ui.render();
    await click('新建矩阵');
    expect(text(dialog())).toContain('新建矩阵');
    await type(field('name'), '  合成新矩阵  ');
    await type(field('code'), 'NEW_M');
    await click('保存', dialog());
    expect(backend.writes).toHaveLength(1);
    expect(backend.writes[0]).toMatchObject({
      method: 'POST',
      path: BASE,
      body: { name: '合成新矩阵', code: 'NEW_M', description: null, enable: false },
    });
    expect(backend.writes[0]!.key).toBeTruthy();
    expect(document.querySelector('.ant-modal')).toBeNull();
    expect(listText()).toContain('NEW_M');
    expect(headText()).toContain('NEW_M');
    expect(headText()).toContain('草稿');
  });

  it('新建选“启用”发 enable: true；本地校验不通过不发请求', async () => {
    await ui.render();
    await click('新建矩阵');
    await type(field('name'), '   ');
    await type(field('code'), 'bad-code');
    await type(field('description'), 'x'.repeat(256));
    await click('保存', dialog());
    expect(backend.writes).toHaveLength(0);
    const errors = text(dialog());
    expect(errors).toContain('请输入名称');
    expect(errors).toContain('编码只能包含字母、数字和下划线');
    expect(errors).toContain('描述不能超过255个字');

    await type(field('name'), '合成启用矩阵');
    await type(field('code'), 'ON_M');
    await type(field('description'), '第一行\n第二行');
    await clickNode(radio('启用'));
    await click('保存', dialog());
    expect(backend.writes.at(-1)!.body).toEqual({
      name: '合成启用矩阵',
      code: 'ON_M',
      description: '第一行\n第二行',
      enable: true,
    });
    expect(headText()).toContain('启用');
  });

  it('编码重复：弹窗显示服务端原因、不锁定，改编码后用新命令重提', async () => {
    await ui.render();
    await click('新建矩阵');
    await type(field('name'), '合成重复');
    await type(field('code'), 'APPROVE_A');
    backend.state.fail = () => backend.error(409, 'CONFLICT', '矩阵编码已存在');
    await click('保存', dialog());
    expect(text(dialog())).toContain('矩阵编码已存在');
    expect(disabled('保存')).toBe(false);
    await type(field('code'), 'APPROVE_A2');
    await click('保存', dialog());
    expect(backend.writes).toHaveLength(2);
    expect(backend.writes[1]!.key).not.toBe(backend.writes[0]!.key);
    expect(backend.writes[1]!.body.code).toBe('APPROVE_A2');
    expect(listText()).toContain('APPROVE_A2');
  });

  it('编辑：编码只读，只发改动字段与 revision；保存后头部刷新', async () => {
    await ui.render();
    await click('编辑');
    expect(text(dialog())).toContain('编辑矩阵');
    expect(field('code')).toBeNull();
    expect(text(dialog())).toContain('APPROVE_A');
    await type(field('name'), '合成矩阵甲改');
    await click('保存', dialog());
    expect(backend.writes).toEqual([
      expect.objectContaining({
        method: 'PATCH',
        path: `${BASE}/${ids.a}`,
        body: { name: '合成矩阵甲改', revision: 3 },
      }),
    ]);
    expect(headText()).toContain('合成矩阵甲改');

    await click('编辑');
    await type(field('description'), '   ');
    await click('保存', dialog());
    expect(backend.writes.at(-1)!.body).toEqual({ description: null, revision: 4 });
  });

  it('编辑 409：重读最新版本、核对差异后按新 revision 重提；改回原值不发请求', async () => {
    await ui.render();
    await click('编辑');
    await type(field('name'), '我的改名');
    backend.db.set(ids.a, { ...backend.db.get(ids.a)!, description: '他人改的描述', revision: 4 });
    await click('保存', dialog());
    expect(text(dialog())).toContain('版本冲突');
    await click('重读最新版本', dialog());
    expect(backend.reads.at(-1)!.pathname).toBe(`${BASE}/${ids.a}`);
    expect(text(dialog())).toContain('他人改的描述');
    await click('已核对差异，继续编辑', dialog());
    await click('保存', dialog());
    expect(backend.writes.at(-1)!.body).toEqual({ name: '我的改名', revision: 4 });
    expect(backend.db.get(ids.a)!.description).toBe('他人改的描述');

    // 再次冲突后把字段改回最新值：没有改动，不发命令、不锁定
    await click('编辑');
    await type(field('name'), '再改一次');
    backend.db.set(ids.a, { ...backend.db.get(ids.a)!, revision: 9 });
    await click('保存', dialog());
    await click('重读最新版本', dialog());
    await click('已核对差异，继续编辑', dialog());
    const count = backend.writes.length;
    await type(field('name'), '我的改名');
    await click('保存', dialog());
    expect(backend.writes).toHaveLength(count);
    expect(document.querySelector('.ant-modal')).toBeNull();
    expect(disabled('停用')).toBe(false);
  });

  it('编辑结果未知：弹窗与启停锁定，离开再回来仍锁定；回查原单不生成新命令', async () => {
    const id = lone();
    await ui.render();
    await click('编辑');
    await type(field('name'), '未知改名');
    backend.state.fail = () => {
      throw new TypeError('network down');
    };
    await click('保存', dialog());
    expect(text(dialog())).toContain('结果待确认');
    expect(disabled('保存')).toBe(true);
    await click('取消', dialog());
    expect(disabled('停用')).toBe(true);
    expect(disabled('编辑')).toBe(false);

    await reset();
    await click('编辑');
    expect(text(dialog())).toContain('结果待确认');
    expect(disabled('保存')).toBe(true);
    await click('回查原单', dialog());
    expect(backend.reads.at(-1)!.pathname).toBe(`${BASE}/${id}`);
    expect(text(dialog())).toContain('结果待确认');
    expect(backend.writes).toHaveLength(1);
  });

  it('回执与命令不符（revision 不是原值 + 1）按结果未知锁定', async () => {
    const id = lone();
    await ui.render();
    await click('编辑');
    await type(field('name'), '坏回执');
    backend.state.fail = () => Response.json({ ...backend.db.get(id)!, name: '坏回执', revision: 99 });
    await click('保存', dialog());
    expect(text(dialog())).toContain('结果待确认');
    expect(disabled('保存')).toBe(true);
  });
});

describe('AC-APV-F326-24 启停', () => {
  it('启用草稿：确认后带 revision 提交，头部变为启用', async () => {
    await ui.render();
    await select('合成矩阵乙');
    expect(find('停用')).toBeUndefined();
    await click('启用');
    expect(text(dialog())).toContain('确定启用矩阵「合成矩阵乙」吗');
    await click('确定', dialog());
    expect(backend.writes).toEqual([
      expect.objectContaining({ method: 'POST', path: `${BASE}/${ids.b}/enable`, body: { revision: 1 } }),
    ]);
    expect(headText()).toContain('合成矩阵乙');
    expect(headText()).toContain('启用');
  });

  it('停用的页签里启用：切到启用的页签并选中该矩阵', async () => {
    await ui.render();
    await click('停用的');
    await click('启用');
    await click('确定', dialog());
    expect(backend.writes.at(-1)).toMatchObject({ path: `${BASE}/${ids.c}/enable`, body: { revision: 2 } });
    expect(lastList().searchParams.get('status')).toBe('active');
    expect(headText()).toContain('COST_C');
  });

  it('有引用时停用：先读引用，弹影响清单，确认后带引用数提交并切到停用的页签', async () => {
    await ui.render();
    await click('停用');
    expect(backend.reads.at(-1)!.pathname).toBe(`${BASE}/${ids.a}/references`);
    const impact = text(dialog());
    expect(impact).toContain('以下流程引用了该矩阵，停用后这些节点将视为审批人为空，按节点空人策略处理');
    expect(impact).toContain('合成来源流程');
    expect(impact).toContain('P_SYNTH');
    expect(impact).toContain('会签节点');
    expect(impact).toContain('在途v1');
    expect(impact).toContain('复核节点');
    await click('确定', dialog());
    expect(backend.writes).toEqual([
      expect.objectContaining({
        path: `${BASE}/${ids.a}/disable`,
        body: { revision: 3, acknowledgedReferenceCount: 2 },
      }),
    ]);
    expect(lastList().searchParams.get('status')).toBe('disabled');
    expect(headText()).toContain('合成矩阵甲');
    expect(headText()).toContain('停用');
  });

  it('无引用时停用：普通确认，acknowledgedReferenceCount 为 0', async () => {
    backend.db.set(ids.b, { ...backend.db.get(ids.b)!, status: 'enabled' });
    await ui.render();
    await select('合成矩阵乙');
    await click('停用');
    const confirm = text(dialog());
    expect(confirm).toContain('确定停用矩阵「合成矩阵乙」吗');
    expect(confirm).not.toContain('以下流程引用了该矩阵');
    await click('确定', dialog());
    expect(backend.writes.at(-1)!.body).toEqual({ revision: 1, acknowledgedReferenceCount: 0 });
  });

  it('确认后引用变化（409）：提示原因、不锁定；再点停用重新读引用并按新数量提交', async () => {
    await ui.render();
    await click('停用');
    backend.refs.get(ids.a)!.items.push(reference({ processCode: 'P_NEW', processName: '新加流程' }));
    await click('确定', dialog());
    expect(text()).toContain('引用该对象的流程节点已变化，请重新查看影响后再确认');
    expect(backend.db.get(ids.a)!.status).toBe('enabled');
    expect(disabled('停用')).toBe(false);
    await click('停用');
    expect(text(dialog())).toContain('新加流程');
    await click('确定', dialog());
    expect(backend.writes).toHaveLength(2);
    expect(backend.writes[1]!.body).toEqual({ revision: 3, acknowledgedReferenceCount: 3 });
    expect(backend.writes[1]!.key).not.toBe(backend.writes[0]!.key);
  });

  it('版本冲突（他人已改）：提示刷新，列表重读后按新 revision 重提', async () => {
    await ui.render();
    backend.db.set(ids.a, { ...backend.db.get(ids.a)!, name: '他人改名', revision: 5 });
    await click('停用');
    await click('确定', dialog());
    expect(text()).toContain('记录已被更新');
    expect(headText()).toContain('他人改名');
    await click('停用');
    await click('确定', dialog());
    expect(backend.writes.at(-1)!.body).toEqual({ revision: 5, acknowledgedReferenceCount: 2 });
    expect(backend.db.get(ids.a)!.status).toBe('disabled');
  });

  it('停用结果未知：启停与编辑锁定，离开再回来仍锁定，不生成新命令', async () => {
    const id = lone();
    await ui.render();
    await click('停用');
    backend.state.fail = () => {
      throw new TypeError('network down');
    };
    await click('确定', dialog());
    expect(text()).toContain('结果待确认');
    expect(disabled('停用')).toBe(true);
    expect(disabled('编辑')).toBe(true);
    await reset();
    expect(text()).toContain('结果待确认');
    expect(disabled('停用')).toBe(true);
    await click('回查原单');
    expect(backend.reads.at(-1)!.pathname).toBe(`${BASE}/${id}`);
    expect(disabled('停用')).toBe(true);
    expect(backend.writes).toHaveLength(1);
  });
});

describe('AC-APV-F326-24 查看引用', () => {
  it('列出流程、版本、节点、引用位置与在途实例数；超出 200 条时提示总数', async () => {
    backend.refs.get(ids.a)!.total = 230;
    backend.refs
      .get(ids.a)!
      .items.push(reference({ versionKind: 'current', versionNo: 2, position: 'empty_approver' }));
    await ui.render();
    await click('查看引用');
    const shown = text(dialog());
    expect(shown).toContain('引用流程');
    expect(shown).toContain('合成来源流程');
    expect(shown).toContain('草稿v1');
    expect(shown).toContain('当前v2');
    expect(shown).toContain('在途v1');
    expect(shown).toContain('审批人为空时');
    expect(shown).toContain('3');
    expect(shown).toContain('共230条，仅显示前3条');
    expect(backend.writes).toHaveLength(0);
  });

  it('没有引用时显示空状态', async () => {
    await ui.render();
    await select('合成矩阵乙');
    await click('查看引用');
    expect(text(dialog())).toContain('暂无流程引用该矩阵');
  });
});

/** 弹窗里某个表单项（按标签）显示的文字。 */
const formItem = (label: string) =>
  [...dialog()!.querySelectorAll('.ant-form-item')].find(
    (node) => text(node.querySelector('.ant-form-item-label') ?? node) === label,
  );

describe('AC-APV-F326-24 第 1 轮审查回归', () => {
  it('P2-1 编辑 409：他人已停用，重读后只读状态显示停用；重提只带可编辑字段', async () => {
    const id = lone();
    await ui.render();
    await click('编辑');
    expect(text(formItem('状态'))).toContain('启用');
    await type(field('name'), '我的改名');
    backend.db.set(id, { ...backend.db.get(id)!, status: 'disabled', revision: 4 });
    await click('保存', dialog());
    expect(text(dialog())).toContain('版本冲突');
    await click('重读最新版本', dialog());
    await click('已核对差异，继续编辑', dialog());
    expect(text(formItem('状态'))).toContain('停用');
    expect(text(formItem('状态'))).not.toContain('启用');
    await click('保存', dialog());
    expect(backend.writes.at(-1)).toMatchObject({ method: 'PATCH', path: `${BASE}/${id}` });
    expect(backend.writes.at(-1)!.body).toEqual({ name: '我的改名', revision: 4 });
  });

  async function create(code: string, name: string) {
    await click('新建矩阵');
    await type(field('name'), name);
    await type(field('code'), code);
    await click('保存', dialog());
    expect(backend.writes.at(-1)).toMatchObject({ method: 'POST', body: { code, name } });
    expect(document.querySelector('.ant-modal')).toBeNull();
  }

  it('P2-2 筛选下新建：新矩阵不在筛选结果里，右侧仍展示回执对象', async () => {
    await ui.render();
    await type(document.querySelector<HTMLInputElement>('.matrix-list input'), '合成矩阵甲');
    await clickNode(document.querySelector('.matrix-list .ant-input-search-button'));
    expect(listText()).toContain('APPROVE_A');
    await create('NEW_FILTERED', '筛选外新矩阵');
    expect(listText()).not.toContain('NEW_FILTERED');
    expect(headText()).toContain('NEW_FILTERED');
    expect(headText()).toContain('筛选外新矩阵');
    expect(headText()).not.toContain('APPROVE_A');
  });

  it('P2-2 超过 50 条时新建：新矩阵排在第一页之外，右侧仍展示回执对象', async () => {
    for (let i = 0; i < 60; i += 1) {
      const id = `81000000-0000-4000-8000-2000000000${String(i).padStart(2, '0')}`;
      backend.db.set(id, head({ id, code: `Z_${String(i).padStart(2, '0')}`, name: `批量矩阵${i}` }));
    }
    await ui.render();
    await create('ZZ_LAST', '页外新矩阵');
    expect(lastList().searchParams.get('offset')).toBe('0');
    expect(listText()).not.toContain('ZZ_LAST');
    expect(headText()).toContain('ZZ_LAST');
    expect(headText()).toContain('页外新矩阵');
  });

  it('P2-3 同一会签节点引用两个角色列：清单展示被引用的角色列，两行可区分、行键不重复', async () => {
    const [leader, finance] = ['83000000-0000-4000-8000-000000000011', '83000000-0000-4000-8000-000000000012'];
    backend.columns.set(ids.a, [roleColumn(leader, '合成直属上级列', 1), roleColumn(finance, '合成财务负责人列', 2)]);
    backend.refs.set(ids.a, { items: [reference({ columnId: leader }), reference({ columnId: finance })] });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await ui.render();
    await click('查看引用');
    const rows = [...dialog()!.querySelectorAll('tbody tr.ant-table-row')].map((tr) => text(tr));
    expect(text(dialog()!.querySelector('thead') ?? dialog()!)).toContain('角色列');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('合成直属上级列');
    expect(rows[1]).toContain('合成财务负责人列');
    expect(new Set(rows).size).toBe(2);
    const duplicate = errors.mock.calls.some((call) => call.some((arg) => String(arg).includes('same key')));
    errors.mockRestore();
    expect(duplicate).toBe(false);
  });
});
