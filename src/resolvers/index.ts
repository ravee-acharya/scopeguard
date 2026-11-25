/**
 * Resolver functions called from the UI Kit frontends via `invoke()`.
 *
 * Security: the issue key / project come from the *trusted* Forge context
 * (req.context.extension), never from the client payload, and every write is
 * gated by a Jira permission check run as the current user.
 */
import Resolver from '@forge/resolver';
import {
  listActiveSprints,
  listScrumBoards,
  listSprintIssues,
  readIssueSprints,
  readStoryPoints,
  resolveFields,
  getIssue,
  userHasAnyPermission,
  type SprintDetails,
} from '../lib/jira';
import { computeMetrics, validateJustification, validateSettings } from '../lib/logic';
import { ensureBaseline } from '../lib/scopeService';
import { getRecord, getSettings, listRecords, saveRecord, saveSettings } from '../lib/storage';
import type {
  DashboardResponse,
  DashboardRow,
  IssuePanelState,
  ProjectSettings,
  SprintSummary,
} from '../lib/types';

const SETTINGS_PERMISSIONS = ['ADMINISTER_PROJECTS', 'MANAGE_SPRINTS_PERMISSION'];

interface ForgeContext {
  accountId?: string;
  extension?: {
    issue?: { key?: string; id?: string };
    project?: { id?: string; key?: string };
  };
}

class UserError extends Error {}

function issueKeyFrom(ctx: ForgeContext): string {
  const key = ctx.extension?.issue?.key;
  if (!key) throw new UserError('This panel must be opened from a Jira issue.');
  return key;
}

function projectFrom(ctx: ForgeContext): { id: string; key: string } {
  const p = ctx.extension?.project;
  if (!p?.id || !p.key) throw new UserError('This page must be opened from a Jira project.');
  return { id: String(p.id), key: p.key };
}

const toSummary = ({ startedAt: _ignored, ...s }: SprintDetails): SprintSummary => s;

// ---------- Issue panel ----------

async function issueStatus(issueKey: string): Promise<IssuePanelState> {
  const { sprintFieldId } = await resolveFields();
  if (!sprintFieldId) return { kind: 'NO_SPRINT_FIELD' };

  const issue = await getIssue(issueKey, ['project', sprintFieldId]);
  const projectId = issue.fields.project?.id;
  if (!projectId || !(await getSettings(projectId)).enabled) return { kind: 'DISABLED' };

  const activeSprints = readIssueSprints(issue.fields, sprintFieldId).filter((s) => s.state === 'active');
  if (activeSprints.length === 0) return { kind: 'NOT_IN_ACTIVE_SPRINT' };

  for (const sprint of activeSprints) {
    const record = await getRecord(sprint.id, issue.key);
    if (record && !record.removedAt) {
      const canEdit = await userHasAnyPermission(['EDIT_ISSUES'], { issueKey: issue.key });
      return { kind: 'FLAGGED', sprint, record, canEdit };
    }
  }
  return { kind: 'COMMITTED', sprint: activeSprints[0] };
}

// ---------- Project dashboard ----------

async function buildDashboard(project: { id: string; key: string }, requestedSprintId?: number): Promise<DashboardResponse> {
  const [settings, canConfigure] = await Promise.all([
    getSettings(project.id),
    userHasAnyPermission(SETTINGS_PERMISSIONS, { projectKey: project.key }),
  ]);

  if (!settings.enabled) return { kind: 'DISABLED', settings, canConfigure };

  const boards = await listScrumBoards(project.key);
  if (boards.length === 0) return { kind: 'NO_SCRUM_BOARD', settings, canConfigure };

  const sprintById = new Map<number, SprintDetails>();
  for (const board of boards) {
    for (const sprint of await listActiveSprints(board.id)) sprintById.set(sprint.id, sprint);
  }
  const sprints = [...sprintById.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (sprints.length === 0) return { kind: 'NO_ACTIVE_SPRINT', settings, canConfigure };

  const selected = sprints.find((s) => s.id === requestedSprintId) ?? sprints[0];
  const fieldConfig = await resolveFields();

  const [records, issues] = await Promise.all([
    listRecords(selected.id),
    listSprintIssues(selected.id, ['summary', ...fieldConfig.storyPointFieldIds]),
  ]);
  const baseline = await ensureBaseline(selected.id, fieldConfig, records.map((r) => r.issueKey));

  const livePoints = new Map<string, number | null>();
  for (const issue of issues) livePoints.set(issue.key, readStoryPoints(issue.fields, fieldConfig));

  const flaggedKeys = new Set(records.map((r) => r.issueKey));
  const committedPoints = Object.entries(baseline.committed)
    .filter(([key]) => !flaggedKeys.has(key))
    .reduce((sum, [, points]) => sum + (points ?? 0), 0);

  const metrics = computeMetrics(records, livePoints, committedPoints, issues.length);

  const rows: DashboardRow[] = records
    .map((r) => ({
      issueKey: r.issueKey,
      summary: r.summary,
      storyPoints: livePoints.has(r.issueKey) ? livePoints.get(r.issueKey)! : r.storyPoints,
      addedByAccountId: r.addedByAccountId,
      timestamp: r.timestamp,
      status: r.status,
      reason: r.reason,
      justification: r.justification,
      removed: Boolean(r.removedAt),
    }))
    .sort((a, b) => Number(a.removed) - Number(b.removed) || b.timestamp.localeCompare(a.timestamp));

  return {
    kind: 'OK',
    settings,
    canConfigure,
    sprints: sprints.map(toSummary),
    selectedSprint: toSummary(selected),
    metrics,
    rows,
  };
}

// ---------- Definitions ----------

const resolver = new Resolver();

/** Wrap a resolver so expected errors reach the UI as `{ error }` instead of a crash. */
function safe<T>(fn: (payload: Record<string, unknown>, ctx: ForgeContext) => Promise<T>) {
  return async (req: { payload: unknown; context: unknown }): Promise<T | { error: string }> => {
    try {
      return await fn((req.payload ?? {}) as Record<string, unknown>, req.context as ForgeContext);
    } catch (err) {
      if (err instanceof UserError) return { error: err.message };
      // Everything else (including Forge's "user consent required" error, which
      // the platform turns into an "Allow access" prompt) is rethrown untouched.
      console.error('[ScopeGuard] resolver error', err);
      throw err;
    }
  };
}

resolver.define(
  'getIssueStatus',
  safe(async (_payload, ctx) => issueStatus(issueKeyFrom(ctx))),
);

resolver.define(
  'submitJustification',
  safe(async (payload, ctx) => {
    const issueKey = issueKeyFrom(ctx);
    const parsed = validateJustification(payload);
    if (!parsed.ok) throw new UserError(parsed.error);

    const record = await getRecord(parsed.value.sprintId, issueKey);
    if (!record) throw new UserError('This issue is not tracked as a mid-sprint addition.');
    if (!(await userHasAnyPermission(['EDIT_ISSUES'], { issueKey }))) {
      throw new UserError('You need permission to edit this issue to record a scope change reason.');
    }

    await saveRecord({
      ...record,
      status: 'JUSTIFIED',
      reason: parsed.value.reason,
      justification: parsed.value.justification || null,
      justifiedByAccountId: ctx.accountId ?? null,
      justifiedAt: new Date().toISOString(),
    });
    return issueStatus(issueKey);
  }),
);

resolver.define(
  'getDashboard',
  safe(async (payload, ctx) => {
    const sprintId = Number(payload.sprintId);
    return buildDashboard(projectFrom(ctx), Number.isInteger(sprintId) ? sprintId : undefined);
  }),
);

resolver.define(
  'saveSettings',
  safe(async (payload, ctx): Promise<ProjectSettings> => {
    const project = projectFrom(ctx);
    const parsed = validateSettings(payload);
    if (!parsed.ok) throw new UserError(parsed.error);
    if (!(await userHasAnyPermission(SETTINGS_PERMISSIONS, { projectKey: project.key }))) {
      throw new UserError('Only project admins or users who can manage sprints can change ScopeGuard settings.');
    }
    await saveSettings(project.id, parsed.value);
    return parsed.value;
  }),
);

export const handler = resolver.getDefinitions();
