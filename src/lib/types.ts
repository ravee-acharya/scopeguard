/**
 * Shared domain types. This file must stay free of runtime imports so the
 * UI Kit bundles (src/frontend/*) can import it safely.
 */

export const SCOPE_CHANGE_REASONS = [
  'PRODUCTION_BUG',
  'STAKEHOLDER_ESCALATION',
  'MISSED_DEPENDENCY',
  'UNDERESTIMATED_SUBTASK',
  'OTHER',
] as const;

export type ScopeChangeReason = (typeof SCOPE_CHANGE_REASONS)[number];

export const REASON_LABELS: Record<ScopeChangeReason, string> = {
  PRODUCTION_BUG: 'Production Bug / Hotfix',
  STAKEHOLDER_ESCALATION: 'Stakeholder Escalation',
  MISSED_DEPENDENCY: 'Missed Dependency',
  UNDERESTIMATED_SUBTASK: 'Underestimated Sub-task',
  OTHER: 'Other',
};

export const JUSTIFICATION_MAX_LENGTH = 500;

export type ScopeRecordStatus = 'NEEDS_JUSTIFICATION' | 'JUSTIFIED';

/** One mid-sprint addition. Stored under `sprint-scope-{sprintId}:{issueKey}`. */
export interface ScopeCreepRecord {
  sprintId: number;
  issueId: string;
  issueKey: string;
  summary: string;
  /** Story points at the time the issue was added; null when unestimated. */
  storyPoints: number | null;
  /** Account that moved the issue into the sprint (null if Jira did not tell us). */
  addedByAccountId: string | null;
  /** ISO timestamp of when ScopeGuard detected the addition. */
  timestamp: string;
  /** How long after sprint start the issue arrived, in hours. */
  hoursAfterStart: number;
  status: ScopeRecordStatus;
  reason: ScopeChangeReason | null;
  justification: string | null;
  justifiedByAccountId: string | null;
  justifiedAt: string | null;
  /** Set when the issue later leaves the sprint; excluded from metrics. */
  removedAt: string | null;
}

/**
 * Committed scope, captured lazily the first time ScopeGuard needs it for a
 * sprint (first flagged issue or first dashboard view). Story points per issue
 * key at capture time; null = unestimated. Keys that are (or later become)
 * flagged are subtracted at read time, which keeps the baseline correct even
 * when many issues are bulk-moved into the sprint concurrently.
 */
export interface SprintBaseline {
  sprintId: number;
  capturedAt: string;
  committed: Record<string, number | null>;
}

export interface ProjectSettings {
  /**
   * Master switch. Off by default: ScopeGuard ignores a project until someone
   * turns it on from that project's ScopeGuard page.
   */
  enabled: boolean;
  /** Hours after sprint start during which additions are still "planned". */
  graceHours: number;
  autoLabel: boolean;
  labelName: string;
  /** Post a comment asking the person who added the issue for a reason. */
  postComment: boolean;
}

/** Everything is opt-in per project. */
export const DEFAULT_SETTINGS: ProjectSettings = {
  enabled: false,
  graceHours: 2,
  autoLabel: false,
  labelName: 'scope-creep',
  postComment: false,
};

export interface SprintSummary {
  id: number;
  name: string;
  state: 'active' | 'closed' | 'future';
  startDate: string | null;
  endDate: string | null;
  boardId: number | null;
}

// ---------- Resolver payloads / responses ----------

export type IssuePanelState =
  | { kind: 'NO_SPRINT_FIELD' }
  | { kind: 'DISABLED' }
  | { kind: 'NOT_IN_ACTIVE_SPRINT' }
  | { kind: 'COMMITTED'; sprint: SprintSummary }
  | { kind: 'FLAGGED'; sprint: SprintSummary; record: ScopeCreepRecord; canEdit: boolean };

export interface SubmitJustificationPayload {
  sprintId: number;
  reason: ScopeChangeReason;
  justification: string;
}

export interface DashboardRow {
  issueKey: string;
  summary: string;
  storyPoints: number | null;
  addedByAccountId: string | null;
  timestamp: string;
  status: ScopeRecordStatus;
  reason: ScopeChangeReason | null;
  justification: string | null;
  removed: boolean;
}

export interface DashboardMetrics {
  unplannedCount: number;
  unplannedPoints: number;
  unestimatedUnplannedCount: number;
  committedPoints: number;
  /** unplannedPoints / committedPoints * 100, null when nothing was committed. */
  capacityAbsorbedPct: number | null;
  /** Share of all sprint issues that were unplanned, 0-100. */
  unplannedIssueRatioPct: number | null;
  needsJustificationCount: number;
  topCategory: ScopeChangeReason | null;
  topCategoryCount: number;
  categoryBreakdown: { reason: ScopeChangeReason | 'UNCATEGORIZED'; count: number }[];
}

export type DashboardResponse =
  | { kind: 'DISABLED'; settings: ProjectSettings; canConfigure: boolean }
  | { kind: 'NO_SCRUM_BOARD'; settings: ProjectSettings; canConfigure: boolean }
  | { kind: 'NO_ACTIVE_SPRINT'; settings: ProjectSettings; canConfigure: boolean }
  | {
      kind: 'OK';
      settings: ProjectSettings;
      canConfigure: boolean;
      sprints: SprintSummary[];
      selectedSprint: SprintSummary;
      metrics: DashboardMetrics;
      rows: DashboardRow[];
    };
