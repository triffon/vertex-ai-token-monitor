# Vertex AI Token Monitor for VS Code

A tiny local VS Code extension that shows today's Vertex AI publisher-model token usage in the status bar.

It reads the official Cloud Monitoring metric:

`aiplatform.googleapis.com/publisher/online_serving/token_count`

It does **not** read Antigravity prompts, transcripts, or local Antigravity files.

## Requirements

1. Google Cloud CLI (`gcloud`) installed.
2. Authenticate:

   ```bash
   gcloud auth login
   ```

3. Select the Google Cloud project billed for your Vertex AI usage:

   ```bash
   gcloud config set project YOUR_PROJECT_ID
   ```

   Or set `vertexTokenMonitor.projectId` in VS Code Settings.

4. Your account needs permission to read Cloud Monitoring time series, typically `roles/monitoring.viewer` (or equivalent permissions).

## Install from source

This extension has zero runtime npm dependencies.

From this directory, package it with Microsoft's VS Code extension packager:

```bash
npm run package
```

That invokes `npx @vscode/vsce package` and creates a `.vsix` file. In VS Code:

1. Extensions
2. `...`
3. **Install from VSIX...**
4. Select the generated VSIX

## What the status bar shows

Example:

`Vertex: 1.4M in / 84.2K out · $3.21`

Hover for exact totals and a per-model breakdown. Click the status item to refresh immediately.

## Estimated spend

Spend is calculated as token count × list price. Prices come from Google's official
[Cloud Billing Catalog API](https://cloud.google.com/billing/docs/how-to/get-pricing-information-api)
(Vertex AI service SKUs), are cached locally and re-downloaded once a day.

Each Cloud Monitoring series is matched to the SKU for its model, location (`global` vs regional) and
request tier (standard, priority, flex). For example, `gemini-3.8-flash` input on `global` uses
the SKU *Gemini 3.8 Flash Global Text Input - Predictions*.

It is an **estimate**, not your invoice:

- only Gemini text input/output SKUs are matched; long-context surcharges, context caching, grounding,
  and non-text modalities are not accounted for;
- negotiated discounts, committed-use and free-tier credits are not applied;
- tokens that could not be priced (other publishers such as Anthropic, Provisioned Throughput traffic,
  or models missing from the catalog) are listed in the tooltip, and the total is shown with a `+`
  (e.g. `$3.21+`) to indicate the real amount is higher.

For exact billed costs, use Cloud Billing reports or the billing export to BigQuery.

Command Palette commands:

- `Vertex Token Monitor: Refresh`
- `Vertex Token Monitor: Show Details`

## Settings

```json
{
  "vertexTokenMonitor.projectId": "my-project-id",
  "vertexTokenMonitor.refreshMinutes": 5,
  "vertexTokenMonitor.gcloudPath": "gcloud",
  "vertexTokenMonitor.extraFilter": "",
  "vertexTokenMonitor.showSpend": true,
  "vertexTokenMonitor.currency": "USD"
}
```

### Optional filtering

By default the extension sums **all** Vertex AI publisher-model traffic in the project. If the project is shared by other applications, you can add a Cloud Monitoring filter.

For example, after verifying the exact resource label value in Metrics Explorer:

```json
{
  "vertexTokenMonitor.extraFilter": "resource.labels.model_user_id=\"YOUR_MODEL_ID\""
}
```

Do not assume this can isolate Antigravity specifically: the documented token metric does not provide an Antigravity-client/session label.

## Day boundary

"Today" is calculated from local midnight in the machine running the VS Code extension host, then converted to UTC for the Cloud Monitoring API interval.

## Security model

The source is deliberately small. It:

- runs only `gcloud config get-value project` and `gcloud auth print-access-token`;
- sends the resulting OAuth access token only to `https://monitoring.googleapis.com` and, when
  `showSpend` is enabled, `https://cloudbilling.googleapis.com` (public price catalog);
- makes no other network requests;
- reads no workspace files or Antigravity files;
- has no runtime third-party dependencies.

The access token is kept in memory only and is never written to disk or shown in the UI.
