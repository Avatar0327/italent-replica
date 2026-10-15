import { App, Button, DatePicker, Descriptions, Form, Input, Modal, Select, Space, Tabs, Alert } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import type { OfferExample, OfferState } from '../demo-stubs/offers.js';
import { DetailPage } from '../foundation/templates.js';
import { detailSections, invalidReasons, m, reasons, states } from './messages.js';
import { displayValue, targets, type DemoAction } from './model.js';

export function OfferDetail({ row, close }: { row: OfferExample; close(): void }) {
  return (
    <DetailPage
      open
      onClose={close}
      title={row.name}
      summary={<Tabs items={[{ key: 'offer', label: 'Offer' }]} />}
      sections={detailSections.map((section) => ({
        key: section.title,
        title: section.title,
        children: (
          <Descriptions
            column={3}
            size="small"
            colon={false}
            items={section.fields.map((label) => ({
              key: label,
              label,
              children: displayValue(row, label),
            }))}
          />
        ),
      }))}
    />
  );
}

/** DEC-538：只复用表单外观和校验，不创建命令、恢复槽或可变业务副本。 */
export function OfferDialog({ row, action, close }: { row: OfferExample; action: DemoAction; close(): void }) {
  const [form] = Form.useForm();
  const [capacity, setCapacity] = useState(false);
  const { message } = App.useApp();
  const state = Form.useWatch<OfferState>('state', form);
  const invalidating = action === 'invalidate';
  const finish = () => {
    close();
    void message.info(m.unchanged);
  };
  const validate = async () => {
    try {
      await form.validateFields();
    } catch {
      return;
    }
    if (state === 'accepted' && row.overCapacity && !invalidating) setCapacity(true);
    else finish();
  };
  return (
    <>
      <Modal
        open
        width={750}
        centered
        title={invalidating ? m.invalidate : m.transfer}
        onCancel={close}
        footer={
          <Space>
            <Button onClick={close}>{m.cancel}</Button>
            <Button type="primary" onClick={() => void validate()}>
              {m.confirm}
            </Button>
          </Space>
        }
      >
        {!invalidating && ['pending', 'accepted'].includes(row.state) && (
          <Alert type="info" message={m.unknownTransfer} />
        )}
        {invalidating && row.state === 'pending' && <Alert type="info" message={m.unknownInvalidation} />}
        <Form
          form={form}
          name="offer-demo"
          layout={invalidating ? 'vertical' : 'horizontal'}
          labelCol={invalidating ? undefined : { span: 5 }}
          wrapperCol={invalidating ? undefined : { span: 19 }}
          initialValues={{
            rejectDate: row.refusal ? dayjs(row.refusal.date) : undefined,
            reason: row.refusal?.reason,
            remark: row.refusal?.remark,
          }}
        >
          <OfferFields invalidating={invalidating} state={state} row={row} />
        </Form>
      </Modal>
      <Modal
        open={capacity}
        title={m.capacity}
        centered
        onCancel={() => setCapacity(false)}
        onOk={finish}
        okText={m.confirm}
        cancelText={m.cancel}
      />
    </>
  );
}

function OfferFields({ invalidating, state, row }: { invalidating: boolean; state: OfferState; row: OfferExample }) {
  const required = [{ required: true, message: m.required }];
  return (
    <>
      {invalidating ? (
        <>
          <Form.Item name="invalidReason" label={m.invalidReason} rules={required}>
            <Select options={invalidReasons.map((value) => ({ value, label: value }))} />
          </Form.Item>
          <Form.Item name="invalidRemark" label={m.invalidRemark}>
            <Input.TextArea rows={3} maxLength={32766} showCount />
          </Form.Item>
        </>
      ) : (
        <>
          <Form.Item name="state" label={m.state} rules={required}>
            <Select options={targets[row.state].map((value) => ({ value, label: states[value] }))} />
          </Form.Item>
          {state === 'accepted' && (
            <Form.Item name="acceptDate" label={m.acceptDate} rules={required}>
              <DatePicker format="YYYY-MM-DD" className="offer-demo-date" />
            </Form.Item>
          )}
          {state === 'rejected' && (
            <>
              <Form.Item name="rejectDate" label={m.rejectDate} rules={required}>
                <DatePicker format="YYYY-MM-DD" className="offer-demo-date" />
              </Form.Item>
              <Form.Item name="reason" label={m.reason} rules={required}>
                <Select options={reasons.map((value) => ({ value, label: value }))} />
              </Form.Item>
              <Form.Item name="remark" label={m.remark}>
                <Input.TextArea rows={3} maxLength={32766} showCount />
              </Form.Item>
            </>
          )}
        </>
      )}
    </>
  );
}
