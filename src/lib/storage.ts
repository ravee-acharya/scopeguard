/**
 * Forge Key-Value Store repository.
 *
 * Key layout (all keys are app-scoped per Jira site):
 *   sprint-scope-{sprintId}:{issueKey}  → ScopeCreepRecord   (one key per issue, so
 *                                         concurrent triggers during a bulk move
 *                                         never overwrite each other)
 *   sprint-baseline-{sprintId}          → SprintBaseline
 *   settings-{projectId}                → ProjectSettings
 *   field-config                        → FieldConfig (cached field discovery)
 *
 * Uses @forge/kvs, the successor to the deprecated `storage` export of @forge/api.
 */
import { kvs, WhereConditions } from '@forge/kvs';
import { withDefaults } from './logic';
import type { ProjectSettings, ScopeCreepRecord, SprintBaseline } from './types';

const recordPrefix = (sprintId: number) => `sprint-scope-${sprintId}:`;
const recordKey = (sprintId: number, issueKey: string) => `${recordPrefix(sprintId)}${issueKey}`;
const baselineKey = (sprintId: number) => `sprint-baseline-${sprintId}`;
const settingsKey = (projectId: string) => `settings-${projectId}`;
const FIELD_CONFIG_KEY = 'field-config';

export interface FieldConfig {
  sprintFieldId: string | null;
  storyPointFieldIds: string[];
  fetchedAt: string;
}

// ---------- Scope creep records ----------

export async function getRecord(sprintId: number, issueKey: string): Promise<ScopeCreepRecord | undefined> {
  return kvs.get<ScopeCreepRecord>(recordKey(sprintId, issueKey));
}

export async function saveRecord(record: ScopeCreepRecord): Promise<void> {
  await kvs.set(recordKey(record.sprintId, record.issueKey), record);
}

export async function listRecords(sprintId: number): Promise<ScopeCreepRecord[]> {
  const out: ScopeCreepRecord[] = [];
  let cursor: string | undefined;
  do {
    let query = kvs.query().where('key', WhereConditions.beginsWith(recordPrefix(sprintId))).limit(100);
    if (cursor) query = query.cursor(cursor);
    const page = await query.getMany<ScopeCreepRecord>();
    out.push(...page.results.map((r) => r.value));
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

// ---------- Baselines ----------

export async function getBaseline(sprintId: number): Promise<SprintBaseline | undefined> {
  return kvs.get<SprintBaseline>(baselineKey(sprintId));
}

export async function saveBaseline(baseline: SprintBaseline): Promise<void> {
  await kvs.set(baselineKey(baseline.sprintId), baseline);
}

// ---------- Settings ----------

export async function getSettings(projectId: string): Promise<ProjectSettings> {
  return withDefaults(await kvs.get<Partial<ProjectSettings>>(settingsKey(projectId)));
}

export async function saveSettings(projectId: string, settings: ProjectSettings): Promise<void> {
  await kvs.set(settingsKey(projectId), settings);
}

// ---------- Field discovery cache ----------

export async function getFieldConfig(): Promise<FieldConfig | undefined> {
  return kvs.get<FieldConfig>(FIELD_CONFIG_KEY);
}

export async function saveFieldConfig(config: FieldConfig): Promise<void> {
  await kvs.set(FIELD_CONFIG_KEY, config);
}
