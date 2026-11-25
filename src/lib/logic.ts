/**
 * Pure, side-effect-free business rules. Everything here is unit tested
 * (test/logic.test.ts) and has no Forge imports.
 */
import {
  DEFAULT_SETTINGS,
  JUSTIFICATION_MAX_LENGTH,
  SCOPE_CHANGE_REASONS,
  type DashboardMetrics,
  type ProjectSettings,
  type ScopeChangeReason,
  type ScopeCreepRecord,
  type SubmitJustificationPayload,
} from './types';

const HOUR_MS = 60 * 60 * 1000;

/** Jira changelog sprint values look like "12, 34" (or null/""). */
export function parseSprintIds(value: string | null | undefined): number[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Sprint ids present in `to` but not in `from` (added) and vice versa (removed). */
export function diffSprintIds(
  from: string | null | undefined,
  to: string | null | undefined,
): { added: number[]; removed: number[] } {
  const before = new Set(parseSprintIds(from));
  const after = new Set(parseSprintIds(to));
  return {
    added: [...after].filter((id) => !before.has(id)),
    removed: [...before].filter((id) => !after.has(id)),
  };
}

export interface AdditionVerdict {
  isScopeCreep: boolean;
  hoursAfterStart: number;
  reason: 'NOT_ACTIVE' | 'NO_START_DATE' | 'WITHIN_GRACE' | 'AFTER_GRACE';
}

/**
 * Decide whether adding an issue to `sprint` at `now` counts as scope creep.
 * `startedAt` should be the moment the sprint was actually started
 * (activatedDate), falling back to the planned startDate.
 */
export function evaluateAddition(
  sprint: { state: string; startedAt: string | null },
  now: Date,
  graceHours: number,
): AdditionVerdict {
  if (sprint.state !== 'active') return { isScopeCreep: false, hoursAfterStart: 0, reason: 'NOT_ACTIVE' };
  const start = sprint.startedAt ? Date.parse(sprint.startedAt) : Number.NaN;
  if (Number.isNaN(start)) return { isScopeCreep: false, hoursAfterStart: 0, reason: 'NO_START_DATE' };
  const hoursAfterStart = (now.getTime() - start) / HOUR_MS;
  const isScopeCreep = hoursAfterStart > graceHours;
  return {
    isScopeCreep,
    hoursAfterStart: Math.round(hoursAfterStart * 100) / 100,
    reason: isScopeCreep ? 'AFTER_GRACE' : 'WITHIN_GRACE',
  };
}

/** Accepts numbers, numeric strings, null/undefined. Anything else → null. */
export function toStoryPoints(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Jira label rules: no whitespace, max 255 chars.
const LABEL_RE = /^[^\s]{1,255}$/;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateSettings(input: unknown): ValidationResult<ProjectSettings> {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Settings payload is missing.' };
  const raw = input as Record<string, unknown>;
  const graceHours = Number(raw.graceHours);
  if (!Number.isFinite(graceHours) || graceHours < 0 || graceHours > 336) {
    return { ok: false, error: 'Grace period must be between 0 and 336 hours.' };
  }
  const labelName = typeof raw.labelName === 'string' ? raw.labelName.trim() : DEFAULT_SETTINGS.labelName;
  if (!LABEL_RE.test(labelName)) {
    return { ok: false, error: 'Label must be 1-255 characters with no spaces.' };
  }
  return {
    ok: true,
    value: {
      enabled: raw.enabled === true,
      graceHours: Math.round(graceHours * 100) / 100,
      autoLabel: raw.autoLabel === true,
      labelName,
      postComment: raw.postComment === true,
    },
  };
}

/** Merge whatever is stored with defaults so older/partial records stay valid. */
export function withDefaults(stored: Partial<ProjectSettings> | undefined | null): ProjectSettings {
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export function isScopeChangeReason(value: unknown): value is ScopeChangeReason {
  return typeof value === 'string' && (SCOPE_CHANGE_REASONS as readonly string[]).includes(value);
}

export function validateJustification(input: unknown): ValidationResult<SubmitJustificationPayload> {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Payload is missing.' };
  const raw = input as Record<string, unknown>;
  const sprintId = Number(raw.sprintId);
  if (!Number.isInteger(sprintId) || sprintId <= 0) return { ok: false, error: 'Invalid sprint.' };
  if (!isScopeChangeReason(raw.reason)) return { ok: false, error: 'Pick a scope change reason.' };
  const justification = typeof raw.justification === 'string' ? raw.justification.trim() : '';
  if (justification.length > JUSTIFICATION_MAX_LENGTH) {
    return { ok: false, error: `Justification must be ${JUSTIFICATION_MAX_LENGTH} characters or fewer.` };
  }
  if (raw.reason === 'OTHER' && justification.length === 0) {
    return { ok: false, error: 'Please explain the reason when choosing "Other".' };
  }
  return { ok: true, value: { sprintId, reason: raw.reason, justification } };
}

/**
 * Compute the dashboard KPIs.
 * @param records       every ScopeGuard record for the sprint
 * @param livePoints    current story points per issue key in the sprint (null = unestimated)
 * @param committedPoints story points of the planned (non-flagged) work
 */
export function computeMetrics(
  records: ScopeCreepRecord[],
  livePoints: Map<string, number | null>,
  committedPoints: number,
  totalIssuesInSprint: number,
): DashboardMetrics {
  const active = records.filter((r) => !r.removedAt);
  let unplannedPoints = 0;
  let unestimated = 0;
  const counts = new Map<ScopeChangeReason | 'UNCATEGORIZED', number>();

  for (const r of active) {
    const points = livePoints.has(r.issueKey) ? livePoints.get(r.issueKey)! : r.storyPoints;
    if (points == null) unestimated += 1;
    else unplannedPoints += points;
    const bucket = r.reason ?? 'UNCATEGORIZED';
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  let topCategory: ScopeChangeReason | null = null;
  let topCategoryCount = 0;
  for (const [reason, count] of counts) {
    if (reason !== 'UNCATEGORIZED' && count > topCategoryCount) {
      topCategory = reason;
      topCategoryCount = count;
    }
  }

  const categoryBreakdown = [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    unplannedCount: active.length,
    unplannedPoints: round1(unplannedPoints),
    unestimatedUnplannedCount: unestimated,
    committedPoints: round1(committedPoints),
    capacityAbsorbedPct: committedPoints > 0 ? Math.round((unplannedPoints / committedPoints) * 100) : null,
    unplannedIssueRatioPct:
      totalIssuesInSprint > 0 ? Math.round((active.length / totalIssuesInSprint) * 100) : null,
    needsJustificationCount: active.filter((r) => r.status === 'NEEDS_JUSTIFICATION').length,
    topCategory,
    topCategoryCount,
    categoryBreakdown,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
