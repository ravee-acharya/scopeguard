/**
 * Forge trigger for `avi:jira:updated:issue` and `avi:jira:created:issue`.
 *
 * Updated: reads the changelog for a Sprint field change and diffs the sprint
 *          id lists ("12, 34" → "12, 34, 56") to find sprints the issue joined
 *          or left.
 * Created: issues created straight into an active sprint are shadow work too,
 *          so we read the issue's Sprint field directly.
 */
import { diffSprintIds } from '../lib/logic';
import { getIssue, readIssueSprints, resolveFields } from '../lib/jira';
import { processSprintChange } from '../lib/scopeService';

interface ChangelogItem {
  field: string;
  fieldId?: string;
  fieldtype?: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
}

export interface IssueEvent {
  eventType: 'avi:jira:updated:issue' | 'avi:jira:created:issue' | string;
  issue: { id: string; key: string };
  /** Account id of the user who made the change. */
  atlassianId?: string;
  changelog?: { id: string; items: ChangelogItem[] };
}

export async function handler(event: IssueEvent): Promise<void> {
  try {
    if (event.eventType === 'avi:jira:created:issue') {
      await onCreated(event);
    } else {
      await onUpdated(event);
    }
  } catch (err) {
    // Never throw: Forge would retry and we could double-comment.
    console.error(`[ScopeGuard] Failed to process ${event.eventType} for ${event.issue?.key}`, err);
  }
}

async function onUpdated(event: IssueEvent): Promise<void> {
  const items = event.changelog?.items ?? [];
  const sprintItems = items.filter((i) => i.field === 'Sprint' || i.fieldId?.startsWith('customfield_'));
  if (sprintItems.length === 0) return;

  // Custom field ids differ per site; confirm against the discovered Sprint field.
  const { sprintFieldId } = await resolveFields();
  const changes = sprintItems.filter((i) => i.field === 'Sprint' || (sprintFieldId && i.fieldId === sprintFieldId));
  if (changes.length === 0) return;

  const added = new Set<number>();
  const removed = new Set<number>();
  for (const item of changes) {
    const diff = diffSprintIds(item.from, item.to);
    diff.added.forEach((id) => added.add(id));
    diff.removed.forEach((id) => removed.add(id));
  }

  await processSprintChange({
    issueIdOrKey: event.issue.id,
    addedSprintIds: [...added],
    removedSprintIds: [...removed],
    actorAccountId: event.atlassianId ?? null,
    now: new Date(),
  });
}

async function onCreated(event: IssueEvent): Promise<void> {
  const { sprintFieldId } = await resolveFields();
  if (!sprintFieldId) return;
  const issue = await getIssue(event.issue.id, [sprintFieldId]);
  const activeSprintIds = readIssueSprints(issue.fields, sprintFieldId)
    .filter((s) => s.state === 'active')
    .map((s) => s.id);
  if (activeSprintIds.length === 0) return;

  await processSprintChange({
    issueIdOrKey: event.issue.id,
    addedSprintIds: activeSprintIds,
    removedSprintIds: [],
    actorAccountId: event.atlassianId ?? null,
    now: new Date(),
  });
}
