/**
 * F-025 演示种子：用户接管（DEC-477）。种子场景的单据上一旦出现不是种子自己发起的操作——转交、加签、管理员转交 /
 * 干预、催办、重提等——就视为用户接管，种子续跑永不再动这张单（不审批、不驳回、不撤回、不新增日志）。
 * 每条序列都是：种子在某场景创建后中断（没有完成记录）→ 用户经公开接口操作 → 续跑种子 → 单据与审批实例保持用户操作后的样子。
 * 节点转交 / 加签需要流程开关：在种子发布演示流程后中断，经公开流程配置接口发新版本打开开关，再继续。
 */
import { createTestDb } from '@italent/testkit';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEMO_TRANSFER_PROCESS_CODE } from '../../apps/api/src/demo/data.js';
import { fileProgress, seedDemo } from '../../apps/api/src/demo/seed.js';
import { actors, enableTransferAndAddSign, options, stopAfter } from './support/demo-seed.js';

vi.setConfig({ testTimeout: 900_000 });

describe('F-025 演示种子：默认流程上用户接管后，续跑不再动这张单（DEC-477）', () => {
  it('催办（发起人）/ 驳回后重提 / 管理员转交后续跑：保持用户操作后的状态，无新增日志；记入接管后永久跳过', async () => {
    const handle = await createTestDb();
    const dir = mkdtempSync(join(tmpdir(), 'italent-seed-takeover-'));
    try {
      // DEMO-TRF-13（驳回，员工甲本人发起）创建后中断：员工甲催办
      await expect(seedDemo(handle.db, stopAfter('DEMO-TRF-13'))).rejects.toThrow('DEMO-TRF-13 之后');
      const user = await actors(handle.db);
      const employeeA = await user.persona('employeeA');
      const urged = await user.instanceOf('DEMO-TRF-13');
      await user.send(employeeA, 'POST', `/api/tenant/approval/instances/${urged.id}/urge`, {}, urged.revision);
      const after13 = await user.snapshot('DEMO-TRF-13');

      // DEMO-TRF-14（驳回，HR 发起）创建后中断：平台研发部经理驳回，HR 在申请单上重提（同一实例 round + 1）
      await expect(seedDemo(handle.db, stopAfter('DEMO-TRF-14'))).rejects.toThrow('DEMO-TRF-14 之后');
      const admin = await user.persona('admin');
      const hr = await user.persona('hr');
      const platformManager = await user.persona('platformManager');
      const rejected = await user.pendingTask('DEMO-TRF-14');
      await user.send(
        platformManager,
        'POST',
        `/api/tenant/approval/tasks/${rejected.task.id}/reject`,
        { comment: '演示：请补充' },
        rejected.instance.revision,
      );
      const businessPath = `/api/tenant/employment/businesses/${await user.businessOf('DEMO-TRF-14')}`;
      const business = await user.send(hr, 'GET', businessPath);
      await user.send(hr, 'POST', `${businessPath}/submit`, {}, Number(business.revision));
      const after14 = await user.snapshot('DEMO-TRF-14');
      expect(after14.instances).toHaveLength(1);
      expect(after14.instances[0]!.round).toBe(2);

      // DEMO-TRF-15（撤回）创建后中断：系统管理员把待办转交平台研发部经理（审查复现 1）
      await expect(seedDemo(handle.db, stopAfter('DEMO-TRF-15'))).rejects.toThrow('DEMO-TRF-15 之后');
      const transfer = await user.pendingTask('DEMO-TRF-15');
      await user.send(
        admin,
        'POST',
        `/api/tenant/approval/instances/${transfer.instance.id}/admin-transfer`,
        { taskId: transfer.task.id, toUserId: platformManager, reason: '演示：转交' },
        transfer.instance.revision,
      );
      const after15 = await user.snapshot('DEMO-TRF-15');
      expect([after13.status, after14.status, after15.status]).toEqual(['in_review', 'in_review', 'in_review']);

      // 无完成记录续跑到底：三张单原样不动
      await seedDemo(handle.db, options);
      expect(await user.snapshot('DEMO-TRF-13')).toEqual(after13);
      expect(await user.snapshot('DEMO-TRF-14')).toEqual(after14);
      expect(await user.snapshot('DEMO-TRF-15')).toEqual(after15);

      // 带状态文件再跑：判定为已接管并记入文件，之后整体跳过
      const file = join(dir, 'seed-state.json');
      await seedDemo(handle.db, { ...options, progress: fileProgress(file) });
      const state = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { takenOver?: string[] }>;
      expect(state[user.tenantId]!.takenOver).toEqual(['DEMO-TRF-13', 'DEMO-TRF-14', 'DEMO-TRF-15']);
      let steps = 0;
      await seedDemo(handle.db, { ...options, progress: fileProgress(file), onStep: () => void (steps += 1) });
      expect(steps).toBe(0);
      expect(await user.snapshot('DEMO-TRF-15')).toEqual(after15);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await handle.close();
    }
  });
});

describe('F-025 演示种子：开启节点转交 / 加签后用户接管，续跑不再动这张单（DEC-477）', () => {
  it('管理员干预改派 / 节点转交 / 前加签后续跑：保持用户操作后的状态，无新增日志', async () => {
    const handle = await createTestDb();
    try {
      // 演示流程发布后中断：经公开配置接口打开两个节点的转交与加签
      const published = `${DEMO_TRANSFER_PROCESS_CODE}:publish`;
      await expect(seedDemo(handle.db, stopAfter(published))).rejects.toThrow(`${published} 之后`);
      const user = await actors(handle.db);
      await enableTransferAndAddSign(user);

      // DEMO-TRF-02（在途，预设先过 1 个节点）创建后中断：系统管理员干预，把经理待办改派给数据研发部经理
      await expect(seedDemo(handle.db, stopAfter('DEMO-TRF-02'))).rejects.toThrow('DEMO-TRF-02 之后');
      const admin = await user.persona('admin');
      const platformManager = await user.persona('platformManager');
      const dataManager = await user.persona('dataManager');
      const intervene = await user.pendingTask('DEMO-TRF-02');
      await user.send(
        admin,
        'POST',
        `/api/tenant/approval/instances/${intervene.instance.id}/admin-intervene`,
        { kind: 'reassign', taskId: intervene.task.id, toUserId: dataManager, reason: '演示：改派' },
        intervene.instance.revision,
      );
      const after02 = await user.snapshot('DEMO-TRF-02');
      expect(after02.status).toBe('in_review');

      // DEMO-TRF-14（驳回）创建后中断：平台研发部经理把待办转交数据研发部经理（审查复现 2）
      await expect(seedDemo(handle.db, stopAfter('DEMO-TRF-14'))).rejects.toThrow('DEMO-TRF-14 之后');
      const transfer = await user.pendingTask('DEMO-TRF-14');
      await user.send(
        platformManager,
        'POST',
        `/api/tenant/approval/tasks/${transfer.task.id}/transfer`,
        { toUserId: dataManager, comment: '演示：转交' },
        transfer.instance.revision,
      );
      const after14 = await user.snapshot('DEMO-TRF-14');

      // DEMO-TRF-15（撤回）创建后中断：数据研发部经理前加签平台研发部经理（审查复现 3）
      await expect(seedDemo(handle.db, stopAfter('DEMO-TRF-15'))).rejects.toThrow('DEMO-TRF-15 之后');
      const addSign = await user.pendingTask('DEMO-TRF-15');
      await user.send(
        dataManager,
        'POST',
        `/api/tenant/approval/tasks/${addSign.task.id}/add-sign`,
        { userIds: [platformManager], type: 'before', comment: '演示：前加签' },
        addSign.instance.revision,
      );
      const after15 = await user.snapshot('DEMO-TRF-15');
      expect([after14.status, after15.status]).toEqual(['in_review', 'in_review']);

      // 无完成记录续跑到底，再跑一遍：三张单都原样不动
      for (let run = 0; run < 2; run += 1) {
        await seedDemo(handle.db, options);
        expect(await user.snapshot('DEMO-TRF-02')).toEqual(after02);
        expect(await user.snapshot('DEMO-TRF-14')).toEqual(after14);
        expect(await user.snapshot('DEMO-TRF-15')).toEqual(after15);
      }
    } finally {
      await handle.close();
    }
  });
});
