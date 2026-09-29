'use strict';

const vscode = require('vscode');
const https = require('https');
const { execFile } = require('child_process');

const METRIC_TYPE = 'aiplatform.googleapis.com/publisher/online_serving/token_count';
const CONFIG_SECTION = 'vertexTokenMonitor';

let statusBar;
let refreshTimer;
let latestUsage;
let output;

function activate(context) {
  output = vscode.window.createOutputChannel('Vertex AI Token Monitor');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'vertexTokenMonitor.refresh';
  statusBar.text = '$(sync~spin) Vertex tokens';
  statusBar.tooltip = 'Querying Google Cloud Monitoring…';
  statusBar.show();

  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand('vertexTokenMonitor.refresh', () => refresh(true)),
    vscode.commands.registerCommand('vertexTokenMonitor.showDetails', showDetails),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        scheduleRefresh();
        refresh(false);
      }
    })
  );

  scheduleRefresh();
  refresh(false);
}

function deactivate() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

function getConfig() {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

function scheduleRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  const minutes = Math.max(1, Number(getConfig().get('refreshMinutes', 5)) || 5);
  refreshTimer = setInterval(() => refresh(false), minutes * 60 * 1000);
}

async function refresh(notifyOnError) {
  statusBar.text = '$(sync~spin) Vertex tokens';
  statusBar.tooltip = 'Refreshing Vertex AI token usage…';

  try {
    const projectId = await resolveProjectId();
    const accessToken = await getAccessToken();
    const [usage, billing] = await Promise.all([
      queryTodayUsage(projectId, accessToken),
      queryBillingSafe(projectId, accessToken)
    ]);
    usage.billing = billing;
    latestUsage = usage;
    renderUsage(usage);
  } catch (error) {
    const message = friendlyError(error);
    statusBar.text = '$(warning) Vertex tokens';
    statusBar.tooltip = message;
    output.appendLine(`[${new Date().toISOString()}] ${message}`);

    if (notifyOnError) {
      vscode.window.showErrorMessage(`Vertex AI Token Monitor: ${message}`);
    }
  }
}

async function resolveProjectId() {
  const configured = String(getConfig().get('projectId', '') || '').trim();
  if (configured) {
    return configured;
  }

  const stdout = await runGcloud(['config', 'get-value', 'project', '--quiet']);
  const projectId = stdout.trim();
  if (!projectId || projectId === '(unset)') {
    throw new Error(
      'No Google Cloud project is configured. Set vertexTokenMonitor.projectId or run: gcloud config set project YOUR_PROJECT_ID'
    );
  }
  return projectId;
}

async function getAccessToken() {
  const stdout = await runGcloud(['auth', 'print-access-token', '--quiet']);
  const token = stdout.trim();
  if (!token) {
    throw new Error('gcloud returned an empty access token. Run: gcloud auth login');
  }
  return token;
}

function runGcloud(args) {
  let executable = String(getConfig().get('gcloudPath', 'gcloud') || 'gcloud').trim();
  if (process.platform === 'win32' && executable.toLowerCase() === 'gcloud') {
    executable = 'gcloud.cmd';
  }

  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message || '').trim();
          const wrapped = new Error(
            detail || `Failed to execute ${executable}. Make sure the Google Cloud CLI is installed and on PATH.`
          );
          wrapped.code = error.code;
          reject(wrapped);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

async function queryTodayUsage(projectId, accessToken) {
  const end = new Date();
  const start = new Date(end);
  start.setHours(0, 0, 0, 0);

  const config = getConfig();
  const extraFilter = String(config.get('extraFilter', '') || '').trim();
  let filter = `metric.type="${METRIC_TYPE}"`;
  if (extraFilter) {
    filter += ` AND (${extraFilter})`;
  }

  const totals = {
    input: 0n,
    output: 0n,
    other: 0n
  };
  const models = new Map();

  let pageToken = '';
  do {
    const url = new URL(
      `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(projectId)}/timeSeries`
    );
    url.searchParams.set('filter', filter);
    url.searchParams.set('interval.startTime', start.toISOString());
    url.searchParams.set('interval.endTime', end.toISOString());
    url.searchParams.set('view', 'FULL');
    url.searchParams.set('pageSize', '10000');
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }

    const response = await getJson(url, accessToken);
    const timeSeries = Array.isArray(response.timeSeries) ? response.timeSeries : [];

    for (const series of timeSeries) {
      const tokenType = String(series.metric?.labels?.type || 'other').toLowerCase();
      const bucket = tokenType === 'input' || tokenType === 'output' ? tokenType : 'other';
      const amount = sumPoints(series.points);
      totals[bucket] += amount;

      const resource = series.resource?.labels || {};
      const modelId = resource.model_user_id || 'unknown-model';
      const versionId = resource.model_version_id || '';
      const publisher = resource.publisher || '';
      const modelKey = versionId ? `${modelId}@${versionId}` : modelId;

      if (!models.has(modelKey)) {
        models.set(modelKey, {
          modelId,
          versionId,
          publisher,
          input: 0n,
          output: 0n,
          other: 0n
        });
      }
      models.get(modelKey)[bucket] += amount;
    }

    pageToken = response.nextPageToken || '';
  } while (pageToken);

  return {
    projectId,
    start,
    end,
    filter,
    totals,
    models: [...models.values()].sort((a, b) => {
      const aTotal = a.input + a.output + a.other;
      const bTotal = b.input + b.output + b.other;
      return aTotal === bTotal ? 0 : aTotal > bTotal ? -1 : 1;
    }),
    refreshedAt: new Date()
  };
}

// Billing failures must never hide the token counts, so they are captured instead of thrown.
async function queryBillingSafe(projectId, accessToken) {
  try {
    return await queryBilling(projectId, accessToken);
  } catch (error) {
    error.source = 'billing';
    const message = friendlyError(error);
    output.appendLine(`[${new Date().toISOString()}] Cloud Billing: ${message}`);
    return { error: message };
  }
}

// Cloud Billing has no "current spend" API; actual costs are only available through the
// Cloud Billing export to BigQuery, which lags behind real time by hours.
async function queryBilling(projectId, accessToken) {
  const config = getConfig();
  const table = String(config.get('billingExportTable', '') || '').trim();
  if (!table) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(table) || table.split(/[.:]/).length < 3) {
    throw new Error(
      'vertexTokenMonitor.billingExportTable must look like PROJECT.DATASET.gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX'
    );
  }

  const queryProject =
    String(config.get('billingQueryProjectId', '') || '').trim() || projectId;
  const service = String(config.get('billingServiceDescription', 'Vertex AI') || '').trim();

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const netCost = 'cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)';
  const sql = `
    SELECT
      currency,
      SUM(IF(usage_start_time >= @todayStart, ${netCost}, 0)) AS today_cost,
      SUM(${netCost}) AS month_cost,
      SUM(IF(usage_start_time >= @todayStart, cost, 0)) AS today_gross,
      SUM(cost) AS month_gross,
      MAX(usage_end_time) AS data_through
    FROM \`${table}\`
    WHERE usage_start_time >= @monthStart
      AND project.id = @projectId
      ${service ? 'AND service.description = @service' : ''}
    GROUP BY currency
    ORDER BY month_cost DESC`;

  const param = (name, type, value) => ({
    name,
    parameterType: { type },
    parameterValue: { value }
  });
  const queryParameters = [
    param('todayStart', 'TIMESTAMP', todayStart.toISOString()),
    param('monthStart', 'TIMESTAMP', monthStart.toISOString()),
    param('projectId', 'STRING', projectId)
  ];
  if (service) {
    queryParameters.push(param('service', 'STRING', service));
  }

  const url = new URL(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(queryProject)}/queries`
  );
  const response = await requestJson(url, accessToken, {
    apiName: 'BigQuery API',
    method: 'POST',
    body: {
      query: sql,
      useLegacySql: false,
      parameterMode: 'NAMED',
      queryParameters,
      timeoutMs: 20000
    }
  });

  if (response.jobComplete === false) {
    throw new Error('BigQuery did not finish the billing query in time. It will be retried on the next refresh.');
  }

  const rows = (Array.isArray(response.rows) ? response.rows : []).map((row) => {
    const cell = (index) => row.f?.[index]?.v;
    const num = (index) => {
      const value = Number(cell(index));
      return Number.isFinite(value) ? value : 0;
    };
    // TIMESTAMP cells come back as seconds since the epoch, as a string.
    const seconds = Number(cell(5));
    return {
      currency: cell(0) || 'USD',
      today: num(1),
      month: num(2),
      todayGross: num(3),
      monthGross: num(4),
      dataThrough: Number.isFinite(seconds) ? new Date(seconds * 1000) : undefined
    };
  });

  return { table, service, monthStart, rows };
}

function sumPoints(points) {
  let total = 0n;
  for (const point of Array.isArray(points) ? points : []) {
    const value = point?.value || {};
    if (value.int64Value !== undefined) {
      try {
        total += BigInt(String(value.int64Value));
      } catch {
        // Ignore malformed values rather than failing the whole refresh.
      }
    } else if (value.doubleValue !== undefined && Number.isFinite(Number(value.doubleValue))) {
      // This metric is currently INT64, but keep a defensive fallback.
      total += BigInt(Math.round(Number(value.doubleValue)));
    }
  }
  return total;
}

function getJson(url, accessToken) {
  return requestJson(url, accessToken, { apiName: 'Cloud Monitoring' });
}

function requestJson(url, accessToken, { apiName, method = 'GET', body: requestBody } = {}) {
  return new Promise((resolve, reject) => {
    const payload = requestBody === undefined ? undefined : JSON.stringify(requestBody);
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'vertex-ai-token-monitor-vscode/0.1.0'
    };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const request = https.request(
      url,
      {
        method,
        headers
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = body ? JSON.parse(body) : {};
          } catch {
            reject(new Error(`${apiName} returned invalid JSON (HTTP ${response.statusCode}).`));
            return;
          }

          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            const apiMessage = parsed?.error?.message || body || `HTTP ${response.statusCode}`;
            const error = new Error(`${apiName}: ${apiMessage}`);
            error.statusCode = response.statusCode;
            reject(error);
            return;
          }

          resolve(parsed);
        });
      }
    );

    request.setTimeout(30000, () => {
      request.destroy(new Error(`${apiName} request timed out.`));
    });
    request.on('error', reject);
    if (payload !== undefined) {
      request.write(payload);
    }
    request.end();
  });
}

function renderUsage(usage) {
  const { input, output: outputTokens, other } = usage.totals;
  const total = input + outputTokens + other;

  const cost = usage.billing?.rows?.length ? ` · ${formatMoney(usage.billing.rows[0].month, usage.billing.rows[0].currency)}` : '';
  statusBar.text = `$(pulse) Vertex: ${formatCompact(input)} in / ${formatCompact(outputTokens)} out${cost}`;
  statusBar.tooltip = buildTooltip(usage, total);
  statusBar.command = 'vertexTokenMonitor.refresh';
}

function buildTooltip(usage, total) {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.isTrusted = false;
  tooltip.appendMarkdown('### Vertex AI tokens today\n\n');
  tooltip.appendMarkdown(`**Project:** ${inlineCode(usage.projectId)}  \n`);
  tooltip.appendMarkdown(`**Input:** ${formatExact(usage.totals.input)}  \n`);
  tooltip.appendMarkdown(`**Output:** ${formatExact(usage.totals.output)}  \n`);
  if (usage.totals.other > 0n) {
    tooltip.appendMarkdown(`**Other:** ${formatExact(usage.totals.other)}  \n`);
  }
  tooltip.appendMarkdown(`**Total:** ${formatExact(total)}  \n`);
  tooltip.appendMarkdown(`**Since:** ${usage.start.toLocaleString()}  \n`);
  tooltip.appendMarkdown(`**Refreshed:** ${usage.refreshedAt.toLocaleTimeString()}\n\n`);

  if (usage.models.length) {
    tooltip.appendMarkdown('**By model**  \n');
    for (const model of usage.models.slice(0, 8)) {
      const label = model.versionId ? `${model.modelId}@${model.versionId}` : model.modelId;
      tooltip.appendMarkdown(
        `${inlineCode(label)}: ${formatCompact(model.input)} in / ${formatCompact(model.output)} out  \n`
      );
    }
    if (usage.models.length > 8) {
      tooltip.appendMarkdown(`…and ${usage.models.length - 8} more  \n`);
    }
    tooltip.appendMarkdown('\n');
  }

  appendBillingMarkdown(tooltip, usage.billing);

  tooltip.appendMarkdown('_Click to refresh. Counts all matching Vertex publisher-model traffic in this project._');
  return tooltip;
}

function appendBillingMarkdown(tooltip, billing) {
  tooltip.appendMarkdown('**Cloud Billing (actual cost)**  \n');
  if (!billing) {
    tooltip.appendMarkdown(
      '_Not configured. Set `vertexTokenMonitor.billingExportTable` to your BigQuery billing export table._\n\n'
    );
    return;
  }
  if (billing.error) {
    tooltip.appendMarkdown(`_${billing.error.replace(/[_*`]/g, ' ')}_\n\n`);
    return;
  }
  if (!billing.rows.length) {
    tooltip.appendMarkdown('_No billed usage exported yet this month._\n\n');
    return;
  }

  for (const row of billing.rows) {
    tooltip.appendMarkdown(`**Today:** ${formatMoney(row.today, row.currency)}  \n`);
    tooltip.appendMarkdown(
      `**This month:** ${formatMoney(row.month, row.currency)}` +
        (row.monthGross !== row.month ? ` (${formatMoney(row.monthGross, row.currency)} before credits)` : '') +
        '  \n'
    );
  }
  const through = billing.rows.map((row) => row.dataThrough).filter(Boolean).sort((a, b) => b - a)[0];
  if (through) {
    tooltip.appendMarkdown(`**Billing data through:** ${through.toLocaleString()}  \n`);
  }
  tooltip.appendMarkdown('_Billing export lags real time by hours, so recent usage may not be priced yet._\n\n');
}

function showDetails() {
  if (!latestUsage) {
    vscode.window.showInformationMessage('Vertex AI Token Monitor has not loaded usage yet.');
    return;
  }

  const { input, output: outputTokens, other } = latestUsage.totals;
  const total = input + outputTokens + other;
  const billing = latestUsage.billing;
  const billingLines = billing?.rows?.length
    ? billing.rows.map(
        (row) =>
          `Cost today: ${formatMoney(row.today, row.currency)}, this month: ${formatMoney(row.month, row.currency)}`
      )
    : [];
  const message = [
    `Project: ${latestUsage.projectId}`,
    `Input: ${formatExact(input)}`,
    `Output: ${formatExact(outputTokens)}`,
    other > 0n ? `Other: ${formatExact(other)}` : null,
    `Total: ${formatExact(total)}`,
    `Since: ${latestUsage.start.toLocaleString()}`,
    ...billingLines,
    billing?.error ? `Billing: ${billing.error}` : null
  ]
    .filter(Boolean)
    .join(' • ');

  vscode.window.showInformationMessage(message, 'Refresh').then((choice) => {
    if (choice === 'Refresh') {
      refresh(true);
    }
  });
}

function formatExact(value) {
  return value.toLocaleString();
}

function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatCompact(value) {
  const negative = value < 0n;
  const n = negative ? -value : value;
  const sign = negative ? '-' : '';
  const units = [
    [1_000_000_000_000n, 'T'],
    [1_000_000_000n, 'B'],
    [1_000_000n, 'M'],
    [1_000n, 'K']
  ];

  for (const [divisor, suffix] of units) {
    if (n >= divisor) {
      const whole = n / divisor;
      const tenth = ((n % divisor) * 10n) / divisor;
      return tenth === 0n
        ? `${sign}${whole}${suffix}`
        : `${sign}${whole}.${tenth}${suffix}`;
    }
  }
  return `${sign}${n}`;
}

// Backslash escapes are shown literally inside code spans, so only neutralise backticks.
function inlineCode(value) {
  return `\`${String(value).replace(/`/g, "'")}\``;
}

function friendlyError(error) {
  const message = String(error?.message || error || 'Unknown error');

  if (error?.source === 'billing') {
    if (error?.statusCode === 403 || /permission|PERMISSION_DENIED/i.test(message)) {
      return `${message} The account needs roles/bigquery.jobUser on the query project and roles/bigquery.dataViewer on the billing export dataset.`;
    }
    if (error?.statusCode === 404 || /not found/i.test(message)) {
      return `${message} Check vertexTokenMonitor.billingExportTable (and billingQueryProjectId).`;
    }
    return message;
  }
  if (error?.code === 'ENOENT' || /not recognized|not found|cannot find/i.test(message)) {
    return 'Google Cloud CLI (gcloud) was not found. Install it or set vertexTokenMonitor.gcloudPath.';
  }
  if (/login required|reauth|credentials|invalid_grant|access token/i.test(message)) {
    return `${message} Try running: gcloud auth login`;
  }
  if (error?.statusCode === 403 || /permission|PERMISSION_DENIED/i.test(message)) {
    return `${message} The account needs permission to read Cloud Monitoring time series (for example roles/monitoring.viewer).`;
  }
  if (/SERVICE_DISABLED|has not been used|Monitoring API/i.test(message) && /disabled|enable/i.test(message)) {
    return `${message} Enable monitoring.googleapis.com for the project.`;
  }
  return message;
}

module.exports = {
  activate,
  deactivate
};
