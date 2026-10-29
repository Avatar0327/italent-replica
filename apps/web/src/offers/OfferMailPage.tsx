import { Empty } from 'antd';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { value } from '../contracts/model.js';
import { ApiError } from '../foundation/client.js';
import { PageState } from '../foundation/PageState.js';
import { useSession } from '../foundation/Session.js';
import { readOfferMail, type OfferMail } from './mail-api.js';
import { mailText as m } from './messages.js';
import './offer-mail.css';

export function OfferMailPage() {
  const { id = '' } = useParams();
  const { tenantId, identityKey } = useSession();
  return <MailReader key={`${tenantId}/${identityKey}/${id}`} tenantId={tenantId} id={id} />;
}
function MailReader({ tenantId, id }: { tenantId: string; id: string }) {
  const [mail, setMail] = useState<OfferMail | null>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    void readOfferMail(tenantId, id, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setMail(result);
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setError(cause);
      },
    );
    return () => controller.abort();
  }, [tenantId, id]);
  if (error) {
    const kind =
      error instanceof ApiError && ['login', 'forbidden', 'not-found'].includes(error.kind)
        ? (error.kind as 'login' | 'forbidden' | 'not-found')
        : 'error';
    return <PageState kind={kind} />;
  }
  if (mail === undefined) return <PageState kind="loading" />;
  if (mail === null) return <Empty description={m.notSent} />;
  return (
    <article className="offer-mail-page">
      <h1>{mail.name}</h1>
      <section className="offer-mail-card">
        <h2>{m.offer}</h2>
        <section>
          <h3>{m.basic}</h3>
          <dl className="offer-mail-fields">
            <Field label={m.name} content={mail.name} />
            <Field label={m.recipient} content={mail.recipient} />
          </dl>
        </section>
        <section>
          <h3>{m.notice}</h3>
          <div className="offer-mail-notice">
            <dl className="offer-mail-subject">
              <Field label={m.subject} content={mail.subject} />
            </dl>
            <div className="offer-mail-body">
              <h4>{mail.notice.title}</h4>
              {mail.notice.paragraphs.map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </div>
          </div>
        </section>
        <section>
          <h3>{m.delivery}</h3>
          <dl className="offer-mail-fields">
            <Field label={m.attachments} content={mail.attachments} />
            <Field label={m.cc} content={mail.cc} />
            <Field label={m.bcc} content={mail.bcc} />
          </dl>
        </section>
      </section>
    </article>
  );
}
function Field({ label, content }: { label: string; content: string | string[] | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value(content, '')}</dd>
    </div>
  );
}
