import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  ErrorMessage,
  Inline,
  Label,
  Lozenge,
  RequiredAsterisk,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Text,
  TextArea,
  User,
  xcss,
} from '@forge/react';
import { callResolver, isError } from './api';
import {
  JUSTIFICATION_MAX_LENGTH,
  REASON_LABELS,
  SCOPE_CHANGE_REASONS,
  type IssuePanelState,
  type ScopeChangeReason,
  type ScopeCreepRecord,
  type SprintSummary,
  type SubmitJustificationPayload,
} from '../lib/types';

const reasonOptions = SCOPE_CHANGE_REASONS.map((value) => ({ value, label: REASON_LABELS[value] }));

const formatDate = (iso: string) => new Date(iso).toLocaleString();

const cardStyle = xcss({ paddingBlock: 'space.100' });

function App() {
  const [state, setState] = useState<IssuePanelState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    setLoadError(null);
    try {
      const res = await callResolver<IssuePanelState>('getIssueStatus');
      if (isError(res)) setLoadError(res.error);
      else setState(res);
    } catch (e) {
      setLoadError('ScopeGuard could not load sprint data for this issue.');
      console.error(e);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (loadError) {
    return (
      <SectionMessage appearance="error" title="ScopeGuard unavailable">
        <Text>{loadError}</Text>
        <Button onClick={() => void load()}>Retry</Button>
      </SectionMessage>
    );
  }
  if (!state) return <Spinner label="Loading ScopeGuard" />;

  switch (state.kind) {
    case 'NO_SPRINT_FIELD':
      return <Text>ScopeGuard needs Jira Software sprints. This site has no Sprint field.</Text>;
    case 'DISABLED':
      return <Text>ScopeGuard is off for this project. It can be turned on from the project's ScopeGuard page.</Text>;
    case 'NOT_IN_ACTIVE_SPRINT':
      return (
        <Inline space="space.100" alignBlock="center">
          <Lozenge>Not in an active sprint</Lozenge>
          <Text>Nothing to check.</Text>
        </Inline>
      );
    case 'COMMITTED':
      return (
        <Inline space="space.100" alignBlock="center">
          <Lozenge appearance="success" isBold>
            Committed in Sprint Plan
          </Lozenge>
          <Text>{state.sprint.name}</Text>
        </Inline>
      );
    case 'FLAGGED':
      return <FlaggedView sprint={state.sprint} record={state.record} canEdit={state.canEdit} onSaved={setState} />;
  }
}

function FlaggedView(props: {
  sprint: SprintSummary;
  record: ScopeCreepRecord;
  canEdit: boolean;
  onSaved: (s: IssuePanelState) => void;
}) {
  const { sprint, record, canEdit, onSaved } = props;
  const [editing, setEditing] = useState(record.status === 'NEEDS_JUSTIFICATION');

  const addedBy = record.addedByAccountId ? <User accountId={record.addedByAccountId} /> : <Text>someone</Text>;

  return (
    <Stack space="space.150">
      <SectionMessage
        appearance={record.status === 'NEEDS_JUSTIFICATION' ? 'warning' : 'information'}
        title="Added Mid-Sprint"
      >
        <Inline space="space.050" alignBlock="center" shouldWrap>
          <Text>Added to {sprint.name} by</Text>
          {addedBy}
          <Text>
            on {formatDate(record.timestamp)} ({record.hoursAfterStart}h after the sprint started).
          </Text>
        </Inline>
      </SectionMessage>

      {record.status === 'JUSTIFIED' && !editing ? (
        <Stack space="space.100">
          <Inline space="space.100" alignBlock="center">
            <Text>Scope change reason:</Text>
            <Lozenge appearance="inprogress">{record.reason ? REASON_LABELS[record.reason] : '—'}</Lozenge>
          </Inline>
          {record.justification ? <Text>{record.justification}</Text> : null}
          {canEdit ? (
            <Box>
              <Button appearance="subtle" onClick={() => setEditing(true)}>
                Change reason
              </Button>
            </Box>
          ) : null}
        </Stack>
      ) : canEdit ? (
        <JustificationForm record={record} onSaved={onSaved} onCancel={record.status === 'JUSTIFIED' ? () => setEditing(false) : undefined} />
      ) : (
        <Inline space="space.100" alignBlock="center">
          <Lozenge appearance="removed" isBold>
            Needs justification
          </Lozenge>
          <Text>Ask someone who can edit this issue to classify it.</Text>
        </Inline>
      )}
    </Stack>
  );
}

function JustificationForm(props: {
  record: ScopeCreepRecord;
  onSaved: (s: IssuePanelState) => void;
  onCancel?: () => void;
}) {
  const { record, onSaved, onCancel } = props;
  const [reason, setReason] = useState<ScopeChangeReason | null>(record.reason);
  const [text, setText] = useState(record.justification ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!reason) {
      setError('Pick a scope change reason.');
      return;
    }
    if (reason === 'OTHER' && !text.trim()) {
      setError('Please explain the reason when choosing "Other".');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload: SubmitJustificationPayload = { sprintId: record.sprintId, reason, justification: text };
      const res = await callResolver<IssuePanelState>('submitJustification', { ...payload });
      if (isError(res)) setError(res.error);
      else onSaved(res);
    } catch (e) {
      console.error(e);
      setError('Saving failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box xcss={cardStyle}>
      <Stack space="space.100">
        <Label labelFor="sg-reason">
          Scope Change Reason
          <RequiredAsterisk />
        </Label>
        <Select
          inputId="sg-reason"
          options={reasonOptions}
          value={reasonOptions.find((o) => o.value === reason) ?? null}
          onChange={(opt: { value: ScopeChangeReason } | null) => setReason(opt?.value ?? null)}
          placeholder="Why was this added mid-sprint?"
        />
        <Label labelFor="sg-justification">Brief justification</Label>
        <TextArea
          id="sg-justification"
          value={text}
          maxLength={JUSTIFICATION_MAX_LENGTH}
          placeholder="e.g. P1 incident INC-123 blocked checkout"
          onChange={(e) => setText(String(e.target.value ?? ''))}
        />
        {error ? <ErrorMessage>{error}</ErrorMessage> : null}
        <Inline space="space.100">
          <Button appearance="primary" isDisabled={saving} onClick={() => void submit()}>
            {saving ? 'Saving…' : 'Submit'}
          </Button>
          {onCancel ? (
            <Button appearance="subtle" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </Inline>
      </Stack>
    </Box>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
