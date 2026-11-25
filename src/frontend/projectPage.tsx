import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  DonutChart,
  DynamicTable,
  EmptyState,
  ErrorMessage,
  Heading,
  HelperMessage,
  Inline,
  Label,
  Link,
  Lozenge,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textfield,
  Toggle,
  Tooltip,
  User,
  ValidMessage,
  xcss,
} from '@forge/react';
import { callResolver, isError } from './api';
import {
  REASON_LABELS,
  type DashboardMetrics,
  type DashboardResponse,
  type DashboardRow,
  type ProjectSettings,
} from '../lib/types';

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const cardStyle = xcss({
  padding: 'space.200',
  borderColor: 'color.border',
  borderWidth: 'border.width',
  borderStyle: 'solid',
  borderRadius: 'radius.medium',
  backgroundColor: 'elevation.surface.raised',
  flexGrow: 1,
  minWidth: '220px',
});

const tabBody = xcss({ paddingBlockStart: 'space.200' });

function App() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (sprintId?: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await callResolver<DashboardResponse>('getDashboard', sprintId ? { sprintId } : {});
      if (isError(res)) setError(res.error);
      else setData(res);
    } catch (e) {
      console.error(e);
      setError('ScopeGuard could not load sprint data. Check that the app has access to this project.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (error) {
    return (
      <SectionMessage appearance="error" title="Something went wrong">
        <Text>{error}</Text>
        <Button onClick={() => void load()}>Retry</Button>
      </SectionMessage>
    );
  }
  if (!data) return <Spinner size="large" label="Loading ScopeGuard" />;

  const selectedSprintId = data.kind === 'OK' ? data.selectedSprint.id : undefined;

  return (
    <Stack space="space.200">
      <Inline spread="space-between" alignBlock="center">
        <Heading size="large">ScopeGuard · Sprint Scope Health</Heading>
        <Button iconBefore="refresh" isDisabled={loading} onClick={() => void load(selectedSprintId)}>
          Refresh
        </Button>
      </Inline>
      <Tabs id="scopeguard-tabs">
        <TabList>
          <Tab>Sprint health</Tab>
          <Tab>Settings</Tab>
        </TabList>
        <TabPanel>
          <Box xcss={tabBody}>
            <HealthTab data={data} loading={loading} onSelectSprint={(id) => void load(id)} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={tabBody}>
            <SettingsTab
              settings={data.settings}
              canConfigure={data.canConfigure}
              onSaved={(settings) => {
                // Turning ScopeGuard on/off changes what the health tab shows.
                if (settings.enabled !== data.settings.enabled) void load(selectedSprintId);
                else setData({ ...data, settings });
              }}
            />
          </Box>
        </TabPanel>
      </Tabs>
    </Stack>
  );
}

// ---------------- Health tab ----------------

function HealthTab(props: { data: DashboardResponse; loading: boolean; onSelectSprint: (id: number) => void }) {
  const { data, loading, onSelectSprint } = props;

  if (data.kind === 'DISABLED') {
    return (
      <EmptyState
        header="ScopeGuard is off for this project"
        description={
          data.canConfigure
            ? 'Nothing is tracked, labelled or commented on until you turn ScopeGuard on in the Settings tab.'
            : 'Nothing is tracked here yet. A project admin or someone with the Manage Sprints permission can turn ScopeGuard on in the Settings tab.'
        }
      />
    );
  }
  if (data.kind === 'NO_SCRUM_BOARD') {
    return (
      <EmptyState
        header="No Scrum board for this project"
        description="ScopeGuard tracks scope added after a sprint starts. Kanban boards have no sprints, so there is nothing to guard here. Create a Scrum board for this project to start tracking."
      />
    );
  }
  if (data.kind === 'NO_ACTIVE_SPRINT') {
    return (
      <EmptyState
        header="No active sprint"
        description="Start a sprint on one of this project's Scrum boards. Issues added after the grace period will show up here."
      />
    );
  }

  const sprintOptions = data.sprints.map((s) => ({ label: s.name, value: s.id }));

  return (
    <Stack space="space.300">
      <Inline space="space.200" alignBlock="center" shouldWrap>
        {sprintOptions.length > 1 ? (
          <Box xcss={xcss({ minWidth: '280px' })}>
            <Select
              inputId="sg-sprint"
              options={sprintOptions}
              value={sprintOptions.find((o) => o.value === data.selectedSprint.id)}
              onChange={(opt: { value: number } | null) => opt && onSelectSprint(opt.value)}
            />
          </Box>
        ) : (
          <Heading size="small">{data.selectedSprint.name}</Heading>
        )}
        {data.selectedSprint.startDate ? (
          <Text>
            Started {formatDate(data.selectedSprint.startDate)}
            {data.selectedSprint.endDate ? ` · ends ${formatDate(data.selectedSprint.endDate)}` : ''}
          </Text>
        ) : null}
        {loading ? <Spinner size="small" /> : null}
      </Inline>

      <MetricCards metrics={data.metrics} />

      {data.metrics.needsJustificationCount > 0 ? (
        <SectionMessage appearance="warning" title={`${data.metrics.needsJustificationCount} addition(s) still need a reason`}>
          <Text>Open each highlighted issue and pick a Scope Change Reason in its ScopeGuard panel.</Text>
        </SectionMessage>
      ) : null}

      <AdditionsTable rows={data.rows} />

      {data.metrics.categoryBreakdown.length > 0 ? (
        <Box xcss={cardStyle}>
          <DonutChart
            title="Why scope was added"
            data={data.metrics.categoryBreakdown.map((c) => ({
              label: c.reason === 'UNCATEGORIZED' ? 'Needs justification' : REASON_LABELS[c.reason],
              value: c.count,
            }))}
            labelAccessor="label"
            colorAccessor="label"
            valueAccessor="value"
            height={280}
          />
        </Box>
      ) : null}
    </Stack>
  );
}

function MetricCard(props: { title: string; value: string; caption: string; tooltip?: string }) {
  const body = (
    <Stack space="space.050">
      <Text size="small" weight="medium" color="color.text.subtle">
        {props.title}
      </Text>
      <Heading size="xlarge">{props.value}</Heading>
      <Text size="small">{props.caption}</Text>
    </Stack>
  );
  return <Box xcss={cardStyle}>{props.tooltip ? <Tooltip content={props.tooltip}>{body}</Tooltip> : body}</Box>;
}

function MetricCards({ metrics: m }: { metrics: DashboardMetrics }) {
  const ratio = m.unplannedIssueRatioPct == null ? '' : ` · ${m.unplannedIssueRatioPct}% of sprint issues`;
  const absorbed =
    m.capacityAbsorbedPct == null
      ? `vs. ${m.committedPoints} pts committed (no estimated commitment)`
      : `${m.capacityAbsorbedPct}% of the ${m.committedPoints} pts committed`;
  const unestimated = m.unestimatedUnplannedCount > 0 ? ` · ${m.unestimatedUnplannedCount} unestimated` : '';

  return (
    <Inline space="space.200" shouldWrap alignBlock="stretch">
      <MetricCard
        title="Unplanned issues"
        value={String(m.unplannedCount)}
        caption={`issue${m.unplannedCount === 1 ? '' : 's'} added post-start${ratio}`}
      />
      <MetricCard
        title="Capacity absorbed"
        value={`${m.unplannedPoints} pts`}
        caption={`${absorbed}${unestimated}`}
        tooltip="Story points of mid-sprint additions compared with the sprint's original commitment. Unestimated issues count as 0 points."
      />
      <MetricCard
        title="Top creep category"
        value={m.topCategory ? REASON_LABELS[m.topCategory] : '—'}
        caption={
          m.topCategory
            ? `${m.topCategoryCount} of ${m.unplannedCount} additions`
            : m.unplannedCount > 0
              ? 'No additions classified yet'
              : 'No mid-sprint additions'
        }
      />
    </Inline>
  );
}

function AdditionsTable({ rows }: { rows: DashboardRow[] }) {
  const head = {
    cells: [
      { key: 'key', content: 'Issue Key', isSortable: true },
      { key: 'summary', content: 'Summary' },
      { key: 'points', content: 'Story Points', isSortable: true },
      { key: 'addedBy', content: 'Added By' },
      { key: 'date', content: 'Added Date', isSortable: true },
      { key: 'reason', content: 'Justification Reason', isSortable: true },
    ],
  };

  const tableRows = rows.map((r) => ({
    key: r.issueKey,
    isHighlighted: !r.removed && r.status === 'NEEDS_JUSTIFICATION',
    cells: [
      { key: r.issueKey, content: <Link href={`/browse/${r.issueKey}`}>{r.issueKey}</Link> },
      { key: r.summary, content: r.removed ? `${r.summary} (removed from sprint)` : r.summary },
      { key: r.storyPoints ?? -1, content: r.storyPoints == null ? <Lozenge>Unestimated</Lozenge> : String(r.storyPoints) },
      {
        key: r.addedByAccountId ?? '',
        content: r.addedByAccountId ? <User accountId={r.addedByAccountId} /> : 'Unknown',
      },
      { key: r.timestamp, content: formatDate(r.timestamp) },
      {
        key: r.reason ?? 'zzz',
        content: r.removed ? (
          <Lozenge>Removed</Lozenge>
        ) : r.reason ? (
          <Tooltip content={r.justification ?? 'No justification text'}>
            <Lozenge appearance="inprogress">{REASON_LABELS[r.reason]}</Lozenge>
          </Tooltip>
        ) : (
          <Lozenge appearance="removed" isBold>
            Uncategorized
          </Lozenge>
        ),
      },
    ],
  }));

  return (
    <Stack space="space.100">
      <Heading size="medium">Mid-sprint additions</Heading>
      <DynamicTable
        head={head}
        rows={tableRows}
        rowsPerPage={20}
        defaultSortKey="date"
        defaultSortOrder="DESC"
        emptyView={<Text>No issues have been added to this sprint since it started. 🎉</Text>}
      />
    </Stack>
  );
}

// ---------------- Settings tab ----------------

function SettingsTab(props: { settings: ProjectSettings; canConfigure: boolean; onSaved: (s: ProjectSettings) => void }) {
  const { canConfigure, onSaved } = props;
  const [enabled, setEnabled] = useState(props.settings.enabled);
  const [graceHours, setGraceHours] = useState(String(props.settings.graceHours));
  const [autoLabel, setAutoLabel] = useState(props.settings.autoLabel);
  const [labelName, setLabelName] = useState(props.settings.labelName);
  const [postComment, setPostComment] = useState(props.settings.postComment);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setError(null);
    setSaved(false);
    const hours = Number(graceHours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 336) {
      setError('Grace period must be between 0 and 336 hours.');
      return;
    }
    setSaving(true);
    try {
      const res = await callResolver<ProjectSettings>('saveSettings', {
        enabled,
        graceHours: hours,
        autoLabel,
        labelName,
        postComment,
      });
      if (isError(res)) setError(res.error);
      else {
        onSaved(res);
        setSaved(true);
      }
    } catch (e) {
      console.error(e);
      setError('Saving failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box xcss={xcss({ maxWidth: '560px' })}>
      <Stack space="space.200">
        {!canConfigure ? (
          <SectionMessage appearance="information">
            <Text>Only project admins or users with the Manage Sprints permission can change these settings.</Text>
          </SectionMessage>
        ) : null}

        <Stack space="space.050">
          <Inline space="space.100" alignBlock="center">
            <Toggle
              id="sg-enabled"
              isChecked={enabled}
              isDisabled={!canConfigure}
              onChange={(e) => setEnabled(Boolean(e.target.checked))}
            />
            <Label labelFor="sg-enabled">Enable ScopeGuard for this project</Label>
          </Inline>
          <HelperMessage>
            Off by default. While it is off, ScopeGuard ignores this project: no tracking, labels or comments.
          </HelperMessage>
        </Stack>

        <Stack space="space.050">
          <Label labelFor="sg-grace">Grace period after sprint start (hours)</Label>
          <Textfield
            id="sg-grace"
            type="number"
            min={0}
            max={336}
            value={graceHours}
            isDisabled={!canConfigure}
            onChange={(e) => setGraceHours(String(e.target.value ?? ''))}
          />
          <HelperMessage>Issues added within this window still count as planned work.</HelperMessage>
        </Stack>

        <Stack space="space.050">
          <Inline space="space.100" alignBlock="center">
            <Toggle
              id="sg-autolabel"
              isChecked={autoLabel}
              isDisabled={!canConfigure}
              onChange={(e) => setAutoLabel(Boolean(e.target.checked))}
            />
            <Label labelFor="sg-autolabel">Auto-apply label to unplanned issues</Label>
          </Inline>
          {autoLabel ? (
            <Textfield
              id="sg-label"
              value={labelName}
              isDisabled={!canConfigure}
              onChange={(e) => setLabelName(String(e.target.value ?? ''))}
            />
          ) : null}
        </Stack>

        <Inline space="space.100" alignBlock="center">
          <Toggle
            id="sg-comment"
            isChecked={postComment}
            isDisabled={!canConfigure}
            onChange={(e) => setPostComment(Boolean(e.target.checked))}
          />
          <Label labelFor="sg-comment">Comment on the issue asking for a Scope Change Reason</Label>
        </Inline>

        {error ? <ErrorMessage>{error}</ErrorMessage> : null}
        {saved ? <ValidMessage>Settings saved. They apply to issues added from now on.</ValidMessage> : null}

        <Box>
          <Button appearance="primary" isDisabled={!canConfigure || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
        </Box>
      </Stack>
    </Box>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
