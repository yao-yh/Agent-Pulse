import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

type Tab = 'events' | 'tasks' | 'inventory' | 'plans' | 'proxy' | 'notifications' | 'doctor';

export function App() {
  const [tab, setTab] = useState<Tab>('events');
  const tabs: Array<[Tab, string]> = [
    ['events', 'Events'],
    ['tasks', 'Tasks'],
    ['inventory', 'Inventory'],
    ['plans', 'Plans'],
    ['proxy', 'Proxy'],
    ['notifications', 'Notifications'],
    ['doctor', 'Doctor']
  ];

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">Local-first AI agent event center</p>
          <h1>AgentPulse</h1>
        </div>
        <HealthBadge />
      </header>
      <nav>
        {tabs.map(([key, label]) => (
          <button className={tab === key ? 'active' : ''} key={key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>
      <section>
        {tab === 'events' && <Events />}
        {tab === 'tasks' && <Tasks />}
        {tab === 'inventory' && <Inventory />}
        {tab === 'plans' && <Plans />}
        {tab === 'proxy' && <ProxyRequests />}
        {tab === 'notifications' && <Notifications />}
        {tab === 'doctor' && <Doctor />}
      </section>
    </main>
  );
}

function HealthBadge() {
  const { data, isError } = useApi('/api/health');
  return <span className={isError ? 'badge bad' : 'badge'}>{isError ? 'offline' : data ? 'online' : 'checking'}</span>;
}

function Events() {
  const { data } = useApi('/api/events');
  const rows = Array.isArray(data) ? data : [];
  return <Card title="Event Stream" action={<CurlHint />}>{rows.length ? <JsonRows rows={rows} /> : <Empty text="No events yet. Send a hook event to begin." />}</Card>;
}

function Tasks() {
  const { data: tasks } = useApi('/api/tasks');
  const { data: sessions } = useApi('/api/sessions');
  return (
    <div className="grid">
      <Card title="Tasks">{Array.isArray(tasks) && tasks.length ? <JsonRows rows={tasks} /> : <Empty text="No tasks yet." />}</Card>
      <Card title="Sessions">{Array.isArray(sessions) && sessions.length ? <JsonRows rows={sessions} /> : <Empty text="No sessions yet." />}</Card>
    </div>
  );
}

function Inventory() {
  const queryClient = useQueryClient();
  const { data } = useApi('/api/inventory');
  const scan = useMutation({
    mutationFn: () => fetch('/api/inventory/scan', { method: 'POST' }).then((response) => response.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/inventory'] })
  });
  const snapshot = (data || {}) as any;
  return (
    <div className="stack">
      <button onClick={() => scan.mutate()}>{scan.isPending ? 'Scanning…' : 'Scan Inventory'}</button>
      <div className="grid three">
        <Card title={`Sources (${snapshot.sources?.length || 0})`}><JsonRows rows={snapshot.sources || []} /></Card>
        <Card title={`Skills (${snapshot.skills?.length || 0})`}><JsonRows rows={snapshot.skills || []} /></Card>
        <Card title={`MCP Servers (${snapshot.mcpServers?.length || 0})`}><JsonRows rows={snapshot.mcpServers || []} /></Card>
      </div>
    </div>
  );
}

function Plans() {
  const queryClient = useQueryClient();
  const { data } = useApi('/api/install/plans');
  const createPlan = useMutation({
    mutationFn: () => fetch('/api/install/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'workspace' }) }).then((response) => response.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/install/plans'] })
  });
  return (
    <Card title="Install Plans" action={<button onClick={() => createPlan.mutate()}>Create Workspace Plan</button>}>
      {Array.isArray(data) && data.length ? <JsonRows rows={data} /> : <Empty text="No install plans yet." />}
    </Card>
  );
}

function ProxyRequests() {
  const { data } = useApi('/api/proxy/requests');
  return <Card title="Proxy Requests">{Array.isArray(data) && data.length ? <JsonRows rows={data} /> : <Empty text="No proxy traffic captured yet." />}</Card>;
}

function Notifications() {
  const test = useMutation({
    mutationFn: (channel: 'webhook' | 'windows') =>
      fetch('/api/notifications/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel }) }).then((response) => response.json())
  });
  return (
    <Card title="Notification Test">
      <div className="row">
        <button onClick={() => test.mutate('webhook')}>Test Webhook</button>
        <button onClick={() => test.mutate('windows')}>Test Windows</button>
      </div>
      {test.data ? <pre>{JSON.stringify(test.data, null, 2)}</pre> : <Empty text="Choose a channel to test." />}
    </Card>
  );
}

function Doctor() {
  const { data: health } = useApi('/api/health');
  const { data: scan } = useApi('/api/scan');
  const summary = useMemo(() => ({ health, scan }), [health, scan]);
  return <Card title="Doctor"><pre>{JSON.stringify(summary, null, 2)}</pre></Card>;
}

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <article className="card">
      <div className="cardHeader">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </article>
  );
}

function JsonRows({ rows }: { rows: unknown[] }) {
  if (!rows.length) return <Empty text="Nothing to show." />;
  return <pre>{JSON.stringify(rows, null, 2)}</pre>;
}

function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}

function CurlHint() {
  return <code>curl -X POST /ingest/hook/codex/session.start</code>;
}

function useApi(path: string) {
  return useQuery({
    queryKey: [path],
    queryFn: async () => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`${response.status}`);
      return response.json();
    },
    refetchInterval: path.includes('events') || path.includes('tasks') ? 3000 : false
  });
}

