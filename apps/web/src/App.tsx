import { useMemo, useState } from 'react';
import { Alert, App as AntApp, Badge, Button, Card, Descriptions, Drawer, Form, Input, Layout, Menu, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

type Tab = 'agents' | 'sessions' | 'events' | 'tasks' | 'inventory' | 'plans' | 'proxy' | 'notifications' | 'doctor';
type Scope = 'workspace' | 'user' | 'global';

interface AgentRow {
  integration: string;
  detected: boolean;
  routeState?: {
    routed: boolean;
    configPath?: string;
    currentBaseUrl?: string;
    confidence: 'low' | 'medium' | 'high';
    warnings: string[];
  };
  configSources: Array<{ path: string; exists: boolean; scope: Scope; kind: string }>;
  capabilities: { configInstall: boolean; rollback: boolean };
  warnings: string[];
  latestPlan?: { id: string; applied: boolean; appliedAt?: string; scope: Scope; summary?: string };
  scope: Scope;
  targetConfigPath?: string;
  originalUpstream?: string;
  proxyBaseUrl?: string;
  willCreateConfig: boolean;
  backupRequired: boolean;
  canReplace: boolean;
  canRollback: boolean;
}

interface ProxyRequestRow {
  id: string;
  provider: string;
  proxyKey?: string;
  apiProtocol?: string;
  sessionId?: string;
  method: string;
  path: string;
  upstreamUrl: string;
  statusCode?: number;
  durationMs?: number;
  requestSummary?: Record<string, unknown>;
  responseSummary?: Record<string, unknown>;
  error?: string;
  createdAt: string;
}

interface ProxySessionRow {
  id: string;
  provider: string;
  requestCount: number;
  errorCount: number;
  firstRequestAt: string;
  latestRequestAt: string;
  latestStatusCode?: number;
  latestPath?: string;
}

interface PromptPartRow {
  kind?: string;
  role?: string;
  index?: number;
  name?: string;
  id?: string;
  text?: string;
  input?: unknown;
}

const defaultProxyBaseUrl = 'http://127.0.0.1:8080';

export function App() {
  const [tab, setTab] = useState<Tab>('agents');
  const tabs: Array<[Tab, string]> = [
    ['agents', 'Agents'],
    ['sessions', 'Sessions'],
    ['events', 'Events'],
    ['tasks', 'Tasks'],
    ['inventory', 'Inventory'],
    ['plans', 'Plans'],
    ['proxy', 'Proxy'],
    ['notifications', 'Notifications'],
    ['doctor', 'Doctor']
  ];

  return (
    <AntApp>
      <Layout className="appShell">
        <Layout.Header className="appHeader">
          <div>
            <Typography.Text type="secondary">Local-first AI agent event center</Typography.Text>
            <Typography.Title level={1}>AgentPulse</Typography.Title>
          </div>
          <Space size="middle" wrap>
            <Button href="/docs/" target="_blank">
              使用文档
            </Button>
            <HealthBadge />
          </Space>
        </Layout.Header>
        <Layout.Content className="appContent">
          <Menu mode="horizontal" selectedKeys={[tab]} items={tabs.map(([key, label]) => ({ key, label }))} onClick={({ key }) => setTab(key as Tab)} />
          <section className="pageContent">
            {tab === 'agents' && <Agents />}
            {tab === 'sessions' && <Sessions />}
            {tab === 'events' && <Events />}
            {tab === 'tasks' && <Tasks />}
            {tab === 'inventory' && <Inventory />}
            {tab === 'plans' && <Plans />}
            {tab === 'proxy' && <ProxyRequests />}
            {tab === 'notifications' && <Notifications />}
            {tab === 'doctor' && <Doctor />}
          </section>
        </Layout.Content>
      </Layout>
    </AntApp>
  );
}

function HealthBadge() {
  const { data, isError } = useApi('/api/health');
  return <Badge status={isError ? 'error' : data ? 'success' : 'processing'} text={isError ? 'offline' : data ? 'online' : 'checking'} />;
}

function Agents() {
  const queryClient = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const [proxyBaseUrl, setProxyBaseUrl] = useState(defaultProxyBaseUrl);
  const [rowMessage, setRowMessage] = useState<Record<string, string>>({});
  const { data, isFetching } = useQuery({
    queryKey: ['/api/agents/scan', proxyBaseUrl],
    queryFn: () => postJson<AgentRow[]>('/api/agents/scan', { scope: 'user', proxyBaseUrl }),
    staleTime: 0
  });
  const rows = Array.isArray(data) ? data : [];
  const scan = useMutation({
    mutationFn: () => postJson<AgentRow[]>('/api/agents/scan', { scope: 'user', proxyBaseUrl }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['/api/agents/scan'] });
      message.success('扫描完成');
    }
  });
  const replace = useMutation({
    mutationFn: (row: AgentRow) => postJson(`/api/agents/${row.integration}/replace`, { scope: 'user', proxyBaseUrl, yes: true }),
    onSuccess: async (result: any, row) => {
      setRowMessage((current) => ({ ...current, [row.integration]: result.ok ? '替换完成，配置已验证。' : `替换失败：${result.error || result.result?.warnings?.join('；') || '请查看详情'}` }));
      await refreshAgentViews(queryClient);
    }
  });
  const rollback = useMutation({
    mutationFn: (integration: string) => postJson(`/api/agents/${integration}/rollback`, {}),
    onSuccess: async (result: any, integration) => {
      setRowMessage((current) => ({ ...current, [integration]: result.ok ? '回滚完成。' : `回滚失败：${result.error || result.result?.warnings?.join('；') || '没有可用备份'}` }));
      await refreshAgentViews(queryClient);
    }
  });
  const columns: ColumnsType<AgentRow> = [
    {
      title: 'Agent',
      dataIndex: 'integration',
      key: 'integration',
      width: 150,
      render: (value) => <Typography.Text strong>{value}</Typography.Text>
    },
    {
      title: '检测状态',
      key: 'detected',
      width: 110,
      render: (_, row) => <Tag color={row.detected ? 'green' : 'default'}>{row.detected ? '已发现' : '未发现'}</Tag>
    },
    {
      title: '路由状态',
      key: 'routed',
      width: 120,
      render: (_, row) => <Tag color={row.routeState?.routed ? 'blue' : row.routeState ? 'orange' : 'default'}>{row.routeState?.routed ? '已代理' : row.routeState ? '未代理' : '未识别'}</Tag>
    },
    {
      title: '用户级目标文件',
      key: 'configPath',
      ellipsis: true,
      render: (_, row) => row.targetConfigPath || row.routeState?.configPath || '-'
    },
    {
      title: '原始上游',
      key: 'currentBaseUrl',
      ellipsis: true,
      render: (_, row) => row.originalUpstream || row.routeState?.currentBaseUrl || '-'
    },
    {
      title: '提示',
      key: 'warnings',
      render: (_, row) => {
        const text = rowMessage[row.integration] || row.warnings?.join('；') || row.routeState?.warnings?.join('；') || '-';
        return <Typography.Text type={rowMessage[row.integration] ? 'success' : row.warnings?.length ? 'warning' : 'secondary'}>{text}</Typography.Text>;
      }
    },
    {
      title: '操作',
      key: 'actions',
      width: 190,
      render: (_, row) => (
        <Space>
          <Button type="primary" disabled={!row.canReplace} loading={replace.isPending && replace.variables?.integration === row.integration} onClick={() => confirmReplace(row)}>
            替换
          </Button>
          <Button disabled={!row.canRollback} loading={rollback.isPending && rollback.variables === row.integration} onClick={() => rollback.mutate(row.integration)}>
            {row.canRollback ? '回滚' : '无备份'}
          </Button>
        </Space>
      )
    }
  ];

  const confirmReplace = (row: AgentRow) => {
    modal.confirm({
      title: `确认替换 ${row.integration} 用户级配置？`,
      okText: '确认替换',
      cancelText: '取消',
      content: (
        <div className="confirmBody">
          <Descriptions size="small" column={1} bordered={false}>
            <Descriptions.Item label="目标配置文件">{row.targetConfigPath || '-'}</Descriptions.Item>
            <Descriptions.Item label="原始上游">{row.originalUpstream || '未配置，按官方上游处理'}</Descriptions.Item>
            <Descriptions.Item label="新代理地址">{row.proxyBaseUrl || `${proxyBaseUrl.replace(/\/+$/, '')}/proxy/${row.integration}`}</Descriptions.Item>
            <Descriptions.Item label="文件状态">{row.willCreateConfig ? '将创建配置文件' : '将修改现有配置文件'}</Descriptions.Item>
          </Descriptions>
          <Typography.Paragraph type="secondary" className="confirmNote">
            操作前会自动备份，可在该 Agent 行点击“回滚”恢复原配置；回滚也会删除对应代理映射。
          </Typography.Paragraph>
        </div>
      ),
      onOk: () => replace.mutateAsync(row)
    });
  };

  return (
    <Card
      title="Agent 代理配置"
      extra={
        <Button type="primary" loading={scan.isPending || isFetching} onClick={() => scan.mutate()}>
          扫描
        </Button>
      }
    >
      <Form layout="inline" className="agentToolbar">
        <Form.Item label="配置范围">
          <Typography.Text>用户级配置</Typography.Text>
        </Form.Item>
        <Form.Item label="代理地址">
          <Input value={proxyBaseUrl} onChange={(event) => setProxyBaseUrl(event.target.value)} className="proxyInput" />
        </Form.Item>
      </Form>
      <Alert type="info" showIcon message="当前页面直接操作当前用户目录下的真实 Agent 配置文件；点击替换前会展示确认弹窗，并在写入前自动备份。" className="agentAlert" />
      <Table rowKey="integration" columns={columns} dataSource={rows} loading={scan.isPending || isFetching} pagination={false} scroll={{ x: 1100 }} />
    </Card>
  );
}

function Events() {
  const { data } = useApi('/api/events');
  const rows = Array.isArray(data) ? data : [];
  return <Card title="Event Stream" extra={<CurlHint />}>{rows.length ? <JsonRows rows={rows} /> : <Empty text="No events yet. Send a hook event to begin." />}</Card>;
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
      <Button type="primary" onClick={() => scan.mutate()} loading={scan.isPending}>Scan Inventory</Button>
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
    <Card title="Install Plans" extra={<Button type="primary" onClick={() => createPlan.mutate()} loading={createPlan.isPending}>Create Workspace Plan</Button>}>
      {Array.isArray(data) && data.length ? <JsonRows rows={data} /> : <Empty text="No install plans yet." />}
    </Card>
  );
}

function Sessions() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const { data: sessionData } = useApi('/api/proxy/sessions');
  const sessions = Array.isArray(sessionData) ? sessionData as ProxySessionRow[] : [];
  const activeSessionId = selectedSessionId || sessions[0]?.id || null;
  const { data: requestData, isFetching } = useQuery({
    queryKey: ['/api/proxy/requests/session', activeSessionId],
    queryFn: () => fetchJson<ProxyRequestRow[]>(`/api/proxy/requests?sessionId=${encodeURIComponent(activeSessionId || '')}`),
    enabled: Boolean(activeSessionId)
  });
  const { data: detail, isFetching: detailLoading } = useQuery({
    queryKey: ['/api/proxy/requests/detail', selectedRequestId],
    queryFn: () => fetchJson<ProxyRequestRow>(`/api/proxy/requests/${encodeURIComponent(selectedRequestId || '')}`),
    enabled: Boolean(selectedRequestId)
  });
  const requests = Array.isArray(requestData) ? requestData : [];
  const sessionColumns: ColumnsType<ProxySessionRow> = [
    {
      title: 'Session',
      dataIndex: 'id',
      key: 'id',
      ellipsis: true,
      render: (value, row) => <Button type={row.id === activeSessionId ? 'primary' : 'default'} onClick={() => setSelectedSessionId(row.id)}>{value}</Button>
    },
    { title: 'Provider', dataIndex: 'provider', key: 'provider', width: 130 },
    { title: 'Requests', dataIndex: 'requestCount', key: 'requestCount', width: 110 },
    { title: 'Errors', dataIndex: 'errorCount', key: 'errorCount', width: 100, render: (value) => <Tag color={value ? 'red' : 'green'}>{value}</Tag> },
    { title: 'Latest Status', key: 'latestStatusCode', width: 130, render: (_, row) => row.latestStatusCode ?? '-' },
    { title: 'Latest Path', dataIndex: 'latestPath', key: 'latestPath', ellipsis: true },
    { title: 'Latest Request', dataIndex: 'latestRequestAt', key: 'latestRequestAt', width: 220 }
  ];
  const requestColumns: ColumnsType<ProxyRequestRow> = [
    { title: 'Method', dataIndex: 'method', key: 'method', width: 100 },
    { title: 'Path', dataIndex: 'path', key: 'path', ellipsis: true },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_, row) => {
        if (!row.statusCode) return <Tag color={row.error ? 'red' : 'default'}>-</Tag>;
        const color = row.statusCode >= 500 ? 'red' : row.statusCode >= 400 ? 'orange' : 'green';
        return <Tag color={color}>{row.statusCode}</Tag>;
      }
    },
    { title: 'Duration', key: 'duration', width: 120, render: (_, row) => row.durationMs == null ? '-' : `${row.durationMs} ms` },
    { title: 'Created', dataIndex: 'createdAt', key: 'createdAt', width: 220 },
    { title: 'Action', key: 'action', width: 110, render: (_, row) => <Button onClick={() => setSelectedRequestId(row.id)}>Details</Button> }
  ];
  return (
    <div className="stack">
      <Card title="Sessions">
        <Table rowKey="id" columns={sessionColumns} dataSource={sessions} pagination={false} scroll={{ x: 1100 }} rowClassName={(row) => row.id === activeSessionId ? 'selectedRow' : ''} />
        {!sessions.length && <div className="tableEmpty"><Empty text="No captured sessions yet." /></div>}
      </Card>
      <Card title={activeSessionId ? `Requests in ${activeSessionId}` : 'Requests'}>
        <Table rowKey="id" columns={requestColumns} dataSource={requests} loading={isFetching} pagination={false} scroll={{ x: 900 }} />
        {!activeSessionId && <div className="tableEmpty"><Empty text="Select a session to inspect requests." /></div>}
        {activeSessionId && !requests.length && !isFetching && <div className="tableEmpty"><Empty text="No requests in this session." /></div>}
      </Card>
      <Drawer title="Proxy Request / Response Details" open={Boolean(selectedRequestId)} onClose={() => setSelectedRequestId(null)} width={720}>
        {detailLoading && <Empty text="Loading request details..." />}
        {detail && (
          <div className="proxyDetailStack">
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="ID">{detail.id}</Descriptions.Item>
              <Descriptions.Item label="Provider">{detail.provider}</Descriptions.Item>
              <Descriptions.Item label="Session">{detail.sessionId || '-'}</Descriptions.Item>
              <Descriptions.Item label="Method">{detail.method}</Descriptions.Item>
              <Descriptions.Item label="Path">{detail.path}</Descriptions.Item>
              <Descriptions.Item label="Upstream URL">{detail.upstreamUrl}</Descriptions.Item>
              <Descriptions.Item label="Status">{detail.statusCode ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="Duration">{detail.durationMs == null ? '-' : `${detail.durationMs} ms`}</Descriptions.Item>
              <Descriptions.Item label="Created">{detail.createdAt}</Descriptions.Item>
              <Descriptions.Item label="Error">{detail.error || '-'}</Descriptions.Item>
            </Descriptions>
            <section>
              <Typography.Title level={5}>Prompt Parts</Typography.Title>
              <PromptParts value={capturedField(detail.requestSummary, 'promptParts')} />
            </section>
            <section>
              <Typography.Title level={5}>Request Body</Typography.Title>
              <JsonBlock value={capturedField(detail.requestSummary, 'body')} />
            </section>
            <section>
              <Typography.Title level={5}>Response Content</Typography.Title>
              <JsonBlock value={capturedField(detail.responseSummary, 'body')} />
            </section>
          </div>
        )}
      </Drawer>
    </div>
  );
}

function ProxyRequests() {
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const { data } = useApi('/api/proxy/requests');
  const rows = Array.isArray(data) ? data as ProxyRequestRow[] : [];
  const { data: detail, isFetching: detailLoading } = useQuery({
    queryKey: ['/api/proxy/requests/detail', selectedRequestId],
    queryFn: () => fetchJson<ProxyRequestRow>(`/api/proxy/requests/${encodeURIComponent(selectedRequestId || '')}`),
    enabled: Boolean(selectedRequestId)
  });
  const columns: ColumnsType<ProxyRequestRow> = [
    { title: 'Provider', dataIndex: 'provider', key: 'provider', width: 120 },
    { title: 'Proxy Key', key: 'proxyKey', width: 140, render: (_, row) => row.proxyKey || '-' },
    { title: 'API 标准', key: 'apiProtocol', width: 180, render: (_, row) => row.apiProtocol || '-' },
    { title: 'Session', key: 'sessionId', width: 180, ellipsis: true, render: (_, row) => row.sessionId || '-' },
    { title: 'Method', dataIndex: 'method', key: 'method', width: 100 },
    { title: 'Path', dataIndex: 'path', key: 'path', ellipsis: true },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_, row) => {
        if (!row.statusCode) return <Tag color={row.error ? 'red' : 'default'}>-</Tag>;
        const color = row.statusCode >= 500 ? 'red' : row.statusCode >= 400 ? 'orange' : 'green';
        return <Tag color={color}>{row.statusCode}</Tag>;
      }
    },
    { title: 'Duration', key: 'duration', width: 120, render: (_, row) => row.durationMs == null ? '-' : `${row.durationMs} ms` },
    { title: 'Error', key: 'error', ellipsis: true, render: (_, row) => row.error ? <Typography.Text type="danger">{row.error}</Typography.Text> : '-' },
    { title: 'Created', dataIndex: 'createdAt', key: 'createdAt', width: 220 },
    {
      title: 'Action',
      key: 'action',
      width: 110,
      render: (_, row) => <Button onClick={() => setSelectedRequestId(row.id)}>Details</Button>
    }
  ];
  return (
    <Card title="Proxy Requests">
      <Table rowKey="id" columns={columns} dataSource={rows} pagination={false} scroll={{ x: 1380 }} />
      {!rows.length && <div className="tableEmpty"><Empty text="No proxy traffic captured yet." /></div>}
      <Drawer title="Proxy Request / Response Details" open={Boolean(selectedRequestId)} onClose={() => setSelectedRequestId(null)} width={720}>
        {detailLoading && <Empty text="Loading request details..." />}
        {detail && (
          <div className="proxyDetailStack">
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="ID">{detail.id}</Descriptions.Item>
              <Descriptions.Item label="Provider">{detail.provider}</Descriptions.Item>
              <Descriptions.Item label="Proxy Key">{detail.proxyKey || '-'}</Descriptions.Item>
              <Descriptions.Item label="API Protocol">{detail.apiProtocol || '-'}</Descriptions.Item>
              <Descriptions.Item label="Session">{detail.sessionId || '-'}</Descriptions.Item>
              <Descriptions.Item label="Method">{detail.method}</Descriptions.Item>
              <Descriptions.Item label="Path">{detail.path}</Descriptions.Item>
              <Descriptions.Item label="Upstream URL">{detail.upstreamUrl}</Descriptions.Item>
              <Descriptions.Item label="Status">{detail.statusCode ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="Duration">{detail.durationMs == null ? '-' : `${detail.durationMs} ms`}</Descriptions.Item>
              <Descriptions.Item label="Created">{detail.createdAt}</Descriptions.Item>
              <Descriptions.Item label="Error">{detail.error || '-'}</Descriptions.Item>
            </Descriptions>
            <section>
              <Typography.Title level={5}>Prompt Parts</Typography.Title>
              <PromptParts value={capturedField(detail.requestSummary, 'promptParts')} />
            </section>
            <section>
              <Typography.Title level={5}>Request Body</Typography.Title>
              <JsonBlock value={capturedField(detail.requestSummary, 'body')} />
            </section>
            <section>
              <Typography.Title level={5}>Response Content</Typography.Title>
              <JsonBlock value={capturedField(detail.responseSummary, 'body')} />
            </section>
          </div>
        )}
      </Drawer>
    </Card>
  );
}

function Notifications() {
  const test = useMutation({
    mutationFn: (channel: 'webhook' | 'windows') =>
      fetch('/api/notifications/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel }) }).then((response) => response.json())
  });
  return (
    <Card title="Notification Test">
      <Space>
        <Button onClick={() => test.mutate('webhook')}>Test Webhook</Button>
        <Button onClick={() => test.mutate('windows')}>Test Windows</Button>
      </Space>
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

function JsonRows({ rows }: { rows: unknown[] }) {
  if (!rows.length) return <Empty text="Nothing to show." />;
  return <pre>{JSON.stringify(rows, null, 2)}</pre>;
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

function PromptParts({ value }: { value: unknown }) {
  const rows = Array.isArray(value) ? value as PromptPartRow[] : [];
  if (!rows.length) return <Empty text="No prompt parts parsed for this request." />;
  const columns: ColumnsType<PromptPartRow> = [
    { title: 'Kind', dataIndex: 'kind', key: 'kind', width: 120, render: (kind) => <Tag>{kind || '-'}</Tag> },
    { title: 'Role', dataIndex: 'role', key: 'role', width: 100, render: (role) => role || '-' },
    { title: 'Name', dataIndex: 'name', key: 'name', width: 170, ellipsis: true, render: (name) => name || '-' },
    { title: 'ID', dataIndex: 'id', key: 'id', width: 150, ellipsis: true, render: (id) => id || '-' },
    { title: 'Text', dataIndex: 'text', key: 'text', ellipsis: true, render: (text) => text || '-' },
    { title: 'Input', dataIndex: 'input', key: 'input', width: 220, render: (input) => input === undefined ? '-' : <Typography.Text code>{JSON.stringify(input)}</Typography.Text> }
  ];
  return <Table rowKey={(_, index) => String(index)} columns={columns} dataSource={rows} pagination={false} size="small" scroll={{ x: 900 }} />;
}

function capturedField(summary: Record<string, unknown> | undefined, field: string): unknown {
  const value = summary?.value;
  if (value && typeof value === 'object' && !Array.isArray(value) && field in value) {
    return (value as Record<string, unknown>)[field];
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).bodyCaptured === false) {
    return {
      unavailable: true,
      reason: (value as Record<string, unknown>).reason || 'body_not_captured',
      message: 'This response body was not buffered because it was streamed, binary, or otherwise unsafe to capture inline.'
    };
  }
  if (summary?.truncated) {
    return {
      unavailable: true,
      reason: 'capture_truncated',
      message: 'This capture was truncated before the body/content could be displayed without exposing headers.',
      capturedLength: summary.capturedLength,
      originalLength: summary.originalLength,
      maxLength: summary.maxLength
    };
  }
  return {};
}

function Empty({ text }: { text: string }) {
  return <Typography.Text type="secondary">{text}</Typography.Text>;
}

function CurlHint() {
  return <Typography.Text code>curl -X POST /ingest/hook/codex/session.start</Typography.Text>;
}

function useApi(path: string) {
  return useQuery({
    queryKey: [path],
    queryFn: () => fetchJson(path),
    refetchInterval: path.includes('events') || path.includes('tasks') ? 3000 : false
  });
}

async function fetchJson<T = any>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

async function postJson<T = any>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

async function refreshAgentViews(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['/api/agents/scan'] }),
    queryClient.invalidateQueries({ queryKey: ['/api/install/plans'] }),
    queryClient.invalidateQueries({ queryKey: ['/api/proxy/requests'] })
  ]);
}
