import { describe, expect, it } from 'vitest';
import {
  computeMetrics,
  diffSprintIds,
  evaluateAddition,
  parseSprintIds,
  toStoryPoints,
  validateJustification,
  validateSettings,
  withDefaults,
} from '../src/lib/logic';
import type { ScopeCreepRecord } from '../src/lib/types';

const record = (over: Partial<ScopeCreepRecord>): ScopeCreepRecord => ({
  sprintId: 1,
  issueId: '1',
  issueKey: 'SG-1',
  summary: 's',
  storyPoints: null,
  addedByAccountId: null,
  timestamp: '2026-11-10T10:00:00Z',
  hoursAfterStart: 5,
  status: 'NEEDS_JUSTIFICATION',
  reason: null,
  justification: null,
  justifiedByAccountId: null,
  justifiedAt: null,
  removedAt: null,
  ...over,
});

describe('sprint changelog parsing', () => {
  it('parses comma lists and ignores junk', () => {
    expect(parseSprintIds('12, 34')).toEqual([12, 34]);
    expect(parseSprintIds(null)).toEqual([]);
    expect(parseSprintIds('')).toEqual([]);
    expect(parseSprintIds('abc, 5')).toEqual([5]);
  });

  it('diffs added and removed sprints', () => {
    expect(diffSprintIds('1, 2', '2, 3')).toEqual({ added: [3], removed: [1] });
    expect(diffSprintIds(null, '7')).toEqual({ added: [7], removed: [] });
    expect(diffSprintIds('7', null)).toEqual({ added: [], removed: [7] });
  });
});

describe('evaluateAddition', () => {
  const start = '2026-11-10T08:00:00.000Z';
  it('flags additions after the grace period', () => {
    const v = evaluateAddition({ state: 'active', startedAt: start }, new Date('2026-11-10T11:00:00Z'), 2);
    expect(v).toMatchObject({ isScopeCreep: true, reason: 'AFTER_GRACE', hoursAfterStart: 3 });
  });
  it('allows additions within the grace period (boundary inclusive)', () => {
    const v = evaluateAddition({ state: 'active', startedAt: start }, new Date('2026-11-10T10:00:00Z'), 2);
    expect(v.isScopeCreep).toBe(false);
    expect(v.reason).toBe('WITHIN_GRACE');
  });
  it('ignores future/closed sprints and missing start dates', () => {
    expect(evaluateAddition({ state: 'future', startedAt: start }, new Date(), 0).reason).toBe('NOT_ACTIVE');
    expect(evaluateAddition({ state: 'active', startedAt: null }, new Date(), 0).reason).toBe('NO_START_DATE');
  });
  it('treats zero grace as "anything after start"', () => {
    expect(evaluateAddition({ state: 'active', startedAt: start }, new Date('2026-11-10T08:01:00Z'), 0).isScopeCreep).toBe(true);
  });
});

describe('toStoryPoints', () => {
  it('handles numbers, strings and missing values', () => {
    expect(toStoryPoints(3)).toBe(3);
    expect(toStoryPoints('5')).toBe(5);
    expect(toStoryPoints(null)).toBeNull();
    expect(toStoryPoints(undefined)).toBeNull();
    expect(toStoryPoints('n/a')).toBeNull();
    expect(toStoryPoints(Number.NaN)).toBeNull();
  });
});

describe('validation', () => {
  it('validates settings', () => {
    expect(
      validateSettings({ enabled: true, graceHours: 4, autoLabel: true, labelName: 'unplanned-work', postComment: false }),
    ).toEqual({
      ok: true,
      value: { enabled: true, graceHours: 4, autoLabel: true, labelName: 'unplanned-work', postComment: false },
    });
    // Anything not explicitly true stays off.
    expect(validateSettings({ graceHours: 1, enabled: 'yes' })).toMatchObject({ ok: true, value: { enabled: false } });
    expect(validateSettings({ graceHours: -1 }).ok).toBe(false);
    expect(validateSettings({ graceHours: 2, labelName: 'has space' }).ok).toBe(false);
    expect(validateSettings(null).ok).toBe(false);
  });

  it('defaults everything to off, including settings saved before the enable switch existed', () => {
    expect(withDefaults(undefined)).toEqual({ enabled: false, graceHours: 2, autoLabel: false, labelName: 'scope-creep', postComment: false });
    expect(withDefaults({ graceHours: 8, autoLabel: true })).toEqual({
      enabled: false,
      graceHours: 8,
      autoLabel: true,
      labelName: 'scope-creep',
      postComment: false,
    });
    expect(withDefaults(undefined).graceHours).toBe(2);
  });

  it('validates justification payloads', () => {
    expect(validateJustification({ sprintId: 3, reason: 'PRODUCTION_BUG', justification: '  P1  ' })).toEqual({
      ok: true,
      value: { sprintId: 3, reason: 'PRODUCTION_BUG', justification: 'P1' },
    });
    expect(validateJustification({ sprintId: 3, reason: 'NOPE' }).ok).toBe(false);
    expect(validateJustification({ sprintId: 3, reason: 'OTHER', justification: ' ' }).ok).toBe(false);
    expect(validateJustification({ sprintId: 0, reason: 'OTHER', justification: 'x' }).ok).toBe(false);
    expect(validateJustification({ sprintId: 1, reason: 'OTHER', justification: 'x'.repeat(501) }).ok).toBe(false);
  });
});

describe('computeMetrics', () => {
  it('sums live points, counts unestimated and picks the top category', () => {
    const records = [
      record({ issueKey: 'SG-1', storyPoints: 1, reason: 'PRODUCTION_BUG', status: 'JUSTIFIED' }),
      record({ issueKey: 'SG-2', storyPoints: 3, reason: 'PRODUCTION_BUG', status: 'JUSTIFIED' }),
      record({ issueKey: 'SG-3', storyPoints: null }),
      record({ issueKey: 'SG-4', storyPoints: 8, reason: 'MISSED_DEPENDENCY', removedAt: '2026-11-11T00:00:00Z' }),
    ];
    // SG-1 was re-estimated to 2 since it was flagged; live value wins.
    const live = new Map<string, number | null>([
      ['SG-1', 2],
      ['SG-2', 3],
      ['SG-3', null],
    ]);
    const m = computeMetrics(records, live, 20, 10);
    expect(m.unplannedCount).toBe(3);
    expect(m.unplannedPoints).toBe(5);
    expect(m.unestimatedUnplannedCount).toBe(1);
    expect(m.capacityAbsorbedPct).toBe(25);
    expect(m.unplannedIssueRatioPct).toBe(30);
    expect(m.needsJustificationCount).toBe(1);
    expect(m.topCategory).toBe('PRODUCTION_BUG');
    expect(m.topCategoryCount).toBe(2);
    expect(m.categoryBreakdown).toEqual([
      { reason: 'PRODUCTION_BUG', count: 2 },
      { reason: 'UNCATEGORIZED', count: 1 },
    ]);
  });

  it('handles an empty sprint and zero commitment', () => {
    const m = computeMetrics([], new Map(), 0, 0);
    expect(m).toMatchObject({ unplannedCount: 0, capacityAbsorbedPct: null, unplannedIssueRatioPct: null, topCategory: null });
  });
});
