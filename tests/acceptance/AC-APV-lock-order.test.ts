/**
 * F-008 / R6-3：停用接管在一个事务里逐页处理、已取的锁不释放，分页必须沿同一全局取锁顺序（异动员工, 实例编号）延续：
 * 逐页取出的结果拼起来恰好是全局顺序，不能只在每页内部排序。并发死锁的真 PostgreSQL 强制交错见
 * AC-APV-concurrency-pg.test.ts（R6-3）；本文件是补充覆盖（旧实现没有这一分页函数，不适用“先失败”）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { pendingInLockOrder, type LockKey } from '../../apps/api/src/modules/approval/handover.js';
import { approvalWorld, TRANSFER_NODES, transferScene } from './AC-APV-support.js';

const database = useTestDb();

const fixedId = (n: number) => `f0080000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** 小写规范 UUID 文本的字典序与 PostgreSQL uuid 的排序一致。 */
function textOrder(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
const tupleOrder = (a: LockKey, b: LockKey) => textOrder(a.employee_id, b.employee_id) || textOrder(a.id, b.id);

describe('R6-3：停用接管的分页沿全局取锁顺序（异动员工, 实例编号）延续', () => {
  it('实例编号与员工编号顺序相反、页长 2：逐页拼接即全局升序，不重不漏，且不同于按实例编号的顺序', async () => {
    const w = await approvalWorld(database().db, 'apv-r63-pages');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { hrbp: null });
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!] });
    const applicant = await w.member('发起人');
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to }, { actor: applicant });
    let legal = await w.submit(draft, applicant);
    const first = legal.tasks.find((task) => task.status === 'pending')!;
    legal = await w.json(await w.taskAction(s.outHead.userId, first.id, 'approve', legal.revision));
    // 可信夹具（同 N4）：以真实实例为底稿再插五张停在异常管理员的在途实例；编号按员工倒序分配，使两种顺序相反。
    const employees = (await Promise.all(['甲', '乙', '丙'].map((name) => w.employee(`异动对象${name}`))))
      .map((employee) => employee.id)
      .sort();
    const [e1, e2, e3] = employees as [string, string, string];
    const fakes: [number, string][] = [
      [1, e3],
      [2, e2],
      [3, e1],
      [4, e3],
      [5, e1],
    ];
    await withTenant(w.db, w.tenant.id, async (tx) => {
      for (const [n, employeeId] of fakes) {
        await tx.execute(sql`INSERT INTO approval_instances
          (id,tenant_id,process_id,version_id,approval_type,object_code,business_type,business_id,subject_employee_id,
           initiator_user_id,process_code,title,business_version,status,current_node_key,round,revision,
           created_at,updated_at)
          SELECT ${fixedId(n)}::uuid,i.tenant_id,i.process_id,i.version_id,i.approval_type,i.object_code,
            i.business_type,gen_random_uuid(),${employeeId}::uuid,i.initiator_user_id,i.process_code,i.title,
            i.business_version,'running','in_hrbp',1,1,now(),now()
          FROM approval_instances i WHERE i.tenant_id=${w.tenant.id} AND i.id=${legal.id}::uuid`);
        await tx.execute(sql`INSERT INTO approval_tasks
          (id,tenant_id,instance_id,seq,round,node_key,assignee_user_id,origin,status,is_exception_admin,created_at)
          VALUES (gen_random_uuid(),${w.tenant.id},${fixedId(n)}::uuid,1,1,'in_hrbp',${w.exceptionAdmin}::uuid,
            'exception_admin','pending',true,now())`);
      }
    });
    const pages: LockKey[][] = await withTenant(w.db, w.tenant.id, async (tx) => {
      const collected: LockKey[][] = [];
      let after: LockKey | null = null;
      for (;;) {
        const page = await pendingInLockOrder(tx, w.tenant.id, w.exceptionAdmin, after, 2);
        if (page.length) collected.push(page);
        if (page.length < 2) return collected;
        after = page.at(-1)!;
      }
    });
    const walked = pages.flat();
    expect(pages.map((page) => page.length)).toEqual([2, 2, 2]);
    expect(new Set(walked.map((key) => key.id))).toEqual(new Set([legal.id, ...fakes.map(([n]) => fixedId(n))]));
    expect(walked).toEqual([...walked].sort(tupleOrder));
    // 员工锁总是按编号递增取得：甲的两张、乙、丙的两张依次处理，夹杂其中的真实单按其员工编号就位。
    const fakeOrder = walked.filter((key) => key.id !== legal.id).map((key) => key.id);
    expect(fakeOrder).toEqual([fixedId(3), fixedId(5), fixedId(2), fixedId(1), fixedId(4)]);
    expect(fakeOrder).not.toEqual([...fakeOrder].sort());
  });
});
