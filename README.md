# Project Tracking Dashboard

A weekly internal dashboard that unifies three data sources into one view —
tracking **budget vs. planned hours**, **monthly revenue recognition**, and
**missing/late invoicing** per project.

All three sources join on **`deal_id`** (the PipeDrive deal id shared across systems):

- **PipeDrive — sales pipeline** → deal data (contract value, sold hours)
- **ClickUp** → project execution (planned vs. logged hours, % complete)
- **PipeDrive — invoicing pipeline** → invoice amounts and status

Data refreshes **once weekly, Sunday 01:00 UTC**, via a scheduled Azure Function.
Business logic lives in PostgreSQL; the app layer is intentionally thin.

---

## Architecture

| Layer | Technology |
|---|---|
| Database | Azure Database for PostgreSQL Flexible Server — Burstable **B1ms**, **PG 16**, 32 GiB |
| Scheduled sync + read API | Azure Functions (Node 20, TypeScript, **v4 isolated model**) |
| Frontend | Azure Static Web Apps (**Standard**) — React + Vite + TypeScript |
| Auth | Entra ID (built into SWA Standard) |
| Secrets | Azure Key Vault (Managed Identity, no keys in code) |
| Monitoring | Application Insights + Log Analytics |
| IaC | Bicep (`infra/main.bicep`) |
| CI/CD | GitHub Actions (auto-deploy on push to `main`) |

```
deals ─┐
       ├─(deal_id)─> projects ─> project_tasks
invoices┘                      ╲
                                ╲─> revenue_recognition ─> weekly_snapshots
```

Target cost: **~$25/month** (mostly DB + SWA Standard).

---

## Repository layout

```
infra/   main.bicep + parameters        — all Azure resources
db/      schema.sql + seed.sql           — tables, views, functions, sample data
api/     Azure Functions (sync + read)   — TypeScript, pg (no ORM)
web/     React SPA                        — dashboard UI
.github/workflows/                        — deploy-web.yml, deploy-api.yml
```

---

## 1. One-time setup (in order)

### 1.1 Provision infrastructure

```bash
az group create -n rg-project-tracker -l eastus

# Edit infra/main.parameters.json (set a strong dbAdminPassword) — do NOT commit it.
az deployment group create \
  -g rg-project-tracker \
  -f infra/main.bicep \
  -p @infra/main.parameters.json

# Note the outputs: functionAppName, staticWebAppHostname, keyVaultUri,
# postgresFqdn, databaseName.
```

### 1.2 Push secrets to Key Vault

Grant yourself **Key Vault Secrets Officer** on the vault first, then:

```bash
KV=<keyVaultName>   # from the keyVaultUri output

az keyvault secret set --vault-name $KV --name pipedrive-token   --value "<PIPEDRIVE_API_TOKEN>"
az keyvault secret set --vault-name $KV --name clickup-token     --value "<CLICKUP_API_TOKEN>"
az keyvault secret set --vault-name $KV --name clickup-team-id   --value "<CLICKUP_TEAM_ID>"

# Build the connection string from the outputs (sslmode=require is mandatory):
az keyvault secret set --vault-name $KV --name db-connection-string \
  --value "postgres://pgadmin:<PASSWORD>@<postgresFqdn>:5432/projecttracker?sslmode=require"
```

The Function App reads these at cold start via its system-assigned Managed
Identity (granted **Key Vault Secrets User** in the Bicep).

### 1.3 Apply the database schema

```bash
psql "host=<postgresFqdn> port=5432 dbname=projecttracker user=pgadmin sslmode=require" \
  -f db/schema.sql

# Optional: sample data so the dashboard renders before the first real sync.
psql "host=<postgresFqdn> port=5432 dbname=projecttracker user=pgadmin sslmode=require" \
  -f db/seed.sql
```

### 1.4 Set the custom-field keys in code

Two constants must be filled in before the first sync, then committed:

- `api/src/shared/pipedrive.ts` → `SOLD_HOURS_FIELD` (PipeDrive custom-field hash),
  and `INVOICING_PIPELINE_ID` (your invoicing pipeline id).
- `api/src/shared/clickup.ts` → `DEAL_ID_FIELD` (ClickUp custom-field id holding
  the PipeDrive deal id).

> Finding the PipeDrive field key: Settings → Data fields → click the field; the
> 40-char key is in the URL/API. Finding the ClickUp field id: `GET /list/{id}/field`.

### 1.5 Configure GitHub secrets & deploy

Add these repository secrets (Settings → Secrets and variables → Actions):

| Secret | Used by | Value |
|---|---|---|
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | deploy-web | SWA deploy token (`az staticwebapp secrets list`) |
| `VITE_API_BASE` | deploy-web | `https://<functionAppHostname>/api` |
| `AZURE_FUNCTIONAPP_NAME` | deploy-api | `functionAppName` output |
| `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` | deploy-api | Function App → Get publish profile |

Then push to `main` — both workflows run on their respective path filters
(`web/**` and `api/**`).

### 1.6 Configure Entra ID auth on the SWA

In `web/staticwebapp.config.json`, replace `<TENANT_ID>` and register an Entra ID
app. Add the SWA application settings `AAD_CLIENT_ID` and `AAD_CLIENT_SECRET`
(SWA → Configuration). Standard tier required for custom Entra registration.

### 1.7 Lock the Function App CORS to the SWA origin

After the SWA hostname is known, set the Function App app setting
`ALLOWED_ORIGIN=https://<staticWebAppHostname>` and `REQUIRE_AUTH=true`.

---

## 2. The failure alert (do not skip — a silent weekly failure is the #1 risk)

Create a metric alert in Azure Monitor on the **Function App**:

- **Scope:** the Function App resource.
- **Condition A (errors):** signal **Function Execution Count** filtered to
  `FunctionName = syncWeekly` with a custom log-based alert, OR signal
  **Exceptions** (Application Insights) `count > 0` over the last 6 hours,
  evaluated every hour, **on Sundays**.
- **Condition B (missed run):** a log-search alert (App Insights) —
  ```kusto
  requests
  | where name == "syncWeekly"
  | where timestamp > ago(1d)
  | summarize runs = count()
  ```
  Alert if `runs == 0` evaluated Monday 03:00 UTC (i.e. the Sunday run never fired).
- **Action group:** email `nicolas.alvarez@sisuadigital.com`.

---

## 3. When the alert fires

1. Query the `sync_log` table for the latest `failed` row and its `error_detail`:
   ```sql
   SELECT source, status, error_detail, started_at, finished_at
   FROM sync_log ORDER BY started_at DESC LIMIT 20;
   ```
2. Common causes & fixes:
   - **Expired API token** → rotate the value in Key Vault
     (`az keyvault secret set ...`); no redeploy needed (read at cold start, so
     restart the Function App to clear the cache).
   - **PipeDrive/ClickUp schema change** → fix the field mapping constants in
     `api/src/shared/*.ts` and redeploy.
   - **`finalize_week` returned `ABORTED…`** → fewer than 3 sources succeeded in
     the last 6h; the week was intentionally **not** snapshotted. Fix the failing
     source and re-run (see §4) — the guard prevents half-loaded weeks.
3. Re-run manually: in the Azure portal, **Function App → syncWeekly → Code+Test
   → Test/Run**, or `func azure functionapp ...`. The job is idempotent, so
   re-running never duplicates rows.

---

## 4. Backfill historical weeks

The trend view needs prior snapshots. Options:

- **Quick (recommended):** run the seed (`db/seed.sql`) which fabricates three
  trailing weekly snapshots per project.
- **Real backfill:** for each historical Monday, set the project state to that
  week's values and call `finalize_week()` with the clock adjusted. Since
  `finalize_week()` keys on `current_date`, the simplest approach is a one-off
  SQL script that directly inserts `weekly_snapshots` and `revenue_recognition`
  rows for past `week_start`/`period_month` values (mirroring the math in
  `finalize_week()`), respecting the Monday CHECK and unique keys.

---

## 5. Local development

```bash
# API
cd api
cp local.settings.json.example local.settings.json   # fill in DB + tokens
npm install
npm start          # func start — runs the HTTP endpoints locally

# Web
cd web
npm install
VITE_API_BASE=http://localhost:7071/api npm run dev   # http://localhost:5173
```

Locally, secrets resolve from `local.settings.json` env vars (no Key Vault
needed). `REQUIRE_AUTH` defaults off locally so endpoints are reachable without
the SWA principal header.

---

## 6. Cost note

~**$25/month** at the default sizing (B1ms DB + SWA Standard + Consumption
Functions + minimal App Insights). Switching the B1ms to a **1-year reserved
instance** drops the DB cost and brings the total to **~$18/month**.

---

## 7. Conventions

- **Idempotent everything** — every external write is an upsert on the source id.
- **`deal_id` is sacred** — the join key flows through every PipeDrive/ClickUp mapping.
- **Business logic in the DB** — the API only `SELECT`s from `v_*` views and
  `f_week_over_week()`; recognition/snapshot math lives in `finalize_week()`.
- **No secrets in code or git** — all tokens via Key Vault + Managed Identity.
- **PostgreSQL 16** (not 17). **Schedule is UTC** (`0 0 1 * * 0`); offset in the
  timer if local Sunday-1am is required.
- TypeScript strict mode on; minimal dependencies.
```
