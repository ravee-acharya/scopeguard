/**
 * Thin, typed wrappers over the Jira Platform and Jira Software REST APIs.
 * Everything runs `asApp()` except the permission check, which must reflect
 * the *viewing user's* rights and therefore runs `asUser()`.
 */
import api, { route } from '@forge/api';
import { getFieldConfig, saveFieldConfig, type FieldConfig } from './storage';
import { toStoryPoints } from './logic';
import type { SprintSummary } from './types';

const FIELD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SPRINT_FIELD_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint';
const STORY_POINT_SCHEMAS = new Set([
  'com.atlassian.jira.plugin.system.customfieldtypes:float', // company-managed "Story Points"
  'com.pyxis.greenhopper.jira:jsw-story-points', // team-managed "Story point estimate"
]);

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type FetchResponse = Awaited<ReturnType<ReturnType<typeof api.asApp>['requestJira']>>;

async function json<T>(res: FetchResponse, what: string): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new JiraError(`${what} failed: ${res.status} ${body.slice(0, 300)}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------- Field discovery ----------

interface JiraField {
  id: string;
  name: string;
  schema?: { custom?: string };
}

/** Finds the Sprint and Story Points custom field ids (they differ per site). Cached 24h. */
export async function resolveFields(): Promise<FieldConfig> {
  const cached = await getFieldConfig();
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < FIELD_CACHE_TTL_MS) return cached;

  const fields = await json<JiraField[]>(await api.asApp().requestJira(route`/rest/api/3/field`), 'List fields');
  const sprintField = fields.find((f) => f.schema?.custom === SPRINT_FIELD_SCHEMA);
  const storyPointFieldIds = fields
    .filter((f) => f.schema?.custom && STORY_POINT_SCHEMAS.has(f.schema.custom) && /story point/i.test(f.name))
    // Prefer the team-managed estimate field first, then classic Story Points.
    .sort((a, b) => Number(b.schema?.custom?.includes('jsw-story-points')) - Number(a.schema?.custom?.includes('jsw-story-points')))
    .map((f) => f.id);

  const config: FieldConfig = {
    sprintFieldId: sprintField?.id ?? null,
    storyPointFieldIds,
    fetchedAt: new Date().toISOString(),
  };
  await saveFieldConfig(config);
  return config;
}

export function readStoryPoints(fields: Record<string, unknown>, config: FieldConfig): number | null {
  for (const id of config.storyPointFieldIds) {
    const points = toStoryPoints(fields[id]);
    if (points != null) return points;
  }
  return null;
}

// ---------- Issues ----------

export interface JiraIssue {
  id: string;
  key: string;
  fields: Record<string, unknown> & {
    summary?: string;
    project?: { id: string; key: string };
    labels?: string[];
  };
}

export async function getIssue(issueIdOrKey: string, fields: string[]): Promise<JiraIssue> {
  const res = await api
    .asApp()
    .requestJira(route`/rest/api/3/issue/${issueIdOrKey}?fields=${fields.join(',')}`);
  return json<JiraIssue>(res, `Get issue ${issueIdOrKey}`);
}

/** The raw Sprint field value on an issue: an array of sprint objects (or null). */
interface IssueSprintValue {
  id: number;
  name: string;
  state: 'active' | 'closed' | 'future';
  boardId?: number;
  startDate?: string;
  endDate?: string;
}

export function readIssueSprints(fields: Record<string, unknown>, sprintFieldId: string): SprintSummary[] {
  const raw = fields[sprintFieldId];
  if (!Array.isArray(raw)) return [];
  return (raw as IssueSprintValue[])
    .filter((s) => s && typeof s.id === 'number')
    .map((s) => ({
      id: s.id,
      name: s.name,
      state: s.state,
      startDate: s.startDate ?? null,
      endDate: s.endDate ?? null,
      boardId: s.boardId ?? null,
    }));
}

export async function addLabel(issueKey: string, label: string): Promise<void> {
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ update: { labels: [{ add: label }] } }),
  });
  await json<void>(res, `Add label to ${issueKey}`);
}

export async function addScopeCreepComment(issueKey: string, mentionAccountId: string | null, graceHours: number): Promise<void> {
  const intro = mentionAccountId
    ? [{ type: 'mention', attrs: { id: mentionAccountId } }, { type: 'text', text: ' ' }]
    : [];
  const body = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'panel',
        attrs: { panelType: 'warning' },
        content: [
          {
            type: 'paragraph',
            content: [
              ...intro,
              {
                type: 'text',
                text: `ScopeGuard: this issue was added to the active sprint more than ${graceHours}h after it started. `,
              },
              {
                type: 'text',
                text: 'Please select a Scope Change Reason in the ScopeGuard panel on this issue.',
                marks: [{ type: 'strong' }],
              },
            ],
          },
        ],
      },
    ],
  };
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ body }),
  });
  await json<unknown>(res, `Comment on ${issueKey}`);
}

// ---------- Jira Software (agile) ----------

interface AgileSprint {
  id: number;
  name: string;
  state: 'active' | 'closed' | 'future';
  startDate?: string;
  endDate?: string;
  activatedDate?: string;
  originBoardId?: number;
}

export interface SprintDetails extends SprintSummary {
  /** When the sprint was actually started; falls back to the planned start. */
  startedAt: string | null;
}

function toSprintDetails(s: AgileSprint): SprintDetails {
  return {
    id: s.id,
    name: s.name,
    state: s.state,
    startDate: s.startDate ?? null,
    endDate: s.endDate ?? null,
    boardId: s.originBoardId ?? null,
    startedAt: s.activatedDate ?? s.startDate ?? null,
  };
}

/** Returns null when the sprint was deleted or the app cannot see it. */
export async function getSprint(sprintId: number): Promise<SprintDetails | null> {
  const res = await api.asApp().requestJira(route`/rest/agile/1.0/sprint/${sprintId}`);
  if (res.status === 404 || res.status === 403) return null;
  return toSprintDetails(await json<AgileSprint>(res, `Get sprint ${sprintId}`));
}

interface Paged<T> {
  values: T[];
  isLast?: boolean;
  startAt: number;
  maxResults: number;
  total?: number;
}

/** Scrum boards that include the project. Kanban boards are excluded: they have no sprints. */
export async function listScrumBoards(projectKeyOrId: string): Promise<{ id: number; name: string }[]> {
  const boards: { id: number; name: string }[] = [];
  let startAt = 0;
  for (;;) {
    const page = await json<Paged<{ id: number; name: string }>>(
      await api
        .asApp()
        .requestJira(route`/rest/agile/1.0/board?projectKeyOrId=${projectKeyOrId}&type=scrum&startAt=${startAt}&maxResults=50`),
      'List boards',
    );
    boards.push(...page.values);
    if (page.isLast !== false || page.values.length === 0) break;
    startAt += page.values.length;
  }
  return boards;
}

export async function listActiveSprints(boardId: number): Promise<SprintDetails[]> {
  const res = await api
    .asApp()
    .requestJira(route`/rest/agile/1.0/board/${boardId}/sprint?state=active&maxResults=50`);
  // 400 = board does not support sprints (e.g. converted to Kanban). Treat as "none".
  if (res.status === 400 || res.status === 404) return [];
  const page = await json<Paged<AgileSprint>>(res, `List sprints for board ${boardId}`);
  return page.values.map(toSprintDetails);
}

interface SprintIssuesPage {
  issues: JiraIssue[];
  startAt: number;
  maxResults: number;
  total: number;
}

/** All issues currently in a sprint (paginated, 50 at a time). */
export async function listSprintIssues(sprintId: number, fields: string[]): Promise<JiraIssue[]> {
  const issues: JiraIssue[] = [];
  let startAt = 0;
  for (;;) {
    const page = await json<SprintIssuesPage>(
      await api
        .asApp()
        .requestJira(route`/rest/agile/1.0/sprint/${sprintId}/issue?fields=${fields.join(',')}&startAt=${startAt}&maxResults=50`),
      `List issues of sprint ${sprintId}`,
    );
    issues.push(...page.issues);
    startAt += page.issues.length;
    if (page.issues.length === 0 || startAt >= page.total) break;
  }
  return issues;
}

// ---------- Permissions (as the viewing user) ----------

/**
 * True when the current user holds ANY of `permissions` in the given context.
 * Runs asUser so Jira evaluates the real user's rights. On first use Forge
 * asks the user to grant access; that error is deliberately not swallowed.
 */
export async function userHasAnyPermission(
  permissions: string[],
  context: { issueKey?: string; projectKey?: string },
): Promise<boolean> {
  const perms = permissions.join(',');
  const req = context.issueKey
    ? route`/rest/api/3/mypermissions?issueKey=${context.issueKey}&permissions=${perms}`
    : route`/rest/api/3/mypermissions?projectKey=${context.projectKey ?? ''}&permissions=${perms}`;
  const res = await api.asUser().requestJira(req);
  const body = await json<{ permissions: Record<string, { havePermission: boolean }> }>(res, 'Check permissions');
  return permissions.some((p) => body.permissions[p]?.havePermission === true);
}
