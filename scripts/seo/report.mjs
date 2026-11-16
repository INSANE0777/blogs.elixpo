const MAX_TEXT = 2048;

function escapeText(value) {
  return String(value ?? '')
    .slice(0, MAX_TEXT)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, "'")
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
}

function issueLine(issue) {
  return `- \`${escapeText(issue.code)}\` (${escapeText(issue.check)}): ${escapeText(issue.reason)}`;
}

function inspectionLine(inspection) {
  const status = inspection?.status ?? 'skipped';
  if (status === 'invalid-configuration') {
    return `- Google inspection: **invalid configuration** (\`${escapeText(inspection.code)}\`) — ${escapeText(inspection.reason)}`;
  }
  if (status === 'completed') {
    return `- Google inspection: completed — ${inspection.results.length} URL(s), property \`${escapeText(inspection.property)}\``;
  }
  if (status === 'partial') {
    return (
      `- Google inspection: partial — ${inspection.results.length} attempted, ` +
      `${inspection.notInspected.length} not inspected` +
      `${inspection.code ? ` (\`${escapeText(inspection.code)}\`)` : ''}, ` +
      `property \`${escapeText(inspection.property)}\``
    );
  }
  if (status === 'unavailable') {
    return (
      `- Google inspection: unavailable` +
      `${inspection.code ? ` (\`${escapeText(inspection.code)}\`)` : ''}` +
      `${inspection.reason ? ` — ${escapeText(inspection.reason)}` : ''}`
    );
  }
  return `- Google inspection: skipped — ${escapeText(inspection?.reason ?? 'inspection not requested')}`;
}

function inspectionSection(inspection) {
  if (!inspection || !['completed', 'partial', 'unavailable'].includes(inspection.status)) return [];
  const lines = [
    '',
    '## Google URL inspection',
    '',
    'This describes the version in the Google index; it is not a live page test and does not change the technical status.',
    '',
  ];
  for (const result of inspection.results) {
    if (result.status === 'inspected') {
      lines.push(`### \`${escapeText(result.url)}\` — ${escapeText(result.verdict)}`, '');
      lines.push(`- robots.txt: ${escapeText(result.robotsTxtState)}`);
      lines.push(`- indexing: ${escapeText(result.indexingState)}`);
      lines.push(`- page fetch: ${escapeText(result.pageFetchState)}`);
      if (result.lastCrawlTime) lines.push(`- last crawl: ${escapeText(result.lastCrawlTime)}`);
      lines.push('');
    } else {
      lines.push(`### \`${escapeText(result.url)}\` — not inspected`, '');
      lines.push(`- \`${escapeText(result.code)}\``, '');
    }
  }
  if (inspection.notInspected?.length) {
    lines.push(`${inspection.notInspected.length} URL(s) were not inspected after inspection stopped.`, '');
    for (const url of inspection.notInspected) lines.push(`- \`${escapeText(url)}\``);
    lines.push('');
  }
  return lines;
}

export function renderMarkdown(report) {
  const lines = [
    '# SEO audit report',
    '',
    `- Sitemap: \`${escapeText(report.sitemapUrl)}\``,
    `- Technical status: ${report.technicalStatus === 'passed' ? '**passed**' : '**failed**'}`,
    `- Discovered articles: ${report.discoveredCount}`,
    `- Sampled articles: ${report.sampledUrls.length} (${escapeText(report.selection)})`,
    `- Duplicate sitemap entries: ${report.duplicateCount}`,
    inspectionLine(report.inspection),
    '',
    'This technical audit does not prove that Google has indexed these URLs.',
    '',
    '## Global issues',
    '',
  ];
  if (report.issues.length === 0) lines.push('None.');
  for (const globalIssue of report.issues) lines.push(issueLine(globalIssue));
  lines.push('', '## Sampled articles', '');
  if (report.results.length === 0) lines.push('None.');
  for (const result of report.results) {
    lines.push(
      `### \`${escapeText(result.url)}\` — ${result.issues.length === 0 ? 'passed' : 'failed'}`,
      '',
    );
    if (result.issues.length === 0) lines.push('No issues.');
    for (const articleIssue of result.issues) lines.push(issueLine(articleIssue));
    lines.push('');
  }
  lines.push(...inspectionSection(report.inspection));
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}
