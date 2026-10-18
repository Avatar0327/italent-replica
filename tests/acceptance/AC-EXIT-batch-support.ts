/** 批量离职闭包用例的共用夹具（P2-2）：按 UUID 排序的三名员工、转交计划与批量请求体。 */
import { type GateWorld } from './AC-EXIT-gate-support.js';

export const LATER = '2026-10-20';

/** 三名员工按 UUID 排序：S < A < B；B 是 S 的直线经理（S 的转交对象），A 无关；再加一名在职接收人。 */
export async function orderedPeople(w: GateWorld) {
  const created = await Promise.all(['人甲', '人乙', '人丙'].map((name) => w.session.employee(name)));
  const [s, a, b] = [...created].sort((x, y) => x.id.localeCompare(y.id));
  const hire = (employee: { id: string; revision: number }, fields: object) =>
    w.session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: w.from.id, ...fields } },
      employee.revision,
    );
  await hire(b!, {});
  await hire(a!, {});
  await hire(s!, { directManagerId: b!.id });
  const receiver = (await w.hired('接收人')).employee;
  return { s: s!.id, a: a!.id, b: b!.id, receiver: receiver.id };
}

export const dutyPlan = (subordinateId: string, receiverId: string) => ({
  dutyTransfer: { subordinates: [{ employeeId: subordinateId, receiverId, relation: 'direct' }], orgRoles: [] },
});

export async function batchItems(w: GateWorld, entries: readonly { id: string; exit?: object }[]) {
  return Promise.all(
    entries.map(async ({ id, exit }) => ({
      employeeId: id,
      revision: (await w.session.getEmployee(id)).revision,
      lastWorkDate: LATER,
      exit: { exitTypeCode: 'voluntary', ...exit },
    })),
  );
}
