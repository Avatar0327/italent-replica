/**
 * F-412（BE-10d 头字段派生名称按组织对象范围遮罩，DEC-406 / DEC-775；后补-权限，并入 F-087）：
 * HR 路径读头（列表、详情）时，调整范围里的组织名称与审批主体组织名称按查看人的**组织对象**范围复核：
 * 范围外的名称与“包含下级”文案给 null，响应里不出现它的现名；范围内照常。审批人路径不受组织对象范围约束（口径不变）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { ALL, BASE, only } from './AC-OA-head-support.js';
import { itemsWorld } from './AC-OA-items-support.js';
import { orgName } from './AC-OA-read-support.js';

const testDb = useTestDb();

interface RangeView {
  orgId: string;
  name: string | null;
  label: string | null;
}
interface HeadView {
  approvalSubjectOrgId?: string;
  approvalSubjectOrgName?: string | null;
  adjustmentRange?: RangeView[];
}

/** 范围含甲、乙；审批主体组织是另一个组织（subject）。 */
async function headNamesWorld(label: string) {
  const w = await itemsWorld(testDb().db, label);
  const view = await w.created(w.head({ adjustmentRange: [w.a, w.b] }));
  const names = {
    a: await orgName(w, w.a),
    b: await orgName(w, w.b),
    subject: await orgName(w, w.subject),
  };
  const detail = async () => {
    const res = await w.call('GET', `${BASE}/${view.id}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as HeadView;
  };
  const listed = async () => {
    const res = await w.call('GET', BASE);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { items: (HeadView & { id: string })[] };
    return body.items.find((item) => item.id === view.id)!;
  };
  return { w, view, names, detail, listed };
}

describe('F-412 头字段派生名称按组织对象范围遮罩', () => {
  it('正向对照：组织对象范围含全部组织 → 范围名称、文案与主体组织名称都给出', async () => {
    const { w, names, detail, listed } = await headNamesWorld('f412-visible');
    w.access.org = ALL;
    for (const head of [await detail(), await listed()]) {
      expect(head.adjustmentRange).toEqual([
        { orgId: w.a, name: names.a, label: `${names.a}（包含下级）` },
        { orgId: w.b, name: names.b, label: `${names.b}（包含下级）` },
      ]);
      expect(head.approvalSubjectOrgName).toBe(names.subject);
    }
  });

  it('组织对象范围只含甲：范围里乙的名称 / 文案为 null、主体组织名称为 null，响应里没有乙与主体组织的现名', async () => {
    const { w, names, detail, listed } = await headNamesWorld('f412-scope');
    w.access.org = only(w.a);
    for (const head of [await detail(), await listed()]) {
      expect(head.adjustmentRange).toEqual([
        { orgId: w.a, name: names.a, label: `${names.a}（包含下级）` },
        { orgId: w.b, name: null, label: null },
      ]);
      expect(head.approvalSubjectOrgName).toBeNull();
      const text = JSON.stringify(head);
      expect(text).not.toContain(names.b);
      expect(text).not.toContain(names.subject);
    }
  });

  it('组织对象范围为空：全部范围名称与主体组织名称都为 null（fail-closed），头的其余字段照常', async () => {
    const { w, names, detail } = await headNamesWorld('f412-empty');
    w.access.org = only();
    const head = await detail();
    expect(head.adjustmentRange!.map((r) => [r.name, r.label])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(head.approvalSubjectOrgName).toBeNull();
    expect(head.approvalSubjectOrgId).toBe(w.subject);
    expect(JSON.stringify(head)).not.toContain(names.a);
  });
});
