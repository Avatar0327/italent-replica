/**
 * AC-F476-08（P4 部分）：任职 / 离退类审批——办理 → 改单 → 两条路径读取（设计 §9）。
 * 已办的审批人读人事详情入口（任职业务 / 离职 / 退休）应读到办理时冻结的那份，并带 contentView.mode=frozen；
 * 发起人读现值（contentView.mode=live）。人事主数据入口（/records）是主数据，不属审批内容，不在本片，仍读现值。
 * 本片覆盖：transfer / hire / regularization / intern_regularization / leave / retirement。
 * 留给 P5：合同 / 兼职；留给 P7：考核 / 意向退休；留给 P9：其余。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  EMP,
  changeAfterHandled,
  entriesOf,
  expectedMarker,
  handledScene,
  markerOf,
  readsBy,
  type Body,
  type ScenarioKind,
} from './AC-F476-p4-support.js';

const testDb = useTestDb();
const KINDS: ScenarioKind[] = ['transfer', 'hire', 'regularization', 'intern_regularization', 'leave', 'retirement'];

describe.each(KINDS)('AC-F476-08 P4 %s：办理后改单', (kind) => {
  it('已办审批人在各入口读到办理时的值，并标明 frozen', async () => {
    const scene = await handledScene(testDb().db, `f476-p4-08-${kind}`, kind);
    await changeAfterHandled(scene);
    const approver = await readsBy(scene, scene.approver.userId);
    for (const entry of entriesOf(kind)) expect(approver[entry].status, `${kind}/${entry}`).toBe(200);
    expect(markerOf(kind, approver)).toBe(expectedMarker(scene, 'before'));
    for (const entry of entriesOf(kind))
      expect(approver[entry].body.contentView?.mode, `${kind}/${entry}`).toBe('frozen');
  });

  it('发起人读现值（改单后的值），并标明 live', async () => {
    const scene = await handledScene(testDb().db, `f476-p4-08-live-${kind}`, kind);
    await changeAfterHandled(scene);
    const initiator = await readsBy(scene, scene.w.hr.id);
    expect(markerOf(kind, initiator)).toBe(expectedMarker(scene, 'after'));
    for (const entry of entriesOf(kind))
      expect(initiator[entry].body.contentView?.mode, `${kind}/${entry}`).toBe('live');
  });
});

// 员工在途退休单（F-410）与退休详情是同一份内容的两个入口：已办审批人从在途入口也不能读到现值
describe('AC-F476-08 P4 retirement：员工在途退休单入口', () => {
  it('已办审批人读办理时的值（frozen），发起人读现值（live）', async () => {
    const scene = await handledScene(testDb().db, 'f476-p4-08-in-flight', 'retirement');
    await changeAfterHandled(scene);
    const path = `${EMP}/retirements/employees/${scene.subjectId}/in-flight`;
    const itemOf = async (user: string) => {
      const response = await scene.w.request(user, 'GET', path);
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { item: Body }).item;
    };
    const approver = await itemOf(scene.approver.userId);
    expect(approver.handoverEmployeeId).toBe(scene.handover.before);
    expect(approver.contentView?.mode).toBe('frozen');
    const initiator = await itemOf(scene.w.hr.id);
    expect(initiator.handoverEmployeeId).toBe(scene.handover.after);
    expect(initiator.contentView?.mode).toBe('live');
  });
});
