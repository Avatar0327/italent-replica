import { Alert, Button, Input, Radio, Space } from 'antd';
import { CommandStatus } from '../foundation/forms/CommandStatus.js';
import type { Answer, AnswerPage, Item, PortalClient } from './portal-client.js';
import { usePortalAnswer } from './usePortalAnswer.js';
import { portalMessages as m } from './portal-messages.js';

interface PortalAnswerProps {
  api: PortalClient;
  path: string;
  initial: AnswerPage;
  back(): void;
}
export function PortalAnswer({ api, path, initial, back }: PortalAnswerProps) {
  const {
    page,
    draft,
    notice,
    reminder,
    command,
    readonly,
    dirty,
    answers,
    setAnswer,
    read,
    run,
    leave,
    replay,
    setNotice,
    setDraft,
  } = usePortalAnswer(api, path, initial);
  return (
    <section className="survey-panel">
      <header>
        <h1>{page.questionnaire.name}</h1>
        <Button disabled={command.busy} onClick={() => void leave(back)}>
          {m.back}
        </Button>
      </header>
      <p>
        {page.object.name}
        {page.role && ` · ${page.role.name}`}
      </p>
      {page.appraiser && <p>{page.appraiser.name}</p>}
      <p>{page.questionnaire.guide}</p>
      {page.activity.status !== 'enabled' && <Alert type="warning" message={m.paused} />}
      {page.sheet.status === 'submitted' && <Alert type="success" message={m.submittedSheet} />}
      <CommandStatus
        submission={{ ...command, reload: () => command.reread(read) }}
        labels={{ answers: m.answers, suggestion: m.suggestion }}
      />
      {command.status === 'unknown' && command.state?.latest && !command.state.readError && (
        <Button onClick={() => void replay()}>{m.replay}</Button>
      )}
      <AnswerItems items={page.questionnaire.items} answers={answers} readonly={readonly} setAnswer={setAnswer} />
      <label>
        {m.suggestion}
        <Input.TextArea
          aria-label={m.suggestion}
          maxLength={5000}
          disabled={readonly}
          value={String(draft.suggestion ?? '')}
          onChange={(event) => {
            setNotice('');
            setDraft((old) => ({ ...old, suggestion: event.target.value }));
          }}
        />
      </label>
      {dirty && !readonly && <p>{m.saveFirst}</p>}
      {notice && <Alert type="success" message={notice} />}
      {reminder && <Alert type="warning" message={m.reminder} />}
      <Space className="survey-portal-actions">
        <Button disabled={readonly || !dirty} loading={command.busy} onClick={() => void run('save')}>
          {m.save}
        </Button>
        <Button
          type="primary"
          disabled={readonly || dirty || !page.sheet.revision}
          loading={command.busy}
          onClick={() => void run('submit')}
        >
          {m.submit}
        </Button>
      </Space>
    </section>
  );
}

function AnswerItems({
  items,
  answers,
  readonly,
  setAnswer,
}: {
  items: Item[];
  answers: Answer[];
  readonly: boolean;
  setAnswer(id: string, patch: Partial<Answer>): void;
}) {
  return (
    <>
      {items.map((item, index) => {
        const answer = answers.find((a) => a.itemId === item.id);
        const option = item.options.find((o) => o.id === answer?.optionId);
        return (
          <fieldset className="survey-portal-question" key={item.id} disabled={readonly}>
            <legend>
              {index + 1}. {item.text ?? item.name}
            </legend>
            <p>{item.dimension ?? item.definition}</p>
            <div role="radiogroup" aria-label={item.text ?? item.name}>
              <Radio.Group
                aria-label={item.text ?? item.name}
                value={answer?.optionId}
                disabled={readonly}
                onChange={(event) => {
                  const optionId = event.target.value as string;
                  const allowsRemark = item.allowRemark || item.options.find((o) => o.id === optionId)?.remarkRequired;
                  setAnswer(item.id, { optionId, ...(!allowsRemark ? { remark: '' } : {}) });
                }}
              >
                <Space direction="vertical">
                  {item.options.map((o) => (
                    <Radio key={o.id} value={o.id}>
                      {o.label}
                    </Radio>
                  ))}
                </Space>
              </Radio.Group>
            </div>
            {(item.allowRemark || option?.remarkRequired) && (
              <label>
                {m.remark}
                <Input.TextArea
                  aria-label={`${item.text ?? item.name} ${m.remark}`}
                  maxLength={2000}
                  disabled={readonly || !answer?.optionId}
                  value={answer?.remark ?? ''}
                  onChange={(event) => setAnswer(item.id, { remark: event.target.value })}
                />
              </label>
            )}
          </fieldset>
        );
      })}
    </>
  );
}
