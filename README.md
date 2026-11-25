# ScopeGuard: Shadow Work & Scope Creep Guardrail for Jira Cloud

ScopeGuard is a Forge app (UI Kit, TypeScript). It catches issues that are pulled into an **active sprint after it started** and asks for a reason for each one. A project dashboard then shows how much capacity this unplanned work used up.

## How it works

| Piece | What it does |
|---|---|
| **Trigger** (`avi:jira:updated:issue`, `avi:jira:created:issue`) | Compares the Sprint values in the changelog (`"12" → "12, 34"`) to find the sprints an issue joined. It loads each sprint from `/rest/agile/1.0/sprint/{id}`. If the sprint is `active` and the issue arrived after `startedAt + grace`, it saves a record, adds the `scope-creep` label and posts a comment that @mentions whoever moved the issue. Issues that are *created* directly inside an active sprint are flagged too. If an issue leaves the sprint, its record is marked `removed`. |
| **Issue panel** | Green **Committed in Sprint Plan** badge, or an **Added Mid-Sprint** warning with a reason form (Production Bug / Hotfix, Stakeholder Escalation, Missed Dependency, Underestimated Sub-task, Other). Saving the form requires the *Edit Issues* permission. |
| **Project page** | Sprint picker, 3 KPI cards (unplanned issues, capacity absorbed vs. commitment, top creep category), a DynamicTable of additions (uncategorized rows are highlighted and shown with a red lozenge), a donut chart of reasons, and a **Settings** tab (enable switch, grace hours, auto-label toggle and label name, comment toggle). **Everything is off by default:** a project is ignored until someone turns ScopeGuard on there, and labels and comments are separate opt-ins. Only *Administer Projects* or *Manage Sprints* holders can change settings. |

### Storage layout (Forge KVS, `@forge/kvs`)

| Key | Value |
|---|---|
| `sprint-scope-{sprintId}:{issueKey}` | `ScopeCreepRecord` (`issueKey`, `summary`, `storyPoints`, `addedByAccountId`, `timestamp`, `reason`, status, …) |
| `sprint-baseline-{sprintId}` | Committed issues and their points, captured the first time ScopeGuard needs the sprint |
| `settings-{projectId}` | `{ graceHours, autoLabel, labelName, postComment }` |
| `field-config` | Discovered Sprint / Story Points custom field ids (cached for 24h) |

There is **one key per issue** instead of one array per sprint. When someone bulk-moves 20 issues into a sprint, 20 triggers run at the same time, and a shared array would lose writes. Records are listed by key prefix. `@forge/kvs` is used because the `storage` export of `@forge/api` is deprecated.

### Edge cases handled
- **No story points:** the issue shows as *Unestimated* and counts as 0 pts. The KPI card shows how many unplanned issues are unestimated. Both the company-managed "Story Points" field and the team-managed "Story point estimate" field are found automatically.
- **Kanban-only projects / no active sprint:** the dashboard shows an empty state, and the issue panel shows "Not in an active sprint".
- **Sites without Jira Software (no Sprint field):** the trigger does nothing and the UI explains why.
- **Duplicate or redelivered events:** the trigger is idempotent and never comments twice. `ignoreSelf` stops the app's own label and comment edits from re-triggering it.
- **Removed, then re-added:** the existing record is reactivated and its earlier justification is kept.
- **Sprint start time:** uses `activatedDate` (when the sprint was actually started) and falls back to the planned `startDate`.
- **Label or comment failures** (for example, the app lacks permission in a project) are logged and don't stop the record from being saved.
- **Commitment baseline:** captured lazily. Flagged keys are subtracted when the baseline is read, so concurrent bulk moves can't inflate it.

## Folder structure

```
scopeguard/
├── manifest.yml
├── package.json
├── tsconfig.json
├── static/icon.svg
├── src/
│   ├── triggers/issueUpdated.ts   # Forge trigger handler (updated + created)
│   ├── resolvers/index.ts         # @forge/resolver: getIssueStatus, submitJustification, getDashboard, saveSettings
│   ├── frontend/
│   │   ├── issuePanel.tsx         # UI Kit issue panel
│   │   ├── projectPage.tsx        # UI Kit Scrum Master dashboard + settings
│   │   └── api.ts                 # typed invoke() wrapper
│   └── lib/
│       ├── types.ts               # shared domain + resolver types (no runtime imports)
│       ├── logic.ts               # pure rules: sprint diff, grace check, validation, metrics
│       ├── jira.ts                # Jira Platform + Agile REST wrappers
│       ├── storage.ts             # KVS repository
│       └── scopeService.ts        # detection orchestration + baseline capture
└── test/logic.test.ts             # vitest unit tests for the pure rules
```

## Run it on a Jira Cloud developer site

Prerequisites: Node 22+, a free developer site (https://go.atlassian.com/cloud-dev) with Jira Software, and an Atlassian API token (https://id.atlassian.com/manage/api-tokens).

```bash
npm install -g @forge/cli@latest
forge login
```

**Option A: use this folder directly (recommended)**

```bash
cd scopeguard
npm install
npm run typecheck
npm test
forge register          # writes your own app id into manifest.yml
forge lint
forge deploy -e development
forge install --site <your-site>.atlassian.net --product jira -e development
```

**Option B: start from `forge create`**

```bash
forge create            # choose: UI Kit → Jira → jira-issue-panel template, name it "scopeguard"
cd scopeguard
# copy manifest.yml (keep the generated app.id), src/, static/, test/, tsconfig.json and package.json over the template
npm install
forge deploy -e development
forge install --site <your-site>.atlassian.net --product jira -e development
```

After changing any `permissions.scopes`, re-deploy and run `forge install --upgrade ...`.

**Live development:** `forge tunnel` runs your local code against the site. Logs go to `forge logs -e development`.

### Smoke test
1. Create a Scrum project and add a few issues to a sprint. Estimate some of them and **start the sprint**.
2. Open **Project → Apps → ScopeGuard → Settings**. Turn on **Enable ScopeGuard**, plus the label and comment toggles if you want them, and set the grace period to `0` hours.
3. Drag a backlog issue into the active sprint (or create a new issue straight into it).
4. Within a few seconds the issue should have the `scope-creep` label and a ScopeGuard comment (if those toggles are on). Its **ScopeGuard** panel should show *Added Mid-Sprint*.
5. Pick a reason and submit. The dashboard row turns from red *Uncategorized* to the chosen reason, and the KPI cards update.
6. Open an issue that was in the sprint before it started. The panel should show the green *Committed in Sprint Plan* badge.

The first time each user opens the panel or the page, Forge asks them to **Allow access**. That consent lets ScopeGuard check their Jira permissions as that user.

## Development

```bash
npm run typecheck
npm test
npm run check        # typecheck + tests + forge lint
```

## Editions and CI/CD

One codebase, two Forge apps:

| Edition | App | Developer space | Manifest | Deployed by |
|---|---|---|---|---|
| **ScopeGuard** (Marketplace) | `a0d4fe36-6fe6-4769-bb22-bf862feb520a` | as registered | `manifest.yml` (committed) | push to `main` → `development`; `release-marketplace.yml` → `production` |
| **ScopeGuard (Dash)** (internal clone) | `a3df4005-bf49-4fea-808a-c75c7d4ada18` | Dash Technologies Inc. | generated from `manifest.yml` by `scripts/make-edition-manifest.mjs` using `editions/dash-internal.json` | push to `main`, **after** the Marketplace deploy succeeds → `production`, installed on dashtech |

The clone differs only in app id and module titles; `test/editions.test.ts` fails the build if anything else drifts. Each app has its own storage, so settings and records are not shared.

**`.github/workflows/deploy.yml`** (push to `main`): `check` → `marketplace` → `dash-internal` (`needs: marketplace`). Pull requests run `check` only.
**`.github/workflows/release-marketplace.yml`** (manual or `v*` tag): Marketplace edition → `production`, gated by the `production` environment.

Repository setup on GitHub:
- Secrets: `FORGE_EMAIL`, `FORGE_API_TOKEN` (an account with access to both apps).
- Environments: `development`, `dash-internal`, `production` (add a required reviewer to `production`).
- Optional variables: `MARKETPLACE_TEST_SITE` (install the Marketplace app on a test site), `DASH_SITE` (defaults to dashtech.atlassian.net).

Generate the Dash manifest locally: `npm run manifest:dash` (overwrites `manifest.yml`; don't commit it).
