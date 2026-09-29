'use strict';

const vscode = require('vscode');
const https = require('https');
const { execFile } = require('child_process');

const METRIC_TYPE = 'aiplatform.googleapis.com/publisher/online_serving/token_count';
const CONFIG_SECTION = 'vertexTokenMonitor';
const VERTEX_BILLING_SERVICE = 'services/C7E2-9256-1C43';
const PRICE_CACHE_KEY = 'priceCatalog';
const PRICE_CACHE_VERSION = 1;
const PRICE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Matches on-demand SKUs such as "Gemini 3.8 Flash Global Text Input Priority - Predictions".
// Long-context, batch, caching, off-peak and non-text modality SKUs are deliberately not matched.
const SKU_PATTERN = /^(gemini .+?) (?:(global|regional) )?text (input|output)(?: (priority|flex))? - predictions$/;

let extensionContext;
let statusBar;
let refreshTimer;
let latestUsage;
let output;

function activate(context) {
  extensionContext = context;
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
    const pricing = await loadPricing(accessToken);
    const usage = await queryTodayUsage(projectId, accessToken, pricing);
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

async function loadPricing(accessToken) {
  const config = getConfig();
  if (!config.get('showSpend', true)) {
    return undefined;
  }

  const currency = String(config.get('currency', 'USD') || 'USD').trim().toUpperCase();
  const cached = extensionContext.globalState.get(PRICE_CACHE_KEY);
  const cacheUsable = cached?.version === PRICE_CACHE_VERSION && cached.currency === currency;
  if (cacheUsable && Date.now() - cached.fetchedAt < PRICE_CACHE_MAX_AGE_MS) {
    return { ...cached, fetchedAt: new Date(cached.fetchedAt) };
  }

  try {
    const models = await fetchPriceCatalog(accessToken, currency);
    const fresh = { version: PRICE_CACHE_VERSION, currency, fetchedAt: Date.now(), models };
    await extensionContext.globalState.update(PRICE_CACHE_KEY, fresh);
    return { ...fresh, fetchedAt: new Date(fresh.fetchedAt) };
  } catch (error) {
    const message = `Could not load Vertex AI prices: ${friendlyError(error)}`;
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
    if (cacheUsable) {
      return { ...cached, fetchedAt: new Date(cached.fetchedAt), error: message };
    }
    return { currency, models: {}, error: message };
  }
}

// Downloads list prices for the Vertex AI service from the Cloud Billing Catalog API and keeps
// only on-demand Gemini text token SKUs, as { modelName: { "location|type|tier": pricePerToken } }.
async function fetchPriceCatalog(accessToken, currency) {
  const models = {};
  let pageToken = '';
  do {
    const url = new URL(`https://cloudbilling.googleapis.com/v1/${VERTEX_BILLING_SERVICE}/skus`);
    url.searchParams.set('currencyCode', currency);
    url.searchParams.set('pageSize', '5000');
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }

    const response = await getJson(url, accessToken, 'Cloud Billing Catalog API');
    for (const sku of Array.isArray(response.skus) ? response.skus : []) {
      const description = String(sku.description || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const match = SKU_PATTERN.exec(description);
      const expression = sku.pricingInfo?.[0]?.pricingExpression;
      if (!match || expression?.usageUnit !== 'count') {
        continue;
      }

      const rates = Array.isArray(expression.tieredRates) ? expression.tieredRates : [];
      const rate = rates[rates.length - 1]?.unitPrice;
      if (!rate) {
        continue;
      }
      const unitPrice = Number(rate.units || 0) + Number(rate.nanos || 0) / 1e9;
      const perToken = unitPrice / (Number(expression.baseUnitConversionFactor) || 1);

      const [, modelName, location = '', tokenType, tier = ''] = match;
      for (const name of expandSkuModelName(modelName)) {
        models[name] = models[name] || {};
        models[name][`${location}|${tokenType}|${tier}`] = perToken;
      }
    }

    pageToken = response.nextPageToken || '';
  } while (pageToken);

  if (!Object.keys(models).length) {
    throw new Error('No Gemini token prices were found in the Cloud Billing catalog.');
  }
  return models;
}

// SKU names sometimes cover several versions, e.g. "gemini 3.0 / 3.1 pro".
function expandSkuModelName(name) {
  const match = /^(.*?)(\S+(?: \/ \S+)+)(.*)$/.exec(name);
  const names = match ? match[2].split(' / ').map((version) => match[1] + version + match[3]) : [name];
  return names.map(normalizeModelName);
}

// Maps both metric model IDs ("gemini-3.8-flash-preview-09-2026") and SKU model names
// ("gemini 3.8 flash") to a common form.
function normalizeModelName(name) {
  const words = String(name)
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.replace(/^(\d+)\.0$/, '$1'));
  const suffixStart = words.findIndex((word, index) => index > 0 && /^(preview|exp|latest)$/.test(word));
  if (suffixStart > 0) {
    words.length = suffixStart;
  }
  if (words.length > 1 && /^\d{3}$/.test(words[words.length - 1])) {
    words.pop();
  }
  return words.join(' ');
}

function pricePerToken(pricing, resource, metricLabels, tokenType) {
  if (!pricing?.models || (tokenType !== 'input' && tokenType !== 'output')) {
    return undefined;
  }
  // Provisioned Throughput ("dedicated") traffic is prepaid rather than billed per token.
  if (metricLabels.request_type && metricLabels.request_type !== 'shared') {
    return undefined;
  }

  const sharedType = String(metricLabels.shared_request_type || 'standard').toLowerCase();
  const tier = sharedType === 'standard' ? '' : sharedType;
  const location = resource.location === 'global' ? 'global' : 'regional';
  const prices = pricing.models[normalizeModelName(resource.model_user_id || '')];
  if (!prices) {
    return undefined;
  }
  return prices[`${location}|${tokenType}|${tier}`] ?? prices[`|${tokenType}|${tier}`];
}

async function queryTodayUsage(projectId, accessToken, pricing) {
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
    other: 0n,
    cost: 0,
    unpriced: 0n
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
          other: 0n,
          cost: 0,
          unpriced: 0n
        });
      }
      const model = models.get(modelKey);
      model[bucket] += amount;

      if (pricing) {
        const price = pricePerToken(pricing, resource, series.metric?.labels || {}, bucket);
        if (price === undefined) {
          model.unpriced += amount;
          totals.unpriced += amount;
        } else {
          const cost = Number(amount) * price;
          model.cost += cost;
          totals.cost += cost;
        }
      }
    }

    pageToken = response.nextPageToken || '';
  } while (pageToken);

  return {
    projectId,
    start,
    end,
    filter,
    pricing,
    totals,
    models: [...models.values()].sort((a, b) => {
      const aTotal = a.input + a.output + a.other;
      const bTotal = b.input + b.output + b.other;
      return aTotal === bTotal ? 0 : aTotal > bTotal ? -1 : 1;
    }),
    refreshedAt: new Date()
  };
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

function getJson(url, accessToken, apiName = 'Cloud Monitoring API') {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'User-Agent': 'vertex-ai-token-monitor-vscode/0.1.0'
        }
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

    request.setTimeout(20000, () => {
      request.destroy(new Error(`${apiName} request timed out.`));
    });
    request.on('error', reject);
    request.end();
  });
}

function renderUsage(usage) {
  const { input, output: outputTokens, other } = usage.totals;
  const total = input + outputTokens + other;

  statusBar.text = `$(pulse) Vertex: ${formatCompact(input)} in / ${formatCompact(outputTokens)} out`;
  if (usage.pricing) {
    statusBar.text += ` · ${formatSpend(usage)}`;
  }
  statusBar.tooltip = buildTooltip(usage, total);
  statusBar.command = 'vertexTokenMonitor.refresh';
}

// A trailing "+" means some tokens had no matching price, so the real spend is higher.
function formatSpend(usage) {
  const amount = formatMoney(usage.totals.cost, usage.pricing.currency);
  return usage.totals.unpriced > 0n ? `${amount}+` : amount;
}

function formatMoney(amount, currency) {
  const digits = amount > 0 && amount < 1 ? 4 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: digits
    }).format(amount);
  } catch {
    return `${amount.toFixed(digits)} ${currency}`;
  }
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
  if (usage.pricing) {
    tooltip.appendMarkdown(`**Estimated spend:** ${formatSpend(usage)}  \n`);
  }
  tooltip.appendMarkdown(`**Since:** ${usage.start.toLocaleString()}  \n`);
  tooltip.appendMarkdown(`**Refreshed:** ${usage.refreshedAt.toLocaleTimeString()}\n\n`);

  if (usage.models.length) {
    tooltip.appendMarkdown('**By model**  \n');
    for (const model of usage.models.slice(0, 8)) {
      const label = model.versionId ? `${model.modelId}@${model.versionId}` : model.modelId;
      let line = `${inlineCode(label)}: ${formatCompact(model.input)} in / ${formatCompact(model.output)} out`;
      if (usage.pricing) {
        line += ` · ${formatMoney(model.cost, usage.pricing.currency)}`;
        if (model.unpriced > 0n) {
          line += ` (${formatCompact(model.unpriced)} tokens unpriced)`;
        }
      }
      tooltip.appendMarkdown(`${line}  \n`);
    }
    if (usage.models.length > 8) {
      tooltip.appendMarkdown(`…and ${usage.models.length - 8} more  \n`);
    }
    tooltip.appendMarkdown('\n');
  }

  if (usage.pricing) {
    if (usage.pricing.error) {
      tooltip.appendMarkdown(`$(warning) ${escapeMarkdown(usage.pricing.error)}\n\n`);
    }
    const priceDate = usage.pricing.fetchedAt ? ` as of ${usage.pricing.fetchedAt.toLocaleDateString()}` : '';
    tooltip.appendMarkdown(
      `_Spend is an estimate from Cloud Billing list prices${priceDate}: standard text rates, ` +
        'excluding long-context surcharges, context caching, discounts and credits._\n\n'
    );
  }

  tooltip.appendMarkdown('_Click to refresh. Counts all matching Vertex publisher-model traffic in this project._');
  return tooltip;
}

function showDetails() {
  if (!latestUsage) {
    vscode.window.showInformationMessage('Vertex AI Token Monitor has not loaded usage yet.');
    return;
  }

  const { input, output: outputTokens, other } = latestUsage.totals;
  const total = input + outputTokens + other;
  const message = [
    `Project: ${latestUsage.projectId}`,
    `Input: ${formatExact(input)}`,
    `Output: ${formatExact(outputTokens)}`,
    other > 0n ? `Other: ${formatExact(other)}` : null,
    `Total: ${formatExact(total)}`,
    latestUsage.pricing ? `Estimated spend: ${formatSpend(latestUsage)}` : null,
    `Since: ${latestUsage.start.toLocaleString()}`
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

function escapeMarkdown(value) {
  return String(value).replace(/[\\`*_{}[\]()#+\-.!<>|~$]/g, '\\$&');
}

function friendlyError(error) {
  const message = String(error?.message || error || 'Unknown error');

  if (error?.code === 'ENOENT' || /not recognized|not found|cannot find/i.test(message)) {
    return 'Google Cloud CLI (gcloud) was not found. Install it or set vertexTokenMonitor.gcloudPath.';
  }
  if (/login required|reauth|credentials|invalid_grant|access token/i.test(message)) {
    return `${message} Try running: gcloud auth login`;
  }
  if (error?.statusCode === 403 || /permission|PERMISSION_DENIED/i.test(message)) {
    return `${message} The account needs permission to read Cloud Monitoring time series (for example roles/monitoring.viewer).`;
  }
  if (/SERVICE_DISABLED|has not been used|Monitoring API|Billing/i.test(message) && /disabled|enable/i.test(message)) {
    const api = /billing/i.test(message) ? 'cloudbilling.googleapis.com' : 'monitoring.googleapis.com';
    return `${message} Enable ${api} for the project.`;
  }
  return message;
}

module.exports = {
  activate,
  deactivate
};
