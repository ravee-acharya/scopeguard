/**
 * Orchestrates detection: combines Jira lookups, pure rules and storage.
 * Used by the issue trigger; baseline helpers are shared with the dashboard.
 */
import {
  addLabel,
  addScopeCreepComment,
  getIssue,
  getSprint,
  listSprintIssues,
  readStoryPoints,
  resolveFields,
} from './jira';
import { evaluateAddition } from './logic';
import { getBaseline, getRecord, getSettings, listRecords, saveBaseline, saveRecord, type FieldConfig } from './storage';
import type { ScopeCreepRecord, SprintBaseline } from './types';

const log = (msg: string, extra?: unknown) => console.log(`[ScopeGuard] ${msg}`, extra ?? '');

export interface SprintChange {
  issueIdOrKey: string;
  addedSprintIds: number[];
  removedSprintIds: number[];
  actorAccountId: string | null;
  now: Date;
}

/** Entry point for both "issue updated" (changelog) and "issue created" events. */
export async function processSprintChange(change: SprintChange): Promise<void> {
  if (change.addedSprintIds.length === 0 && change.removedSprintIds.length === 0) return;

  const fieldConfig = await resolveFields();
  if (!fieldConfig.sprintFieldId) {
    log('No Sprint field on this site (Jira Software not enabled?) - skipping.');
    return;
  }

  const issue = await getIssue(change.issueIdOrKey, [
    'summary',
    'project',
    fieldConfig.sprintFieldId,
    ...fieldConfig.storyPointFieldIds,
  ]);

  for (const sprintId of change.removedSprintIds) {
    await markRemoved(sprintId, issue.key, change.now);
  }
  if (change.addedSprintIds.length === 0) return;

  const projectId = issue.fields.project?.id;
  if (!projectId) return;
  const settings = await getSettings(projectId);
  if (!settings.enabled) return; // ScopeGuard is opt-in per project.

  for (const sprintId of change.addedSprintIds) {
    const sprint = await getSprint(sprintId);
    if (!sprint) continue;

    const verdict = evaluateAddition(sprint, change.now, settings.graceHours);
    if (!verdict.isScopeCreep) {
      log(`${issue.key} → sprint ${sprintId}: not scope creep (${verdict.reason}).`);
      continue;
    }

    const existing = await getRecord(sprintId, issue.key);
    if (existing && !existing.removedAt) {
      log(`${issue.key} already tracked for sprint ${sprintId} (duplicate event).`);
      continue;
    }

    // Capture the committed baseline before this issue becomes part of it.
    await ensureBaseline(sprintId, fieldConfig, [issue.key]);

    const record: ScopeCreepRecord = existing
      ? // Re-added after removal: reactivate but keep any earlier justification.
        { ...existing, removedAt: null, timestamp: change.now.toISOString(), hoursAfterStart: verdict.hoursAfterStart }
      : {
          sprintId,
          issueId: issue.id,
          issueKey: issue.key,
          summary: issue.fields.summary ?? '',
          storyPoints: readStoryPoints(issue.fields, fieldConfig),
          addedByAccountId: change.actorAccountId,
          timestamp: change.now.toISOString(),
          hoursAfterStart: verdict.hoursAfterStart,
          status: 'NEEDS_JUSTIFICATION',
          reason: null,
          justification: null,
          justifiedByAccountId: null,
          justifiedAt: null,
          removedAt: null,
        };
    await saveRecord(record);
    log(`Flagged ${issue.key} as scope creep in sprint ${sprintId} (+${verdict.hoursAfterStart}h).`);

    // Side effects are best-effort: a missing permission must not lose the record.
    if (settings.autoLabel && !(issue.fields.labels ?? []).includes(settings.labelName)) {
      await addLabel(issue.key, settings.labelName).catch((e) => log(`Label failed for ${issue.key}`, String(e)));
    }
    if (settings.postComment && !existing && record.status === 'NEEDS_JUSTIFICATION') {
      await addScopeCreepComment(issue.key, change.actorAccountId, settings.graceHours).catch((e) =>
        log(`Comment failed for ${issue.key}`, String(e)),
      );
    }
  }
}

async function markRemoved(sprintId: number, issueKey: string, now: Date): Promise<void> {
  const record = await getRecord(sprintId, issueKey);
  if (record && !record.removedAt) {
    await saveRecord({ ...record, removedAt: now.toISOString() });
    log(`${issueKey} left sprint ${sprintId}; record marked removed.`);
  }
}

/**
 * Returns the sprint baseline, capturing it from the sprint's current
 * contents if it does not exist yet. `excludeKeys` are known unplanned issues
 * that must never count as committed.
 */
export async function ensureBaseline(
  sprintId: number,
  fieldConfig: FieldConfig,
  excludeKeys: string[] = [],
): Promise<SprintBaseline> {
  const existing = await getBaseline(sprintId);
  if (existing) return existing;

  const [issues, records] = await Promise.all([
    listSprintIssues(sprintId, ['summary', ...fieldConfig.storyPointFieldIds]),
    listRecords(sprintId),
  ]);
  const exclude = new Set([...excludeKeys, ...records.map((r) => r.issueKey)]);
  const committed: Record<string, number | null> = {};
  for (const issue of issues) {
    if (!exclude.has(issue.key)) committed[issue.key] = readStoryPoints(issue.fields, fieldConfig);
  }
  const baseline: SprintBaseline = { sprintId, capturedAt: new Date().toISOString(), committed };
  await saveBaseline(baseline);
  return baseline;
}
