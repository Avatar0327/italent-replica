import { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Alert, Button, ConfigProvider, Form, Input, Space, Spin } from 'antd';
import zhCN from 'antd/es/locale/zh_CN.js';
import { ApiError } from '../foundation/client.js';
import { SessionProvider } from '../foundation/Session.js';
import { ConflictCommands } from '../foundation/forms/ConflictCommands.js';
import { theme } from '../foundation/theme.js';
import { PortalAnswer } from './PortalAnswer.js';
import {
  createPortalClient,
  portalTenant,
  readSession,
  storeSession,
  validSession,
  type AnswerPage,
  type PortalClient,
  type PortalHome,
  type PortalSession,
} from './portal-client.js';
import { portalMessages as m } from './portal-messages.js';
import './pages.css';

export function PortalApp() {
  const tenantId = portalTenant(window.location.pathname);
  return (
    <ConfigProvider locale={zhCN} theme={theme}>
      <AntApp>
        <main className="survey-portal">
          {tenantId ? (
            <SessionProvider
              session={{
                tenantId,
                identityKey: 'survey360-portal',
                tenantName: '',
                timezone: '',
                displayName: '',
                source: 'server',
              }}
            >
              <ConflictCommands>
                <Portal tenantId={tenantId} />
              </ConflictCommands>
            </SessionProvider>
          ) : (
            <Alert type="error" message={m.invalidLink} />
          )}
        </main>
      </AntApp>
    </ConfigProvider>
  );
}
function Portal({ tenantId }: { tenantId: string }) {
  const [session, setSession] = useState(() => readSession(tenantId));
  const [error, setError] = useState('');
  const current = useRef(session);
  current.current = session;
  const api = useMemo(
    () =>
      createPortalClient(tenantId, session?.session, () => {
        if (current.current?.session !== session?.session) return;
        storeSession(tenantId);
        setSession(undefined);
        setError(m.expired);
      }),
    [tenantId, session],
  );
  const loggedIn = (value: PortalSession) => {
    storeSession(tenantId, value);
    setError('');
    setSession(value);
  };
  const logout = async () => {
    try {
      await api.request('/logout', 'POST', {});
      storeSession(tenantId);
      setSession(undefined);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.unknown);
    }
  };
  return (
    <>
      <header className="survey-toolbar">
        <h1>{m.title}</h1>
        {session && <Button onClick={() => void logout()}>{m.logout}</Button>}
      </header>
      {error && <Alert type="error" message={error} />}
      {session ? <Tasks key={session.session} api={api} /> : <Login api={api} loggedIn={loggedIn} />}
    </>
  );
}
function Login({ api, loggedIn }: { api: PortalClient; loggedIn(value: PortalSession): void }) {
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState('');
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (retryAt <= now) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(1000, retryAt - now));
    return () => window.clearTimeout(timer);
  }, [retryAt, now]);
  const submit = async (values: { serial: string; password: string }) => {
    if (sending.current || Date.now() < retryAt) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      // F-076 §4.8：认证不进入命令台账；凭据只在此表单和本次请求中存在。
      const value = await api.request<PortalSession>('/login', 'POST', values);
      if (!validSession(value)) throw new Error(m.unknown);
      loggedIn(value);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status > 0 ? cause.message : m.loginUnknown);
      if (cause instanceof ApiError && cause.status === 429) {
        setNow(Date.now());
        setRetryAt(Date.now() + Math.max(1, cause.retryAfter ?? 1) * 1000);
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="survey-panel survey-portal-login">
      {error && <Alert type="error" message={error} />}
      <Form layout="vertical" onFinish={(values: { serial: string; password: string }) => void submit(values)}>
        <Form.Item name="serial" label={m.serial} rules={[{ required: true, message: m.required }]}>
          <Input name="serial" maxLength={64} autoComplete="off" disabled={busy} />
        </Form.Item>
        <Form.Item name="password" label={m.password} rules={[{ required: true, message: m.required }]}>
          <Input.Password name="password" maxLength={64} autoComplete="off" disabled={busy} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={busy} disabled={now < retryAt}>
          {m.login}
        </Button>
      </Form>
    </section>
  );
}
function Tasks({ api }: { api: PortalClient }) {
  const [home, setHome] = useState<PortalHome>();
  const [selected, setSelected] = useState<{ path: string; page: AnswerPage }>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api
      .request<PortalHome>()
      .then((value) => {
        if (active) setHome(value);
      })
      .catch((cause: unknown) => {
        if (active) {
          setHome(undefined);
          setError(cause instanceof Error ? cause.message : m.failed);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, version]);
  const open = async (relationId: string, questionnaireId: string) => {
    const path = `/tasks/${encodeURIComponent(relationId)}/questionnaires/${encodeURIComponent(questionnaireId)}`;
    setLoading(true);
    setError('');
    try {
      setSelected({ path, page: await api.request<AnswerPage>(path) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.failed);
    } finally {
      setLoading(false);
    }
  };
  if (selected)
    return (
      <PortalAnswer
        key={selected.path}
        api={api}
        path={selected.path}
        initial={selected.page}
        back={() => {
          setSelected(undefined);
          setVersion((v) => v + 1);
        }}
      />
    );
  return <TaskList home={home} error={error} loading={loading} open={open} reload={() => setVersion((v) => v + 1)} />;
}
function taskLabel(status: string) {
  if (status === 'submitted') return { status: m.done, action: m.view };
  if (status === 'draft') return { status: m.progress, action: m.continue };
  return { status: m.pending, action: m.start };
}
function TaskList({
  home,
  error,
  loading,
  open,
  reload,
}: {
  home: PortalHome | undefined;
  error: string;
  loading: boolean;
  open(relationId: string, questionnaireId: string): Promise<void>;
  reload(): void;
}) {
  const sheets = home?.tasks.flatMap((task) => task.questionnaires) ?? [];
  const completed = sheets.length > 0 && sheets.every((sheet) => sheet.status === 'submitted');
  return (
    <section className="survey-panel">
      {loading && <Spin aria-label={m.loading} />}
      {error && <Alert type="error" message={error} action={<Button onClick={reload}>{m.retry}</Button>} />}
      {home && (
        <>
          <h2>{home.activity.name}</h2>
          {home.appraiser && <p>{home.appraiser.name}</p>}
          <p>{home.activity.welcome}</p>
          {completed && <Alert type="success" message={m.completed} />}
          {!completed && home.activity.status !== 'enabled' && <Alert type="warning" message={m.paused} />}
          {!completed && home.activity.status === 'enabled' && <h3>{sheets.length ? m.tasks : m.empty}</h3>}
          {home.tasks.map((task) => (
            <section key={task.relationId} className="survey-portal-task">
              <h3>
                {task.object.name}
                {task.role && ` · ${task.role.name}`}
              </h3>
              {task.questionnaires.map((q) => (
                <div className="survey-toolbar" key={q.id}>
                  <span>{q.name}</span>
                  <Space>
                    <span>{taskLabel(q.status).status}</span>
                    <Button
                      disabled={loading || (home.activity.status !== 'enabled' && q.status !== 'submitted')}
                      onClick={() => void open(task.relationId, q.id)}
                    >
                      {taskLabel(q.status).action}
                    </Button>
                  </Space>
                </div>
              ))}
            </section>
          ))}
        </>
      )}
    </section>
  );
}
