/**
 * BE-15b1 第 2 轮审查返工（#415）P2-1（续），真实授权器（authorize: undefined）：员工调动后，考核的人员范围以员工“当前”任职
 * 为准——列表、详情、修改、重提共用同一个人员范围谓词，不再额外要求创建时保存的旧部门也在范围内；裁剪在分页之前。
 * 员工 A 部门发起考核并审批通过后调到 B 部门：只有 B 范围的经办人能在列表里看到、能办理；只有 A 范围的经办人列表看不到，
 * 详情 / 修改 404（与不存在同体）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { realOperator } from './AC-PB-BE15b1-real-support.js';
import { assessmentWorld, type AssessmentView } from './AC-PB-BE15b1-support.js';

const testDb = useTestDb();
const MISSING = '00000000-0000-4000-8000-000000000001';

async function setup(label: string) {
  const w = await assessmentWorld(testDb().db, `r3-${label}`);
  const other = await w.org(`调入部门-${label}`);
  const moved = await w.probationer('调动员工');
  const movedId = await w.launch('probation', moved);
  await w.complete(movedId, moved, { managerRating: 'meets', regularizationOpinion: 'normal' });
  // 直接调动到调入部门（今天生效）：员工当前任职部门变了，考核上保存的创建时部门仍是原部门
  const transferred = await w.request(
    w.hr.id,
    'POST',
    `/api/tenant/employment/employees/${moved.employeeId}/businesses`,
    {
      ifMatch: await w.employeeRevision(moved.employeeId),
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-01', fields: { departmentId: other } },
    },
  );
  expect(transferred.status, await transferred.clone().text()).toBe(201);
  const op = await realOperator(w);
  return { w, other, moved, movedId, op };
}

const ids = async (response: Response) =>
  ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id);

describe('P2-1（续）员工调动后考核的人员范围以当前任职为准', () => {
  it('只有调入部门范围：列表能看到，详情 / 修改可办理', async () => {
    const { w, other, movedId, op } = await setup('to');
    await op.setScope([other]);
    const listed = await op.call('GET', '/probation-assessments');
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect(await ids(listed)).toEqual([movedId]);
    const detail = await op.call('GET', `/probation-assessments/${movedId}`);
    expect(detail.status, await detail.clone().text()).toBe(200);
    const current = (await detail.json()) as AssessmentView;
    const patched = await op.call('PATCH', `/probation-assessments/${movedId}`, {
      ifMatch: current.revision,
      body: { managerRating: 'exceeds' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect((await w.get(movedId)).managerRating).toBe('exceeds');
  });

  it('只有原部门范围：列表看不到，详情 / 修改 404（与不存在同体），考核不变', async () => {
    const { w, movedId, op } = await setup('from');
    await op.setScope([w.department]);
    const listed = await op.call('GET', '/probation-assessments');
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect(await ids(listed)).toEqual([]);
    const before = await w.get(movedId);
    const hidden = await op.call('GET', `/probation-assessments/${movedId}`);
    const missing = await op.call('GET', `/probation-assessments/${MISSING}`);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
    const patched = await op.call('PATCH', `/probation-assessments/${movedId}`, {
      ifMatch: before.revision,
      body: { managerRating: 'exceeds' },
    });
    expect(patched.status).toBe(404);
    expect(await w.get(movedId)).toEqual(before);
  });

  it('分页：先按范围裁剪再分页，每页条数与总集合一致', async () => {
    const { w, other, movedId, op } = await setup('page');
    const second = await w.probationer('调入部门原有员工', { department: other });
    const secondId = await w.launch('probation', second);
    const outside = await w.probationer('原部门员工');
    await w.launch('probation', outside);
    await op.setScope([other]);
    const pages: string[][] = [];
    for (const page of [1, 2, 3]) {
      const response = await op.call('GET', `/probation-assessments?page=${page}&pageSize=1`);
      expect(response.status, await response.clone().text()).toBe(200);
      pages.push(await ids(response));
    }
    expect(pages.map((p) => p.length)).toEqual([1, 1, 0]);
    expect(pages.flat().sort()).toEqual([movedId, secondId].sort());
  });
});
