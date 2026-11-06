import { Alert, Button, Space, Tabs } from 'antd';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { usePermissions } from '../foundation/Permissions.js';
import { ListPage } from '../foundation/templates.js';
import { pageQuery, type PageResult } from '../foundation/client.js';
import { PageState } from '../foundation/PageState.js';
import { useRead, RemoteSelect } from './runtime.js';
import { EV } from './ActivityFields.js';
import {
  columnsFor,
  evUi,
  FilterLabels,
  staffColumns,
  selectionColumn,
  settingsColumn,
  Unavailable,
} from './alignment.js';
import { type Row } from './model.js';
import { m } from './messages.js';

export function StaffPage({ process }: { process: boolean }) {
  const permission = usePermissions('TEvaluation.StaffEvaluationData');
  const activities = usePermissions('TEvaluation.EvaluationActivity');
  const [query, setQuery] = useSearchParams();
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const activity = query.get('activity') ?? '';
  const stage = query.get('stage') ?? '';
  const params = pageQuery(page);
  const canSelect = permission.field('activityId').visible;
  if (activity && canSelect) params.set('activityId', activity);
  const enabled = !process || (!!activity && canSelect && !stage);
  const list = useRead<PageResult<Row>>(enabled ? `${EV}/staff-evaluations?${params}` : undefined);
  const choose = (key: string, value: string) => {
    const next = new URLSearchParams(query);
    if (value) next.set(key, value);
    else next.delete(key);
    setPage({ ...page, page: 1 });
    setQuery(next);
  };
  const key = process ? (stage ? 'apply' : 'process') : 'records';
  return (
    <>
      {process && <ProcessStages {...{ canSelect, activities, activity, stage, choose }} />}
      {process && !activity && <PageState kind="empty" />}
      <ListPage
        title={process ? m.process : evUi.records}
        rowKey="id"
        page={page}
        onPageChange={setPage}
        data={list.data ?? { items: [] }}
        columns={[selectionColumn, ...columnsFor(staffColumns[key]!, permission), settingsColumn]}
        loading={list.loading}
        error={list.error}
        retry={list.reload}
        filters={
          <FilterLabels
            permission={permission}
            fields={
              process
                ? stage
                  ? [
                      ['employeeId', '人员'],
                      ['', '部门'],
                      ['applyCategoryId', '申请类别'],
                      ['applyLevelId', '申请级别'],
                    ]
                  : [
                      ['employeeId', '人员'],
                      ['', '部门'],
                      ['source', '申报来源'],
                      ['applyLevelId', '申请级别'],
                      ['currentStage', '状态'],
                    ]
                : [
                    ['activityId', '评定活动'],
                    ['employeeId', '人员'],
                    ['finalResult', '最终结果'],
                    ['currentStage', '环节'],
                    ['currentStage', '状态'],
                    ['', '高级筛选'],
                  ]
            }
          ></FilterLabels>
        }
        actions={
          <Space>
            {(process ? (stage ? ['批量新增', '批量提交申报'] : []) : ['导入', '批量删除', '批量新增', '添加人员']).map(
              (label) => (
                <Unavailable key={label} label={label} />
              ),
            )}
          </Space>
        }
      />
    </>
  );
}

function ProcessStages({
  canSelect,
  activities,
  activity,
  stage,
  choose,
}: {
  canSelect: boolean;
  activities: ReturnType<typeof usePermissions>;
  activity: string;
  stage: string;
  choose(key: string, value: string): void;
}) {
  return (
    <Space direction="vertical" className="r3b-wide">
      {canSelect && activities.snapshot.objects['TEvaluation.EvaluationActivity'] && (
        <RemoteSelect
          path={`${EV}/activities`}
          label={m.title}
          value={activity}
          onChange={(id) => choose('activity', typeof id === 'string' ? id : '')}
        />
      )}
      <div className="r3b-flow">
        {[
          ['', evUi.allPeople],
          ['apply', m.apply],
          ['result', m.result],
        ].map(([value, label]) => (
          <Button
            className="r3b-stage"
            type={stage === value ? 'primary' : 'default'}
            key={value}
            disabled={value === 'result'}
            onClick={() => choose('stage', value!)}
          >
            {label}
          </Button>
        ))}
      </div>
      {!!stage && (
        <>
          <Tabs
            items={['待申报', '审核中', '审核通过', '审核未通过'].map((label, index) => ({
              key: String(index),
              label,
              disabled: index > 0,
            }))}
          />
          <Alert type="info" message={evUi.stageUnavailable} />
        </>
      )}
    </Space>
  );
}
