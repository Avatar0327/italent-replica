import { describe, expect, it } from 'vitest';
import { approverSource } from '@italent/domain';
import { assertDraftStructure } from '../../apps/web/src/approval/designer/model.js';
import { fallbackFixture } from './support/f304-fixture.js';

const owner = approverSource('handover_work_owner');
const hrAdmin = approverSource('handover_hr_admin');
const changed = '流程版本或节点结构已变更';

// F-378：409 重读后是否允许再次 PUT，要看“有序来源类型 + 值”，不能只看能否兜底（F-304 / F-318a）。
describe('AC-FE-F378 设计器重读结构核对比较有序来源', () => {
  it('01 两个都支持兜底的来源被替换（工作交接负责人→HR 管理员），重读后拒绝再次提交', () => {
    const original = fallbackFixture().latestVersion;
    const latest = structuredClone(original);
    Object.assign(original.nodes[0]!, { approvers: [owner] });
    Object.assign(latest.nodes[0]!, { approvers: [hrAdmin] });
    expect(() => assertDraftStructure(original, latest)).toThrow(changed);
  });
  it('02 同一组兜底来源被重排，重读后拒绝再次提交', () => {
    const original = fallbackFixture().latestVersion;
    const latest = structuredClone(original);
    Object.assign(original.nodes[0]!, { approvers: [owner, hrAdmin] });
    Object.assign(latest.nodes[0]!, { approvers: [hrAdmin, owner] });
    expect(() => assertDraftStructure(original, latest)).toThrow(changed);
  });
  it('03 来源只追加一条兜底来源，同样视为结构变化', () => {
    const original = fallbackFixture().latestVersion;
    const latest = structuredClone(original);
    Object.assign(original.nodes[0]!, { approvers: [owner] });
    Object.assign(latest.nodes[0]!, { approvers: [owner, hrAdmin] });
    expect(() => assertDraftStructure(original, latest)).toThrow(changed);
  });
  it('04 来源完全相同时，别人只改名称或兜底人员仍可恢复提交', () => {
    const original = fallbackFixture().latestVersion;
    Object.assign(original.nodes[0]!, { approvers: [owner, hrAdmin] });
    const latest = structuredClone(original);
    Object.assign(latest.nodes[0]!, { name: '别人改名', fallbackUserIds: ['a3000000-0000-4000-8000-000000000001'] });
    expect(() => assertDraftStructure(original, latest)).not.toThrow();
  });
  it('05 不支持兜底的节点来源被别人修改，仍按字段合并（不扩大拦截）', () => {
    const original = fallbackFixture().latestVersion;
    const latest = structuredClone(original);
    const plain = original.nodes.findIndex((node) => node.kind === 'single');
    Object.assign(latest.nodes[plain]!, { approver: approverSource('direct_manager') });
    expect(() => assertDraftStructure(original, latest)).not.toThrow();
  });
});
