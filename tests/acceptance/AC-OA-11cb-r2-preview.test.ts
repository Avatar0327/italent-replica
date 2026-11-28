/**
 * BE-11c-b 第 2 轮 P2-1（R2-T08 §6.2、§4.5，DEC-745）：预览树与调动分区的披露验收。
 * 预览是生效日组织架构树（节点只有组织属性与增减标记，不带在岗 / 兼岗人数，DEC-745 已取消）；调动行不是组织节点，
 * 不进树，编制增减随 11e / 11f 的生成行。本片要证的是：同单含调动行时，预览对 HR 与审批人都不带人员 ID、行 ID、人数，
 * 也不因查看人对调动行的任职范围不同而变形（调动行的可见性不能经预览树间接露出）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { transferWorld } from './AC-OA-11cb-support.js';
import { newOrg } from './AC-OA-items-support.js';
import { onlyPeople } from './AC-OA-head-support.js';
import { flatten } from './AC-OA-read-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const PREVIEW = '/api/tenant/org-adjustment/adjustments';

async function build(label: string) {
  const w = await transferWorld(testDb().db, label);
  const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
  const orgItemId = (await w.item(view.id, newOrg(w.a, { name: `ZZ_新增组织${uniqueSuffix()}` }))).items[0]!.id;
  const [first, second] = [await w.staff(w.a), await w.staff(w.b)];
  const rows = [
    await w.seed(view.id, first),
    await w.seed(view.id, second, { departmentId: null, departmentItemId: orgItemId }),
  ];
  await w.submitted(view.id);
  const preview = async (user: string) => {
    const res = await w.call('GET', `${PREVIEW}/${view.id}/preview`, {}, user);
    expect(res.status, await res.clone().text()).toBe(200);
    return { text: await res.clone().text(), body: (await res.json()) as { roots: { children: unknown[] }[] } };
  };
  return { w, view, orgItemId, people: [first, second], rows, preview };
}

describe('P2-1 预览树不露出调动行', () => {
  it('HR 与审批人读到的预览：新增组织节点在树上，不含人员 ID、调动行 ID，也没有人数字段', async () => {
    const { w, orgItemId, people, rows, preview } = await build('r2-preview-hr');

    for (const user of [w.hr.id, w.hrbp.userId]) {
      const { text, body } = await preview(user);
      expect(flatten(body.roots as never).some((node) => node.itemId === orgItemId && node.mark === 'added')).toBe(
        true,
      );
      for (const secret of [...people, ...rows]) expect(text).not.toContain(secret);
      expect(text).not.toMatch(/headcount|onDuty|partTimeCount|transfer/i);
    }
  });

  it('调动行的任职范围不同，预览树逐字相同（可见性不经树间接露出）', async () => {
    const { w, people, preview } = await build('r2-preview-scope');
    const full = (await preview(w.hr.id)).text;

    w.access.employment = onlyPeople(w.a, people[0]!);
    const partial = (await preview(w.hr.id)).text;
    w.access.employment = onlyPeople(w.a, await w.staff(w.a)); // 一个调动行的员工都不在范围内
    const none = (await preview(w.hr.id)).text;

    expect(partial).toBe(full);
    expect(none).toBe(full);
  });
});
