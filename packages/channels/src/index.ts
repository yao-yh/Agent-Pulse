import { spawn } from 'node:child_process';
import { ChannelSendInput, ChannelSendResult, newId } from '@agent-pulse/core';

export async function sendNotification(input: ChannelSendInput): Promise<ChannelSendResult> {
  if (input.channel === 'webhook') return sendWebhook(input);
  if (input.channel === 'windows') return sendWindows(input);
  return { success: false, channel: input.channel, error: 'Unsupported channel' };
}

export async function sendWebhook(input: ChannelSendInput): Promise<ChannelSendResult> {
  const url = String(input.config?.url || process.env.AGENT_PULSE_WEBHOOK_URL || '');
  if (!url) return { success: false, channel: 'webhook', error: 'Webhook URL is not configured' };
  try {
    const response = await fetch(url, {
      method: String(input.config?.method || 'POST'),
      headers: { 'content-type': 'application/json', ...(input.config?.headers as Record<string, string> | undefined) },
      body: JSON.stringify({ title: input.title, message: input.message, event: input.event })
    });
    return { success: response.ok, channel: 'webhook', messageId: newId('msg'), error: response.ok ? undefined : `HTTP ${response.status}` };
  } catch (error) {
    return { success: false, channel: 'webhook', error: String(error) };
  }
}

export async function sendWindows(input: ChannelSendInput): Promise<ChannelSendResult> {
  if (process.platform !== 'win32') {
    return { success: false, channel: 'windows', error: 'Windows notifications are only available on win32' };
  }
  const title = escapePowerShell(input.title);
  const message = escapePowerShell(input.message);
  const script = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;` +
    `$template=[Windows.UI.Notifications.ToastTemplateType]::ToastText02;` +
    `$xml=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template);` +
    `$texts=$xml.GetElementsByTagName('text');$texts.Item(0).AppendChild($xml.CreateTextNode('${title}'))|Out-Null;` +
    `$texts.Item(1).AppendChild($xml.CreateTextNode('${message}'))|Out-Null;` +
    `$toast=[Windows.UI.Notifications.ToastNotification]::new($xml);` +
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('AgentPulse').Show($toast);`;
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let error = '';
    child.stderr.on('data', (chunk) => (error += String(chunk)));
    child.on('error', (err) => resolve({ success: false, channel: 'windows', error: err.message }));
    child.on('close', (code) => resolve({ success: code === 0, channel: 'windows', messageId: newId('msg'), error: code === 0 ? undefined : error || `Exit ${code}` }));
  });
}

function escapePowerShell(value: string): string {
  return value.replace(/'/g, "''").slice(0, 200);
}

