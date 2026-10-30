import { ASSESSMENT_OPINIONS, ASSESSMENT_RATINGS, ASSESSMENT_STATUSES, ASSESSMENT_TYPES } from '@italent/domain';
import { Button, Descriptions, Modal, Popconfirm, Space, message } from 'antd';
import { useState } from 'react';
import { assessmentLabels } from '../approval/AssessmentFields.js';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import { slotKey } from '../foundation/forms/slot.js';
import type { Values } from '../foundation/forms/values.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useBusinessRead } from '../intern/commands.js';
import { acceptBusiness } from '../intern/model.js';
import { StaffDetail } from '../personnel/StaffDetail.js';
import { useRead } from '../part-time/useRead.js';
import { useProbationCommand } from './commands.js';
import { useDraftPointer } from './draft.js';
import { m } from './messages.js';
import {
  apiRoot,
  adjustFields,
  businesses,
  cellValue,
  employees,
  entriesFor,
  object,
  probationPath,
  type Entry,
  type ProbationView,
} from './model.js';
import { AdjustForm, RegularizeForm, type FormProps } from './ProbationForm.js';

/** B6：试用详情复用人员详情，只在顶部挂“试用信息”与按视图 / 状态 / 权限推导的入口。 */
type DetailProps = Pick<FormProps, 'row' | 'onClose' | 'refresh'> & { view: ProbationView };
export function ProbationDetail({ view, row, onClose, refresh }: DetailProps) {
  const permissions = usePermissions(object);
  const entries = entriesFor(view, row, permissions.snapshot.objects[object]);
  const [open, setOpen] = useState<Entry | 'info'>();
  const done = () => {
    setOpen(undefined);
    onClose();
  };
  const form = { row, onClose: () => setOpen(undefined), onDone: done, refresh };
  const opens = entries.filter((entry) => !['withdraw', 'revoke'].includes(entry));
  const actions = (
    <Space wrap>
      <Button onClick={() => setOpen('info')}>{m.entries.info}</Button>
      {opens.map((entry) => (
        <Button key={entry} type={entry === 'regularize' ? 'primary' : 'default'} onClick={() => setOpen(entry)}>
          {entry === 'assessment' ? m.openAssessment : m.entries[entry as keyof typeof m.entries]}
        </Button>
      ))}
      {entries
        .filter((entry): entry is 'withdraw' | 'revoke' => entry === 'withdraw' || entry === 'revoke')
        .map((entry) => (
          <ApplicationAction key={entry} row={row} action={entry} onDone={done} refresh={refresh} />
        ))}
    </Space>
  );
  return (
    <>
      <StaffDetail employeeId={row.employeeId!} onClose={onClose} actions={actions} />
      {open === 'info' && <ProbationInfo employeeId={row.employeeId!} onClose={form.onClose} />}
      {open === 'edit' && <AdjustForm {...form} />}
      {open === 'regularize' && <RegularizeForm {...form} />}
      {open === 'apply' && <RegularizeForm {...form} application />}
      {open === 'assessment' && <AssessmentDetail id={row.assessmentId!} onClose={form.onClose} />}
    </>
  );
}

const infoFields = [...adjustFields, 'actualEndDate', 'regularizationMode', 'regularizationState', 'probationResult'];
/**
 * 试用信息区：只读 GET /employees/:id/probation；试用结果按全量字典（含已停用项）显示名称，
 * 字典读不到或编码不在字典里时退回显示编码（字典维护在设置页，FE-R2c1b）。
 */
function ProbationInfo({ employeeId, onClose }: { employeeId: string; onClose(): void }) {
  const result = useRead<Values>(probationPath(employeeId));
  const dictionary = useRead<{ items: { code: string; name: string }[] }>(`${apiRoot}/probation-results`);
  const names = new Map(dictionary.data?.items.map((item) => [item.code, item.name]));
  const show = (values: Values, key: string) =>
    (key === 'probationResult' && names.get(String(values[key]))) || cellValue(values, key);
  return (
    <Modal open title={m.entries.info} footer={null} onCancel={onClose}>
      {result.data ? (
        <Descriptions
          column={1}
          size="small"
          items={infoFields.map((key) => ({ key, label: m.fields[key], children: show(result.data!, key) }))}
        />
      ) : (
        <PageState kind={result.error ? 'error' : 'loading'} error={result.error} retry={result.refresh} />
      )}
    </Modal>
  );
}

// 考核字段名与审批编辑共用一份（approval/AssessmentFields.tsx）
const labels: Record<string, string> = {
  ...assessmentLabels,
  assessmentType: m.fields.assessmentType!,
  status: m.status,
};
const assessmentKeys = ['assessmentName', 'assessmentType', 'assessmentDate', 'selfEvaluation', 'managerRating'];
assessmentKeys.push('regularizationOpinion', 'regularizationDate', 'status');
const dictionaries: Record<string, Record<string, string>> = {
  assessmentType: ASSESSMENT_TYPES,
  status: ASSESSMENT_STATUSES,
  managerRating: ASSESSMENT_RATINGS,
  regularizationOpinion: ASSESSMENT_OPINIONS,
};
/** 考核中视图只读打开考核详情（GET /probation-assessments/:id）；发起、编辑考核不在本片。 */
function AssessmentDetail({ id, onClose }: { id: string; onClose(): void }) {
  const result = useRead<Values>(`${apiRoot}/probation-assessments/${encodeURIComponent(id)}`);
  const value = (key: string) => {
    const raw = result.data?.[key];
    return dictionaries[key]?.[String(raw)] ?? cellValue(result.data ?? {}, key);
  };
  return (
    <Modal open title={m.assessmentTitle} footer={null} onCancel={onClose}>
      {result.data ? (
        <Descriptions
          column={1}
          size="small"
          items={assessmentKeys.map((key) => ({ key, label: labels[key], children: value(key) }))}
        />
      ) : (
        <PageState kind={result.error ? 'error' : 'loading'} error={result.error} retry={result.refresh} />
      )}
    </Modal>
  );
}

/** 转正审批中的申请：撤回 / 撤销按单据 revision 提交空体（PB-R15 撤销只对申请），资格由服务端判定。 */
type ActionProps = Pick<FormProps, 'row' | 'onDone' | 'refresh'> & { action: 'withdraw' | 'revoke' };
function ApplicationAction({ row, action, onDone, refresh }: ActionProps) {
  const id = row.regularizationBusinessId!;
  const read = useBusinessRead(id);
  // 单据 revision 不在列表行上：挂载时读单据，以单据 revision 作 If-Match；恢复槽仍是员工
  const business = useRead<Values>(slotKey(businesses, id));
  const revision = business.data?.id === id ? Number(business.data.revision) : undefined;
  const reread = async () => ({ ...(await read()), id: row.employeeId! });
  const target = { id: row.employeeId!, revision, baseline: {}, read: reread };
  const cmd = useProbationCommand(employees, target, `${action}/${id}`, () => refresh());
  const pointer = useDraftPointer(row.employeeId!);
  const run = async () => {
    try {
      const done = await cmd.submit({}, [], {
        path: `${slotKey(businesses, id)}/${action}`,
        body: () => ({}),
        accept: (raw, sent) => {
          const receipt = acceptBusiness(raw, { employeeId: row.employeeId!, kind: 'regularization', sent, id });
          return { path: slotKey(businesses, id), id, revision: Number(receipt.revision) };
        },
      });
      if (!done) return;
      // 撤回后单据回到草稿：再点“转正申请”沿用这张单同单重提（DEC-103）；撤销是终态，不再找回
      if (action === 'withdraw') pointer.put(id);
      else pointer.clear(id);
      void message.success(m.success[action]);
      onDone();
    } catch {
      // 拒绝 / 冲突 / 结果未知由内核状态条显示
    }
  };
  return (
    <Space direction="vertical">
      <Popconfirm
        title={action === 'withdraw' ? m.withdrawConfirm : m.revokeConfirm}
        okText={m.confirm}
        cancelText={m.cancel}
        disabled={cmd.disabled}
        onConfirm={() => void run()}
      >
        <Button danger={action === 'revoke'} loading={cmd.form.busy} disabled={cmd.disabled}>
          {m.entries[action]}
        </Button>
      </Popconfirm>
      <CommandStatus submission={cmd.form} />
    </Space>
  );
}
