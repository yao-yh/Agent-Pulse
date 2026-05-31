import { AgentEvent, AnalysisResult, maxRisk, newId, nowIso, RiskLevel } from '@agent-pulse/core';
import { createSecretProbe } from '@agent-pulse/probes';

export function analyzeEvent(event: AgentEvent): AnalysisResult {
  const findings: AnalysisResult['findings'] = [];
  const text = JSON.stringify({ raw: event.raw, normalized: event.normalized });
  const secretProbe = createSecretProbe();

  for (const finding of secretProbe.containsSecret(text)) {
    findings.push(finding);
  }

  if (/\b(rm\s+-rf|Remove-Item\s+-Recurse|format\s+c:|del\s+\/s)\b/i.test(text)) {
    findings.push({ code: 'command.dangerous', message: 'Dangerous shell command pattern detected' });
  }

  if (text.length > 20_000) {
    findings.push({ code: 'content.large', message: 'Large event payload detected' });
  }

  if (event.eventType === 'error') {
    findings.push({ code: 'event.error', message: 'Agent error event received' });
  }

  const riskLevel = findings.reduce<RiskLevel>((level, finding) => {
    if (finding.code.includes('secret') || finding.code.includes('dangerous')) return maxRisk(level, 'high');
    if (finding.code.includes('error')) return maxRisk(level, 'medium');
    return maxRisk(level, 'low');
  }, event.riskLevel || 'none');

  return {
    id: newId('analysis'),
    eventId: event.id,
    analyzer: 'basic',
    riskLevel,
    findings,
    createdAt: nowIso()
  };
}

