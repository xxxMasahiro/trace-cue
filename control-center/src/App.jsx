import { useEffect, useMemo, useRef, useState } from 'react';
import {
  approvePlaywrightTestCiSettings,
  createSourceIntakeProposal,
  fetchDashboard,
  fetchApprovedPlaywrightTestCiArtifact,
  fetchPlaywrightTestCiArtifact,
  importPlaywrightTestResult,
  setDisplayLanguage,
  setPlaywrightTestMode,
  suggestPlaywrightTestCiSettings
} from './apiClient.js';
import { designSystemMetadata, designSystemStyle } from './designSystem.js';
import { createTranslator } from './i18n.js';
import { PAGES } from './pageDefinitions.js';
import { buildControlCenterViewModel } from './controlCenterViewModel.js';
import { getNextReviewMethod, getReviewMethod, reviewMethodCopy } from './reviewMethods.js';
import { useControlCenterRoute } from './useControlCenterRoute.js';

const DEFAULT_INTAKE_FORM = {
  source_text_file: '',
  source_type: 'transcript',
  review_brief: '',
  review_effort: 'standard',
  target_audience: '',
  expected_impression: '',
  content_evidence_file: '',
  review_index_file: '',
  local_write_confirmed: false
};

const DEFAULT_PLAYWRIGHT_IMPORT_FORM = {
  input: '',
  local_write_confirmed: false
};

const DEFAULT_PLAYWRIGHT_CI_FORM = {
  repo: '',
  run_id: '',
  artifact_name: '',
  execute_confirmed: false
};

const DEFAULT_PLAYWRIGHT_APPROVED_CI_FORM = {
  repo: '',
  workflow_name: '',
  branch: '',
  event: '',
  artifact_name: '',
  target_policy: 'latest_successful_run',
  head_sha: '',
  limit: 20,
  max_age_hours: 168,
  fetch_confirmed: false
};

export default function App() {
  const [dashboard, setDashboard] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [locale, setLocale] = useState('en');
  const { route, navigate, back } = useControlCenterRoute();
  const style = useMemo(() => designSystemStyle(), []);
  const translator = useMemo(() => createTranslator(locale), [locale]);
  const { t } = translator;
  const viewModel = useMemo(() => dashboard ? buildControlCenterViewModel(dashboard) : null, [dashboard]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const nextDashboard = await fetchDashboard();
      setDashboard(nextDashboard);
      setLocale(nextDashboard.settings?.display_language?.current_locale ?? 'en');
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const language = dashboard?.settings?.display_language;
    const direction = language?.text_direction ?? (locale === 'ar' ? 'rtl' : 'ltr');
    document.documentElement.lang = locale;
    document.documentElement.dir = direction;
    document.documentElement.dataset.locale = locale;
  }, [dashboard, locale]);

  useEffect(() => {
    if (loading || error) return;
    window.requestAnimationFrame(() => document.querySelector('[data-page-heading]')?.focus());
  }, [route.page, route.view, loading, error]);

  return (
    <main className="app-shell" style={style} data-locale={locale}>
      <aside className="side-nav" aria-label={t('nav.primary', 'Main menu')}>
        <button className="brand-button" type="button" onClick={() => navigate({ page: 'confirm', view: 'list' })}>
          <span className="brand-mark" aria-hidden="true">T</span>
          <span>TraceCue</span>
        </button>
        <nav className="nav-list">
          {PAGES.map((page) => (
            <button
              key={page.id}
              type="button"
              className={route.page === page.id ? 'nav-item active' : 'nav-item'}
              onClick={() => navigate({ page: page.id, view: page.id === 'confirm' ? 'list' : page.id })}
              aria-current={route.page === page.id ? 'page' : undefined}
            >
              <span className="nav-icon" aria-hidden="true">{page.icon}</span>
              <span>{t(page.labelKey, page.fallback)}</span>
              {page.id === 'running' && viewModel?.runningItems?.length ? <span className="nav-count">{viewModel.runningItems.length}</span> : null}
            </button>
          ))}
        </nav>
        <p className="side-note">{t('app.localOnly', 'Local workspace')}</p>
      </aside>
      <section className="workspace">
        {loading ? <StatePanel title={t('state.loading.title', 'Loading your checks')} text={t('state.loading.text', 'Reading the latest local results.')} /> : null}
        {error ? <StatePanel title={t('state.loadError.title', 'Could not load your checks')} text={t('state.loadError.text', 'Try refreshing the local Control Center.')} tone="danger" /> : null}
        {!loading && !error && dashboard ? <ControlCenterPage
          dashboard={dashboard}
          viewModel={viewModel}
          route={route}
          navigate={navigate}
          back={back}
          reload={load}
          locale={locale}
          setLocale={setLocale}
          t={t}
        /> : null}
      </section>
    </main>
  );
}

function ControlCenterPage({ dashboard, viewModel, route, navigate, back, reload, locale, setLocale, t }) {
  if (route.page === 'running') {
    return <RunningPage viewModel={viewModel} reload={reload} t={t} />;
  }
  if (route.page === 'settings') {
    return <SettingsHub dashboard={dashboard} locale={locale} setLocale={setLocale} reload={reload} t={t} />;
  }
  if (route.view === 'new') {
    return <IntakePage dashboard={dashboard} onBack={() => navigate({ page: 'confirm', view: 'list' })} t={t} />;
  }
  if (route.view === 'work') {
    return <CheckWorkspace dashboard={dashboard} onBack={() => navigate({ page: 'confirm', view: 'list' })} t={t} />;
  }
  return <ConfirmationList dashboard={dashboard} viewModel={viewModel} navigate={navigate} reload={reload} t={t} />;
}

function PageHeading({ eyebrow, title, action = null }) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1 tabIndex="-1" data-page-heading>{title}</h1>
      </div>
      {action}
    </header>
  );
}

function Disclosure({ className = '', summary, hint = null, children, testId = null }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`${className}${open ? ' open' : ''}`}>
      <button className="disclosure-trigger" data-testid={testId} type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span>{summary}</span>
        {hint ? <small>{hint}</small> : null}
        <span className="disclosure-chevron" aria-hidden="true">⌄</span>
      </button>
      {open ? <div className="disclosure-content">{children}</div> : null}
    </section>
  );
}

function ConfirmationList({ dashboard, viewModel, navigate, reload, t }) {
  const results = dashboard.evidence?.visual_review_results ?? [];
  const findingCount = dashboard.findings?.visual_review?.advisory_findings ?? 0;
  const ownerDecisionCount = dashboard.findings?.owner_decision_requests ?? 0;
  return (
    <div className="screen confirmation-list" data-testid="tc-cc-confirmation-list">
      <PageHeading
        title={t('confirm.title', 'Checks')}
        action={<button className="secondary-action" type="button" onClick={() => navigate({ page: 'confirm', view: 'new' })}><span aria-hidden="true">＋</span> {t('confirm.new', 'New check')}</button>}
      />
      <section className="next-work" aria-labelledby="next-work-title">
        <div>
          <p className="eyebrow">{t('confirm.nextEyebrow', 'Next')}</p>
          <h2 id="next-work-title">{friendlyNextAction(dashboard, t)}</h2>
          <p className="muted">{t('confirm.nextSummary', 'Review the available local results and decide what needs attention.')}</p>
        </div>
        <button className="primary-action" type="button" onClick={() => navigate({ page: 'confirm', view: 'work' })}>{t('confirm.continue', 'Continue')} <span aria-hidden="true">→</span></button>
      </section>
      <div className="summary-strip" aria-label={t('confirm.summary', 'Check summary')}>
        <Metric label={t('confirm.results', 'Results')} value={results.length} />
        <Metric label={t('confirm.improvements', 'Improvements')} value={findingCount} />
        <Metric label={t('confirm.decisions', 'Decisions needed')} value={ownerDecisionCount} />
      </div>
      <section className="list-section" aria-labelledby="recent-title">
        <div className="section-heading">
          <h2 id="recent-title">{t('confirm.recent', 'Recent checks')}</h2>
          <button className="icon-action" type="button" onClick={reload} aria-label={t('app.refresh', 'Refresh')}>↻</button>
        </div>
        {viewModel?.confirmationItems?.length ? (
          <ul className="check-list">
            {viewModel.confirmationItems.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => navigate({ page: 'confirm', view: 'work', itemId: item.id })}>
                  <span className={`status-dot ${item.tone ?? 'neutral'}`} aria-hidden="true"></span>
                  <span><strong>{item.title}</strong><small>{item.description}</small></span>
                  <span className="row-state">{item.statusLabel}</span>
                  <span aria-hidden="true">›</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <StatePanel title={t('confirm.emptyTitle', 'No completed checks yet')} text={t('confirm.emptyText', 'Start a new check when you have something to review.')} />}
      </section>
    </div>
  );
}

function IntakePage({ dashboard, onBack, t }) {
  const intake = dashboard.source_intake ?? {};
  const [form, setForm] = useState(DEFAULT_INTAKE_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const followUpTrigger = useRef(null);
  const followUpDialog = useRef(null);
  const efforts = intake.supported_efforts ?? ['standard', 'deep', 'xhigh'];
  const sourceTypes = intake.supported_source_types ?? ['video', 'web_page', 'pdf', 'meeting_notes', 'document', 'transcript', 'other'];

  useEffect(() => {
    const dialog = followUpDialog.current;
    if (!dialog) return;
    if (followUpOpen && !dialog.open) dialog.showModal();
    if (!followUpOpen && dialog.open) dialog.close();
  }, [followUpOpen]);

  async function submit(event) {
    event.preventDefault();
    setError(null);
    setResult(null);
    if (!form.local_write_confirmed) {
      setError(t('intake.confirmRequired', 'Confirm that you want to prepare this local check.'));
      return;
    }
    setSubmitting(true);
    try {
      const created = await createSourceIntakeProposal({
        source_text_file: form.source_text_file,
        source_type: form.source_type,
        review_brief: form.review_brief,
        review_effort: form.review_effort,
        target_audience: form.target_audience,
        expected_impression: form.expected_impression,
        content_evidence_file: form.content_evidence_file,
        review_index_file: form.review_index_file,
        confirm: intake.confirm
      });
      setResult(created);
    } catch (submitError) {
      setError(friendlyActionError(submitError, t));
    } finally {
      setSubmitting(false);
    }
  }

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function closeFollowUp() {
    setFollowUpOpen(false);
    window.requestAnimationFrame(() => followUpTrigger.current?.focus());
  }

  function prepareFollowUp() {
    const next = getNextReviewMethod(result?.review_effort);
    if (!next || !efforts.includes(next.id)) return;
    setForm((current) => ({ ...current, review_effort: next.id, local_write_confirmed: false }));
    setResult(null);
    setError(null);
    setFollowUpOpen(false);
    window.requestAnimationFrame(() => document.querySelector('#review-method-legend')?.scrollIntoView({ block: 'center' }));
  }

  return (
    <div className="screen new-check" data-testid="tc-cc-new-check">
      <PageHeading
        eyebrow={t('intake.eyebrow', 'Prepare')}
        title={t('intake.title', 'New check')}
        action={<button className="icon-action" type="button" onClick={onBack} aria-label={t('common.back', 'Back')}>‹</button>}
      />
      <div className="form-layout">
      <section className="form-surface">
        <p className="muted">{t('intake.caption', 'Choose what you want to review and the result you need. This safely prepares a local proposal; no external review starts yet.')}</p>
        <form className="control-form" onSubmit={submit}>
          <label>
            {t('intake.sourceText', 'Source text file')}
            <span>{t('intake.sourceTextHint', 'Choose a text file already inside this workspace.')}</span>
            <input aria-label={t('intake.sourceText', 'Source text file')} value={form.source_text_file} onChange={(event) => update('source_text_file', event.target.value)} placeholder="docs/source/transcript.txt" required />
          </label>
          <label>
            {t('intake.sourceType', 'What are you checking?')}
            <select aria-label={t('intake.sourceType', 'What are you checking?')} value={form.source_type} onChange={(event) => update('source_type', event.target.value)}>
              {sourceTypes.map((sourceType) => <option key={sourceType} value={sourceType}>{sourceTypeLabel(sourceType, t)}</option>)}
            </select>
          </label>
          <label>
            {t('intake.reviewBrief', 'What do you want to learn?')}
            <textarea aria-label={t('intake.reviewBrief', 'What do you want to learn?')} value={form.review_brief} onChange={(event) => update('review_brief', event.target.value)} rows={3} placeholder={t('intake.reviewBriefPlaceholder', 'For example: Can a first-time visitor complete the main task without getting lost?')} required />
          </label>

          <fieldset className="method-fieldset" data-testid="tc-cc-review-method-selector">
            <legend id="review-method-legend">{t('reviewMethod.legend', 'What kind of result do you need?')}</legend>
            <p className="form-hint">{t('reviewMethod.hint', 'If you are unsure, start with the recommended option. You can prepare a more detailed check later.')}</p>
            <div className="method-options">
              {efforts.map((effort) => {
                const method = getReviewMethod(effort);
                const copy = reviewMethodCopy(t, effort);
                if (!method || !copy) return null;
                const descriptionId = `review-method-${effort}-description`;
                return (
                  <label className={`method-option${form.review_effort === effort ? ' selected' : ''}`} key={effort}>
                    <input type="radio" name="review-method" value={effort} checked={form.review_effort === effort} onChange={() => update('review_effort', effort)} aria-label={copy.title} aria-describedby={descriptionId} />
                    <span className="method-radio" aria-hidden="true"></span>
                    <span className="method-copy">
                      <span className="method-heading"><strong>{copy.title}</strong>{method.recommended ? <span className="recommend-badge">{t('reviewMethod.recommended', 'Recommended')}</span> : null}</span>
                      <span className="method-description" id={descriptionId}>{copy.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <Disclosure className="optional-details" summary={t('intake.optionalDetails', 'Add context')}>
            <div className="form-grid">
            <label>
              {t('intake.targetAudience', 'Audience')} <span>{t('common.optional', 'optional')}</span>
              <input aria-label={t('intake.targetAudience', 'Audience')} value={form.target_audience} onChange={(event) => update('target_audience', event.target.value)} />
            </label>
            <label>
              {t('intake.expectedImpression', 'Expected impression')} <span>{t('common.optional', 'optional')}</span>
              <input aria-label={t('intake.expectedImpression', 'Expected impression')} value={form.expected_impression} onChange={(event) => update('expected_impression', event.target.value)} />
            </label>
            </div>
            <div className="form-grid">
            <label>
              {t('intake.contentEvidence', 'Content evidence file')} <span>{t('common.optional', 'optional')}</span>
              <input aria-label={t('intake.contentEvidence', 'Content evidence file')} value={form.content_evidence_file} onChange={(event) => update('content_evidence_file', event.target.value)} />
            </label>
            <label>
              {t('intake.reviewIndex', 'Review index file')} <span>{t('common.optional', 'optional')}</span>
              <input aria-label={t('intake.reviewIndex', 'Review index file')} value={form.review_index_file} onChange={(event) => update('review_index_file', event.target.value)} />
            </label>
            </div>
          </Disclosure>
          <label className="check-row">
            <input type="checkbox" aria-label={t('intake.localWrite', 'Prepare this review in the local workspace')} checked={form.local_write_confirmed} onChange={(event) => update('local_write_confirmed', event.target.checked)} />
            {t('intake.localWrite', 'Prepare this check in the local workspace')}
          </label>
          <button className="primary-action" type="submit" disabled={submitting}>
            {submitting ? t('intake.submitting', 'Preparing...') : t('intake.submit', 'Prepare check')}
          </button>
        </form>
        {error ? <StatePanel title={t('intake.errorTitle', 'Could not prepare the check')} text={error} tone="danger" /> : null}
      </section>
      {result ? <SourceIntakeResult result={result} triggerRef={followUpTrigger} onFollowUp={() => setFollowUpOpen(true)} t={t} /> : <SafetySummary t={t} />}
      </div>
      <dialog className="deeper-dialog" ref={followUpDialog} onCancel={(event) => { event.preventDefault(); closeFollowUp(); }} onClose={() => setFollowUpOpen(false)} aria-labelledby="deeper-dialog-title">
        <button className="dialog-close" type="button" onClick={closeFollowUp} aria-label={t('common.close', 'Close')}>×</button>
        <p className="eyebrow">{t('followUp.eyebrow', 'Additional check')}</p>
        <h2 id="deeper-dialog-title">{t('followUp.title', 'Prepare a more detailed check?')}</h2>
        <p className="muted">{t('followUp.description', 'Your current proposal stays unchanged. The same input will be prepared with the next review method.')}</p>
        {result ? <div className="dialog-method"><strong>{reviewMethodCopy(t, getNextReviewMethod(result.review_effort)?.id)?.title}</strong><span>{reviewMethodCopy(t, getNextReviewMethod(result.review_effort)?.id)?.description}</span></div> : null}
        <div className="dialog-actions">
          <button className="secondary-action" type="button" onClick={closeFollowUp}>{t('common.back', 'Back')}</button>
          <button className="primary-action" type="button" onClick={prepareFollowUp}>{t('followUp.prepare', 'Prepare detailed check')}</button>
        </div>
      </dialog>
    </div>
  );
}

function SourceIntakeResult({ result, triggerRef, onFollowUp, t }) {
  const copy = reviewMethodCopy(t, result.review_effort);
  const next = getNextReviewMethod(result.review_effort);
  return (
    <section className="result-summary" aria-live="polite">
      <div className="summary-mark" aria-hidden="true">✓</div>
      <p className="eyebrow">{t('intake.resultEyebrow', 'Ready')}</p>
      <h2>{t('intake.ready', 'Check preparation is ready')}</h2>
      <p className="muted">{t('intake.readyCaption', 'Review the local proposal before creating a plan or starting an external review.')}</p>
      <div className="metric-row">
        <Metric label={t('intake.characters', 'Characters')} value={result.source_text?.char_count ?? 0} />
        <Metric label={t('intake.sections', 'Sections')} value={result.source_text?.chunk_count ?? 0} />
        <Metric label={t('intake.preparedItems', 'Prepared items')} value={result.artifact_summary?.artifact_count ?? 0} />
      </div>
      <dl className="definition-list">
        <div><dt>{t('intake.sourceType', 'Source')}</dt><dd>{sourceTypeLabel(result.resolved_source_type ?? result.requested_source_type, t)}</dd></div>
        <div><dt>{t('intake.reviewMethod', 'Review method')}</dt><dd>{copy?.label ?? t('reviewMethod.unknown', 'Method not recorded')}</dd></div>
      </dl>
      {next ? <button className="text-action" type="button" ref={triggerRef} onClick={onFollowUp}>{t('followUp.open', 'Prepare a more detailed check')}</button> : null}
    </section>
  );
}

function SafetySummary({ t }) {
  return (
    <aside className="safety-summary" aria-label={t('safety.title', 'Safety')}>
      <strong>{t('safety.localTitle', 'Prepared locally')}</strong>
      <p>{t('safety.localText', 'This step creates a local proposal only. It does not contact an AI provider or start a browser.')}</p>
    </aside>
  );
}

function RunningPage({ viewModel, reload, t }) {
  const items = viewModel?.runningItems ?? [];
  return (
    <div className="screen running-page" data-testid="tc-cc-running-page">
      <PageHeading
        title={t('running.title', 'In progress')}
        action={<button className="icon-action" type="button" onClick={reload} aria-label={t('app.refresh', 'Refresh')}>↻</button>}
      />
      {items.length ? (
        <ul className="running-list">
          {items.map((item) => (
            <li key={item.id}>
              <span className="activity-mark" aria-hidden="true">↻</span>
              <span><strong>{item.title}</strong><small>{item.description}</small></span>
              <StatusBadge status={item.status} label={item.statusLabel} />
            </li>
          ))}
        </ul>
      ) : (
        <section className="empty-state">
          <span className="empty-mark" aria-hidden="true">✓</span>
          <h2>{t('running.emptyTitle', 'Nothing is running')}</h2>
          <p>{t('running.emptyText', 'Checks that are genuinely running will appear here.')}</p>
        </section>
      )}
    </div>
  );
}

function CheckWorkspace({ dashboard, onBack, t }) {
  const review = dashboard.review ?? {};
  const findings = dashboard.findings ?? {};
  const visualResults = dashboard.evidence?.visual_review_results ?? [];
  const topResults = findings.visual_review?.top_results ?? visualResults;
  const projection = dashboard.regression?.playwright_test?.review_projection;
  return (
    <div className="screen work-page" data-testid="tc-cc-check-workspace">
      <PageHeading
        eyebrow={t('work.eyebrow', 'Review')}
        title={t('work.title', 'Check workspace')}
        action={<button className="icon-action" type="button" onClick={onBack} aria-label={t('common.back', 'Back')}>‹</button>}
      />
      <ol className="workflow-steps" aria-label={t('workflow.title', 'Check progress')}>
        {['prepare', 'review', 'decide', 'recheck', 'complete'].map((stage, index) => (
          <li key={stage} className={index === 1 ? 'current' : index === 0 ? 'done' : ''} aria-current={index === 1 ? 'step' : undefined}>
            <span>{index === 0 ? '✓' : index + 1}</span>
            <strong>{t(`workflow.${stage}`, stage)}</strong>
          </li>
        ))}
      </ol>
      <section className="decision-summary">
        <div>
          <p className="eyebrow">{t('work.nextEyebrow', 'Next')}</p>
          <h2>{friendlyNextAction(dashboard, t)}</h2>
          <p>{review.can_owner_review_proceed ? t('work.readyText', 'The available local evidence is ready for review.') : t('work.waitingText', 'More local evidence is needed before a final decision.')}</p>
        </div>
        <StatusBadge status={review.can_owner_review_proceed ? 'ready' : 'attention'} label={review.can_owner_review_proceed ? t('work.ready', 'Ready') : t('work.needsAttention', 'Needs attention')} />
      </section>
      <div className="summary-strip">
        <Metric label={t('confirm.results', 'Results')} value={visualResults.length} />
        <Metric label={t('confirm.improvements', 'Improvements')} value={findings.visual_review?.advisory_findings ?? 0} />
        <Metric label={t('confirm.decisions', 'Decisions needed')} value={findings.owner_decision_requests ?? 0} />
      </div>
      <section className="list-section" aria-labelledby="work-results-title">
        <h2 id="work-results-title">{t('work.availableResults', 'Available results')}</h2>
        {topResults.length ? (
          <ul className="work-result-list">
            {topResults.map((result, index) => (
              <li key={result.id ?? index}>
                <span className="result-number">{index + 1}</span>
                <span><strong>{t('work.localResult', 'Local review result')}</strong><small>{t('work.resultCounts', `${result.finding_count ?? 0} improvements, ${result.owner_decision_requests ?? 0} decisions`)}</small></span>
                <StatusBadge status={result.status ?? 'ready'} />
              </li>
            ))}
          </ul>
        ) : <StatePanel title={t('work.noResultsTitle', 'No review result is ready')} text={t('work.noResultsText', 'Prepare a check or import an existing test result first.')} />}
      </section>
      {projection ? <section className="list-section"><PlaywrightReviewMaterial projection={projection} t={t} /></section> : null}
      <Disclosure className="evidence-details" summary={t('work.evidenceDetails', 'Why this status is shown')}>
        <div className="details-content">
          <ActionList actions={review.top_owner_actions ?? []} fallback={review.next_action} />
          {dashboard.evidence?.owner_review_matrix ? <EvidenceMatrix matrix={dashboard.evidence.owner_review_matrix} t={t} /> : null}
          <BlockerList blockers={findings.blockers} />
        </div>
      </Disclosure>
    </div>
  );
}

function SettingsHub({ dashboard, locale, setLocale, reload, t }) {
  return (
    <div className="screen settings-hub" data-testid="tc-cc-settings-hub">
      <PageHeading title={t('settings.title', 'Settings')} />
      <SettingsPage dashboard={dashboard} locale={locale} setLocale={setLocale} reload={reload} t={t} />
      <Disclosure className="settings-section" testId="tc-cc-regression-details" summary={t('settings.automaticChecks', 'Automatic test results')} hint={t('settings.automaticChecksHint', 'Import existing results or connect approved CI artifacts.')}>
        <RegressionPage dashboard={dashboard} reload={reload} t={t} />
      </Disclosure>
      <Disclosure className="settings-section" summary={t('settings.diagnostics', 'Diagnostics')} hint={t('settings.diagnosticsHint', 'Source status, safe commands, and product details.')}>
        <AdvancedPage dashboard={dashboard} />
      </Disclosure>
      <TrustSafety dashboard={dashboard} t={t} />
    </div>
  );
}

function friendlyNextAction(dashboard, t) {
  const findings = dashboard.findings ?? {};
  const resultCount = dashboard.review?.visual_review?.summary?.result_count ?? dashboard.evidence?.visual_review_results?.length ?? 0;
  const decisionCount = findings.owner_decision_requests ?? 0;
  if (decisionCount > 0) return t('next.decide', 'Review the improvements that need your decision');
  if (resultCount > 0) return t('next.review', 'Review the latest local result');
  return t('next.prepare', 'Prepare your first check');
}

function friendlyActionError(_error, t) {
  return t('action.genericError', 'Check the entered information and try again. Technical details remain available in Settings.');
}

function sourceTypeLabel(sourceType, t) {
  const labels = {
    video: t('sourceType.video', 'Video transcript'),
    web_page: t('sourceType.webPage', 'Web page text'),
    pdf: t('sourceType.pdf', 'PDF text'),
    meeting_notes: t('sourceType.meetingNotes', 'Meeting notes'),
    document: t('sourceType.document', 'Document'),
    transcript: t('sourceType.transcript', 'Transcript'),
    other: t('sourceType.other', 'Other text')
  };
  return labels[sourceType] ?? labels.other;
}

function SettingsPage({ dashboard, locale, setLocale, reload, t }) {
  const language = dashboard.settings?.display_language ?? {};
  const locales = language.supported_locales ?? [];
  const [selectedLocale, setSelectedLocale] = useState(locale);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setSelectedLocale(locale);
  }, [locale]);

  async function submit(event) {
    event.preventDefault();
    setError(null);
    setStatus(null);
    setSaving(true);
    try {
      const saved = await setDisplayLanguage({
        locale: selectedLocale,
        confirm: language.write_confirm
      });
      setLocale(saved.locale);
      setStatus(t('settings.applied', 'Language saved'));
      await reload();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-grid">
      <section className="panel">
        <div className="panel-header-inline">
          <div>
            <p className="eyebrow">{t('settings.title', 'Settings')}</p>
            <h2>{t('settings.languageTitle', 'Display language')}</h2>
          </div>
          <StatusBadge status={language.status ?? 'configured'} />
        </div>
        <p className="muted">{t('settings.languageCaption', 'This changes Control Center chrome only. It does not translate source evidence or generated review text.')}</p>
        <form className="control-form compact" onSubmit={submit}>
          <label>
            {t('settings.language', 'Control Center language')}
            <select aria-label={t('settings.language', 'Display language')} value={selectedLocale} onChange={(event) => {
              setSelectedLocale(event.target.value);
              setLocale(event.target.value);
            }}>
              {locales.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.native_name} / {item.english_name}
                </option>
              ))}
            </select>
          </label>
          <button className="primary-action" type="submit" disabled={saving}>
            {saving ? 'Saving...' : t('settings.save', 'Save language')}
          </button>
        </form>
        {status ? <StatePanel title={status} text={selectedLocale} /> : null}
        {error ? <StatePanel title="Cannot save language" text={error} tone="danger" /> : null}
      </section>
      <section className="panel" data-testid="tc-cc-settings-persistence-status">
        <h2>Language state</h2>
        <dl className="definition-list">
          <div><dt>{t('settings.current', 'Current locale')}</dt><dd>{language.current_locale ?? locale}</dd></div>
          <div><dt>Intl</dt><dd>{language.intl_locale ?? 'en-US'}</dd></div>
          <div><dt>{t('settings.direction', 'Text direction')}</dt><dd>{language.text_direction ?? 'ltr'}</dd></div>
          <div><dt>{t('settings.storage', 'Settings storage')}</dt><dd>{language.settings_path ?? 'ops/DASHBOARD_SETTINGS.json'}</dd></div>
          <div><dt>Translation</dt><dd>{language.translation_execution_enabled ? 'enabled' : 'disabled'}</dd></div>
        </dl>
      </section>
      <PlaywrightModeSettings dashboard={dashboard} reload={reload} t={t} />
    </div>
  );
}

function PlaywrightModeSettings({ dashboard, reload, t }) {
  const settings = dashboard.settings?.playwright_test ?? {};
  const labels = settings.labels ?? {};
  const modes = settings.supported_modes ?? ['disabled', 'import_only', 'local_run', 'external_ci'];
  const [selectedMode, setSelectedMode] = useState(settings.selected_mode ?? 'disabled');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setSelectedMode(settings.selected_mode ?? 'disabled');
  }, [settings.selected_mode]);

  async function submit(event) {
    event.preventDefault();
    setError(null);
    setStatus(null);
    setSaving(true);
    try {
      const saved = await setPlaywrightTestMode({
        mode: selectedMode,
        confirm: settings.write_confirm
      });
      setStatus(`${saved.mode}`);
      await reload();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" data-testid="tc-cc-settings-playwright-test-mode">
      <div className="panel-header-inline">
        <div>
          <p className="eyebrow">{t('settings.title', 'Settings')}</p>
          <h2>{t('settings.playwrightTitle', 'Playwright Test mode')}</h2>
        </div>
        <StatusBadge status={settings.status ?? 'configured'} />
      </div>
      <p className="muted">{t('settings.playwrightCaption', 'This only changes how Control Center may use Playwright Test evidence. Saving does not run a browser or contact CI.')}</p>
      <form className="control-form compact" onSubmit={submit}>
        <label>
          {t('settings.playwrightTitle', 'Playwright Test mode')}
          <select aria-label={t('settings.playwrightTitle', 'Playwright Test mode')} value={selectedMode} onChange={(event) => setSelectedMode(event.target.value)}>
            {modes.map((mode) => <option key={mode} value={mode}>{labels[mode] ?? mode}</option>)}
          </select>
        </label>
        <p className="mode-note" data-testid="tc-cc-playwright-test-mode-note">
          {playwrightModeNote(selectedMode, t)}
        </p>
        <button className="primary-action" type="submit" disabled={saving}>
          {saving ? t('common.saving', 'Saving...') : t('settings.playwrightSave', 'Save mode')}
        </button>
      </form>
      {status ? <StatePanel title={t('settings.playwrightSaved', 'Mode saved')} text={status} /> : null}
      {error ? <StatePanel title={t('settings.playwrightCannotSave', 'Cannot save mode')} text={error} tone="danger" /> : null}
    </section>
  );
}

function RegressionPage({ dashboard, reload, t }) {
  const regression = dashboard.regression?.playwright_test ?? {};
  const [importForm, setImportForm] = useState(DEFAULT_PLAYWRIGHT_IMPORT_FORM);
  const [ciForm, setCiForm] = useState(DEFAULT_PLAYWRIGHT_CI_FORM);
  const [approvedCiForm, setApprovedCiForm] = useState(() => approvedFetchToForm(regression.external_ci?.approved_fetch));
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [settingsStatus, setSettingsStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setApprovedCiForm(approvedFetchToForm(regression.external_ci?.approved_fetch));
  }, [regression.external_ci?.approved_fetch?.approval_hash]);

  function updateImport(key, value) {
    setImportForm((current) => ({ ...current, [key]: value }));
  }

  function updateCi(key, value) {
    setCiForm((current) => ({ ...current, [key]: value }));
  }

  function updateApprovedCi(key, value) {
    setApprovedCiForm((current) => ({ ...current, [key]: value }));
  }

  async function submitImport(event) {
    event.preventDefault();
    setError(null);
    setResult(null);
    if (!importForm.local_write_confirmed) {
      setError(t('regression.importConfirmRequired', 'Confirm local Playwright Test result import before continuing.'));
      return;
    }
    setBusy('import');
    try {
      const imported = await importPlaywrightTestResult({
        input: importForm.input,
        confirm: regression.confirmations?.import_result
      });
      setResult(imported);
      await reload();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setBusy(null);
    }
  }

  async function submitCi(event) {
    event.preventDefault();
    setError(null);
    setResult(null);
    if (!ciForm.execute_confirmed) {
      setError(t('regression.ciConfirmRequired', 'Confirm CI artifact fetch before continuing.'));
      return;
    }
    setBusy('ci');
    try {
      const fetched = await fetchPlaywrightTestCiArtifact({
        repo: ciForm.repo,
        run_id: ciForm.run_id,
        artifact_name: ciForm.artifact_name,
        execute_confirmed: true,
        confirm: regression.confirmations?.external_ci_fetch
      });
      setResult(fetched);
      await reload();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setBusy(null);
    }
  }

  async function submitSuggestSettings(event) {
    event.preventDefault();
    setError(null);
    setResult(null);
    setSettingsStatus(null);
    setBusy('ci-suggest');
    try {
      const suggestion = await suggestPlaywrightTestCiSettings({
        repo: approvedCiForm.repo,
        workflow_name: approvedCiForm.workflow_name,
        branch: approvedCiForm.branch,
        event: approvedCiForm.event,
        artifact_name: approvedCiForm.artifact_name,
        target_policy: approvedCiForm.target_policy,
        head_sha: approvedCiForm.head_sha,
        limit: approvedCiForm.limit,
        max_age_hours: approvedCiForm.max_age_hours,
        confirm: regression.confirmations?.external_ci_suggest_settings
      });
      const candidate = suggestion.candidate ?? {};
      setApprovedCiForm((current) => ({
        ...current,
        repo: candidate.repo ?? current.repo,
        workflow_name: candidate.workflow_name ?? current.workflow_name,
        branch: candidate.branch ?? current.branch,
        event: candidate.event ?? current.event,
        artifact_name: candidate.artifact_name ?? current.artifact_name,
        target_policy: candidate.target_policy ?? current.target_policy,
        head_sha: candidate.head_sha ?? current.head_sha,
        limit: candidate.limit ?? current.limit,
        max_age_hours: candidate.max_age_hours ?? current.max_age_hours
      }));
      setSettingsStatus(suggestion.status ?? 'suggested');
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setBusy(null);
    }
  }

  async function submitApproveSettings(event) {
    event.preventDefault();
    setError(null);
    setResult(null);
    setSettingsStatus(null);
    setBusy('ci-approve');
    try {
      const approved = await approvePlaywrightTestCiSettings({
        repo: approvedCiForm.repo,
        workflow_name: approvedCiForm.workflow_name,
        branch: approvedCiForm.branch,
        event: approvedCiForm.event,
        artifact_name: approvedCiForm.artifact_name,
        target_policy: approvedCiForm.target_policy,
        head_sha: approvedCiForm.head_sha,
        limit: approvedCiForm.limit,
        max_age_hours: approvedCiForm.max_age_hours,
        confirm: regression.confirmations?.external_ci_approve_settings
      });
      setSettingsStatus(approved.status ?? 'approved');
      await reload();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setBusy(null);
    }
  }

  async function submitApprovedFetch(event) {
    event.preventDefault();
    setError(null);
    setResult(null);
    if (!approvedCiForm.fetch_confirmed) {
      setError(t('regression.approvedCiConfirmRequired', 'Confirm approved CI artifact fetch before continuing.'));
      return;
    }
    setBusy('ci-approved-fetch');
    try {
      const fetched = await fetchApprovedPlaywrightTestCiArtifact({
        execute_confirmed: true,
        confirm: regression.confirmations?.external_ci_fetch_approved
      });
      setResult(fetched);
      await reload();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page-grid" data-testid="tc-cc-playwright-test-regression-page">
      <section className="panel primary-panel">
        <p className="eyebrow">{t('regression.title', 'Regression checks')}</p>
        <h2>{regression.status_label ?? t('regression.emptyTitle', 'No Playwright Test result imported.')}</h2>
        <p>{t('regression.caption', 'Import existing Playwright Test results or fetch a finished CI artifact. Local test execution stays CLI-only.')}</p>
        <div className="metric-row">
          <Metric label="Mode" value={regression.labels?.[regression.selected_mode] ?? regression.selected_mode ?? 'disabled'} />
          <Metric label="Total" value={regression.last_result?.total_count ?? 0} />
          <Metric label="Failed" value={regression.last_result?.failed_count ?? 0} />
        </div>
      </section>
      {regression.review_projection ? <PlaywrightReviewMaterial projection={regression.review_projection} t={t} /> : null}
      <section className="panel">
        <div className="panel-header-inline">
          <div>
            <p className="eyebrow">Playwright Test</p>
            <h2>{t('regression.importTitle', 'Import result')}</h2>
          </div>
          <StatusBadge status="available" label={t('regression.localImportAvailable', 'Local import available')} />
        </div>
        <form className="control-form compact" onSubmit={submitImport}>
          <label>
            {t('regression.resultFile', 'Result file')}
            <input aria-label={t('regression.resultFile', 'Result file')} value={importForm.input} onChange={(event) => updateImport('input', event.target.value)} placeholder="test-results/results.json" />
          </label>
          <label className="check-row">
            <input type="checkbox" aria-label={t('regression.importConfirmLabel', 'Import this local result into TraceCue')} checked={importForm.local_write_confirmed} onChange={(event) => updateImport('local_write_confirmed', event.target.checked)} />
            {t('regression.importConfirmLabel', 'Import this local result into TraceCue')}
          </label>
          <button className="primary-action" type="submit" disabled={busy === 'import'}>
            {busy === 'import' ? t('regression.importBusy', 'Importing...') : t('regression.importSubmit', 'Import result')}
          </button>
        </form>
      </section>
      <section className="panel" data-testid="tc-cc-playwright-test-ci-approved-settings">
        <div className="panel-header-inline">
          <div>
            <p className="eyebrow">GitHub Actions</p>
            <h2>{t('regression.ciApprovedTitle', 'Approved CI settings')}</h2>
          </div>
          <StatusBadge status={regression.external_ci?.approved_fetch?.configured ? 'approved' : 'not_configured'} />
        </div>
        <ApprovedCiPolicySummary approvedFetch={regression.external_ci?.approved_fetch} form={approvedCiForm} t={t} />
        <form className="control-form compact" onSubmit={submitApproveSettings}>
          <label>
            {t('regression.repo', 'Repository')}
            <input aria-label={t('regression.repo', 'Repository')} value={approvedCiForm.repo} onChange={(event) => updateApprovedCi('repo', event.target.value)} placeholder="owner/repo" />
          </label>
          <div className="form-grid">
            <label>
              {t('regression.workflow', 'Workflow')}
              <input aria-label={t('regression.workflow', 'Workflow')} value={approvedCiForm.workflow_name} onChange={(event) => updateApprovedCi('workflow_name', event.target.value)} placeholder="CI" />
            </label>
            <label>
              {t('regression.branch', 'Branch')}
              <input aria-label={t('regression.branch', 'Branch')} value={approvedCiForm.branch} onChange={(event) => updateApprovedCi('branch', event.target.value)} placeholder="main" />
            </label>
          </div>
          <div className="form-grid">
            <label>
              {t('regression.event', 'Event')}
              <input aria-label={t('regression.event', 'Event')} value={approvedCiForm.event} onChange={(event) => updateApprovedCi('event', event.target.value)} placeholder="push" />
            </label>
            <label>
              {t('regression.artifactName', 'Artifact name')}
              <input aria-label={t('regression.artifactName', 'Artifact name')} value={approvedCiForm.artifact_name} onChange={(event) => updateApprovedCi('artifact_name', event.target.value)} placeholder="playwright-report" />
            </label>
          </div>
          <div className="form-grid">
            <label>
              {t('regression.targetPolicy', 'Target policy')}
              <select aria-label={t('regression.targetPolicy', 'Target policy')} value={approvedCiForm.target_policy} onChange={(event) => updateApprovedCi('target_policy', event.target.value)}>
                <option value="latest_successful_run">{t('regression.targetPolicyLatestRun', 'Latest successful run')}</option>
                <option value="latest_successful_branch_run">{t('regression.targetPolicyLatestBranchRun', 'Latest successful branch run')}</option>
                <option value="specific_head_sha">{t('regression.targetPolicySpecificHeadSha', 'Specific commit SHA')}</option>
              </select>
            </label>
            <label>
              {t('regression.headSha', 'Commit SHA')}
              <input aria-label={t('regression.headSha', 'Commit SHA')} value={approvedCiForm.head_sha} onChange={(event) => updateApprovedCi('head_sha', event.target.value)} placeholder="40-character SHA" />
            </label>
          </div>
          <div className="form-grid">
            <label>
              {t('regression.maxAgeHours', 'Max age hours')}
              <input aria-label={t('regression.maxAgeHours', 'Max age hours')} type="number" min="1" max="2160" value={approvedCiForm.max_age_hours} onChange={(event) => updateApprovedCi('max_age_hours', event.target.value)} />
            </label>
            <label>
              {t('regression.runLookupLimit', 'Run lookup limit')}
              <input aria-label={t('regression.runLookupLimit', 'Run lookup limit')} type="number" min="1" max="50" value={approvedCiForm.limit} onChange={(event) => updateApprovedCi('limit', event.target.value)} />
            </label>
          </div>
          <div className="action-row">
            <button className="secondary-action" type="button" disabled={busy === 'ci-suggest'} onClick={submitSuggestSettings}>
              {busy === 'ci-suggest' ? t('regression.ciSuggestBusy', 'Checking...') : t('regression.ciSuggest', 'Suggest settings')}
            </button>
            <button className="primary-action" type="submit" disabled={busy === 'ci-approve'}>
              {busy === 'ci-approve' ? t('common.saving', 'Saving...') : t('regression.ciApprove', 'Approve settings')}
            </button>
          </div>
        </form>
        <form className="control-form compact" onSubmit={submitApprovedFetch}>
          <label className="check-row">
            <input type="checkbox" aria-label={t('regression.ciFetchApprovedConfirmLabel', 'Fetch the latest matching approved CI artifact')} checked={approvedCiForm.fetch_confirmed} onChange={(event) => updateApprovedCi('fetch_confirmed', event.target.checked)} />
            {t('regression.ciFetchApprovedConfirmLabel', 'Fetch the latest matching approved CI artifact')}
          </label>
          <button className="primary-action" type="submit" disabled={busy === 'ci-approved-fetch' || !regression.external_ci?.approved_fetch?.configured}>
            {busy === 'ci-approved-fetch' ? t('regression.ciFetchBusy', 'Fetching...') : t('regression.ciFetchApproved', 'Fetch approved artifact')}
          </button>
        </form>
        {settingsStatus ? <StatePanel title={t('regression.ciSettingsStatus', 'CI settings')} text={settingsStatus} /> : null}
      </section>
      <section className="panel">
        <div className="panel-header-inline">
          <div>
            <p className="eyebrow">GitHub Actions</p>
            <h2>{t('regression.ciTitle', 'Fetch CI artifact')}</h2>
          </div>
          <StatusBadge status={regression.selected_mode === 'external_ci' ? 'available' : 'optional'} />
        </div>
        <form className="control-form compact" onSubmit={submitCi}>
          <label>
            {t('regression.repo', 'Repository')}
            <input aria-label={t('regression.repo', 'Repository')} value={ciForm.repo} onChange={(event) => updateCi('repo', event.target.value)} placeholder="owner/repo" />
          </label>
          <div className="form-grid">
            <label>
              {t('regression.runId', 'Run ID')}
              <input aria-label={t('regression.runId', 'Run ID')} value={ciForm.run_id} onChange={(event) => updateCi('run_id', event.target.value)} inputMode="numeric" />
            </label>
            <label>
              {t('regression.artifactName', 'Artifact name')}
              <input aria-label={t('regression.artifactName', 'Artifact name')} value={ciForm.artifact_name} onChange={(event) => updateCi('artifact_name', event.target.value)} />
            </label>
          </div>
          <label className="check-row">
            <input type="checkbox" aria-label={t('regression.ciFetchConfirmLabel', 'Fetch this finished CI artifact with read-only gh')} checked={ciForm.execute_confirmed} onChange={(event) => updateCi('execute_confirmed', event.target.checked)} />
            {t('regression.ciFetchConfirmLabel', 'Fetch this finished CI artifact with read-only gh')}
          </label>
          <button className="primary-action" type="submit" disabled={busy === 'ci'}>
            {busy === 'ci' ? t('regression.ciFetchBusy', 'Fetching...') : t('regression.ciSubmit', 'Fetch artifact')}
          </button>
        </form>
      </section>
      {error ? <StatePanel title={t('regression.cannotUpdate', 'Cannot update regression evidence')} text={error} tone="danger" /> : null}
      {result ? <PlaywrightResultPanel result={result} /> : null}
    </div>
  );
}

function PlaywrightReviewMaterial({ projection, t }) {
  const cards = Array.isArray(projection.review_cards) ? projection.review_cards : [];
  const failures = cards.filter((card) => card.type === 'failed_scenario').slice(0, 3);
  const guidanceCards = cards.filter((card) => card.type !== 'failed_scenario').slice(0, 3);
  return (
    <section className="panel primary-panel" data-testid="tc-cc-playwright-test-review-material">
      <div className="panel-header-inline">
        <div>
          <p className="eyebrow">{t('regression.reviewEyebrow', 'Review material')}</p>
          <h2>{projection.owner_summary?.headline ?? projection.result?.status_label ?? 'Playwright Test review material'}</h2>
        </div>
        <StatusBadge status={projection.evidence_quality?.status ?? projection.result?.status} />
      </div>
      <p>{projection.owner_summary?.plain_language_summary ?? projection.next_action}</p>
      <div className="metric-row">
        <Metric label={t('regression.reviewFailed', 'Failed')} value={projection.result?.failed_count ?? 0} />
        <Metric label={t('regression.reviewFlaky', 'Flaky')} value={projection.result?.flaky_count ?? 0} />
        <Metric label={t('regression.reviewComparison', 'Comparison')} value={projection.comparison?.direction ?? 'none'} />
      </div>
      {failures.length > 0 ? (
        <ul className="result-list review-card-list" aria-label={t('regression.failedScenarios', 'Failed scenarios')}>
          {failures.map((card) => (
            <li key={card.id}>
              <div>
                <strong>{card.title}</strong>
                <p>{card.body}</p>
              </div>
              <StatusBadge status={card.status} />
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="definition-list">
        <div><dt>{t('regression.nextAction', 'Next action')}</dt><dd>{projection.next_action}</dd></div>
        <div><dt>{t('regression.evidenceQuality', 'Evidence quality')}</dt><dd>{projection.evidence_quality?.signals?.[0] ?? 'No evidence quality signal.'}</dd></div>
        <div><dt>{t('regression.rawContent', 'Raw content')}</dt><dd>{projection.raw_content_included ? 'included' : 'hidden'}</dd></div>
        <div><dt>{t('regression.reviewScope', 'Review scope')}</dt><dd>{t('regression.reviewScopeValue', 'Top 3 failures and top 3 guidance cards')}</dd></div>
      </dl>
      {guidanceCards.length > 0 ? (
        <ul className="status-list review-guidance-list" aria-label={t('regression.guidanceCards', 'Guidance cards')}>
          {guidanceCards.map((card) => (
            <li key={card.id}>
              <span>{card.title}</span>
              <span>{card.owner_action}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function approvedFetchToForm(approvedFetch = {}) {
  if (!approvedFetch?.configured) {
    return DEFAULT_PLAYWRIGHT_APPROVED_CI_FORM;
  }
  return {
    repo: approvedFetch.repo ?? '',
    workflow_name: approvedFetch.workflow_name ?? '',
    branch: approvedFetch.branch ?? '',
    event: approvedFetch.event ?? '',
    artifact_name: approvedFetch.artifact_name ?? '',
    target_policy: approvedFetch.target_policy ?? 'latest_successful_run',
    head_sha: approvedFetch.head_sha ?? '',
    limit: approvedFetch.limit ?? 20,
    max_age_hours: approvedFetch.max_age_hours ?? 168,
    fetch_confirmed: false
  };
}

function ApprovedCiPolicySummary({ approvedFetch = {}, form = {}, t }) {
  const source = approvedFetch?.configured ? approvedFetch : form;
  return (
    <dl className="definition-list policy-summary" data-testid="tc-cc-approved-ci-policy-summary">
      <div><dt>{t('regression.targetPolicy', 'Target policy')}</dt><dd>{policyLabel(source.target_policy, t)}</dd></div>
      <div><dt>{t('regression.maxAgeHours', 'Max age hours')}</dt><dd>{displayText(source.max_age_hours, t)}</dd></div>
      <div><dt>{t('regression.runLookupLimit', 'Run lookup limit')}</dt><dd>{displayText(source.limit, t)}</dd></div>
      <div><dt>{t('regression.headSha', 'Commit SHA')}</dt><dd>{displayText(source.head_sha, t)}</dd></div>
      <div><dt>{t('regression.approvedAt', 'Approved at')}</dt><dd>{displayText(source.approved_at, t)}</dd></div>
    </dl>
  );
}

function PlaywrightResultPanel({ result }) {
  const summary = result.summary ?? {};
  return (
    <section className="panel primary-panel">
      <p className="eyebrow">Result</p>
      <h2>{result.status_label ?? result.status ?? 'Updated'}</h2>
      <div className="metric-row">
        <Metric label="Total" value={summary.total_count ?? 0} />
        <Metric label="Passed" value={summary.passed_count ?? 0} />
        <Metric label="Failed" value={summary.failed_count ?? 0} />
      </div>
      <dl className="definition-list">
        <div><dt>Source</dt><dd>{result.source?.kind ?? result.kind ?? 'playwright_test'}</dd></div>
        <div><dt>Raw content</dt><dd>{result.raw_content_included || summary.raw_content_included ? 'included' : 'hidden'}</dd></div>
        <div><dt>Gate effect</dt><dd>{result.boundary?.gate_effect ?? 'none'}</dd></div>
      </dl>
    </section>
  );
}

function ReviewPage({ dashboard }) {
  const review = dashboard.review;
  return (
    <div className="page-grid">
      <section className="panel primary-panel">
        <p className="eyebrow">Next action</p>
        <h2>{review.next_action}</h2>
        <p>{review.can_owner_review_proceed ? 'Owner review can proceed from the available local evidence.' : 'Use this as a status view until the required evidence is ready.'}</p>
      </section>
      <section className="panel">
        <h2>Top owner actions</h2>
        <ActionList actions={review.top_owner_actions} fallback={review.next_action} />
      </section>
      <section className="metric-row" aria-label="Readiness summary">
        <Metric label="Visual results" value={review.visual_review.summary.result_count} />
        <Metric label="Findings" value={review.visual_review.summary.advisory_findings} />
        <Metric label="Owner asks" value={review.visual_review.summary.owner_decision_requests} />
      </section>
    </div>
  );
}

function EvidencePage({ dashboard }) {
  const matrix = dashboard.evidence.owner_review_matrix;
  const visual = dashboard.evidence.visual_review_results;
  return (
    <div className="page-grid">
      <section className="panel">
        <h2>Owner evidence matrix</h2>
        {matrix ? <EvidenceMatrix matrix={matrix} /> : <StatePanel title="No owner evidence set" text="Launch status with an evidence set to show standard, deep, and xhigh readiness." />}
      </section>
      <section className="panel">
        <h2>Visual review results</h2>
        <ResultList results={visual} />
      </section>
    </div>
  );
}

function FindingsPage({ dashboard }) {
  const findings = dashboard.findings;
  return (
    <div className="page-grid">
      <section className="metric-row">
        <Metric label="Advisory findings" value={findings.visual_review.advisory_findings} />
        <Metric label="Owner decisions" value={findings.owner_decision_requests} />
        <Metric label="Blocker groups" value={findings.blockers?.groups?.length ?? 0} />
      </section>
      <section className="panel">
        <h2>Latest findings</h2>
        <ResultList results={findings.visual_review.top_results} />
      </section>
      <section className="panel">
        <h2>Blockers</h2>
        <BlockerList blockers={findings.blockers} />
      </section>
    </div>
  );
}

function AdvancedPage({ dashboard }) {
  const metadata = designSystemMetadata();
  return (
    <div className="page-grid">
      <section className="panel">
        <h2>Source status</h2>
        <ul className="status-list">
          {dashboard.advanced.source_statuses.map((source) => (
            <li key={source.source}>
              <span>{source.source}</span>
              <StatusBadge status={source.status} />
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h2>Safe commands</h2>
        <dl className="command-list">
          {Object.entries(dashboard.advanced.commands).map(([name, command]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{command}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="panel">
        <h2>Design system</h2>
        <p>Tokens: {metadata.token_schema_version}. Components: {metadata.component_ids.join(', ') || 'none'}.</p>
      </section>
    </div>
  );
}

function ActionList({ actions, fallback }) {
  const list = actions.length > 0 ? actions : [fallback];
  return (
    <ol className="action-list">
      {list.slice(0, 3).map((action, index) => (
        <li key={`${action}-${index}`}>{typeof action === 'string' ? action : action.action}</li>
      ))}
    </ol>
  );
}

function EvidenceMatrix({ matrix, t = (_key, fallback) => fallback }) {
  const rows = Array.isArray(matrix.rows) ? matrix.rows : [];
  if (rows.length === 0) {
    return <StatePanel title="No matrix rows" text="The owner review pack did not include matrix rows." />;
  }
  return (
    <div className="matrix" role="table" aria-label={t('evidence.matrix', 'Evidence matrix')}>
      <div className="matrix-row header" role="row">
        <span role="columnheader">{t('evidence.case', 'Case')}</span>
        <span role="columnheader">{t('reviewMethod.standard.label', 'Key improvements')}</span>
        <span role="columnheader">{t('reviewMethod.deep.label', 'Detailed check')}</span>
        <span role="columnheader">{t('reviewMethod.xhigh.label', 'Thorough check')}</span>
      </div>
      {rows.map((row, index) => (
        <div className="matrix-row" role="row" key={row.case_id ?? index}>
          <span role="cell">{row.case_id ?? row.label ?? `Case ${index + 1}`}</span>
          <span role="cell" data-label={t('reviewMethod.standard.label', 'Key improvements')}><StatusBadge status={cellStatus(row, 'standard')} /></span>
          <span role="cell" data-label={t('reviewMethod.deep.label', 'Detailed check')}><StatusBadge status={cellStatus(row, 'deep')} /></span>
          <span role="cell" data-label={t('reviewMethod.xhigh.label', 'Thorough check')}><StatusBadge status={cellStatus(row, 'xhigh')} /></span>
        </div>
      ))}
    </div>
  );
}

function ResultList({ results }) {
  if (!Array.isArray(results) || results.length === 0) {
    return <StatePanel title="No results" text="No local visual review result summary is available yet." />;
  }
  return (
    <ul className="result-list">
      {results.map((result, index) => (
        <li key={result.id ?? index}>
          <div>
            <strong>{result.id ?? `Result ${index + 1}`}</strong>
            <p>{result.summary || 'No summary text was available.'}</p>
          </div>
          <div className="result-counts">
            <span>{result.finding_count ?? 0} findings</span>
            <span>{result.owner_decision_requests ?? 0} asks</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function BlockerList({ blockers }) {
  const groups = Array.isArray(blockers?.groups) ? blockers.groups : [];
  if (groups.length === 0) {
    return <StatePanel title="No grouped blockers" text="No owner-facing blocker group is present in the current read model." />;
  }
  return (
    <ul className="status-list">
      {groups.slice(0, 3).map((group, index) => (
        <li key={group.id ?? index}>
          <span>{group.label ?? group.id ?? `Group ${index + 1}`}</span>
          <span>{group.count ?? group.items?.length ?? 0}</span>
        </li>
      ))}
    </ul>
  );
}

function TrustSafety({ dashboard, t }) {
  const safety = dashboard?.review?.trust_safety;
  return (
    <div className="safety-strip">
      <span>{t('safety.localWrite', 'Local artifact write')}</span>
      <span>{safety?.local_only === false ? 'External' : 'Local'}</span>
      <span>{t('safety.noProvider', 'No provider')}</span>
      <span>{t('safety.noUpload', 'No upload')}</span>
      <span>{safety?.gate_effect ?? 'none'}</span>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value ?? 0}</strong>
    </div>
  );
}

function StatePanel({ title, text, tone = 'neutral' }) {
  return (
    <section className={`state-panel ${tone}`}>
      <h2>{title}</h2>
      <p>{text}</p>
    </section>
  );
}

function StatusBadge({ status, label }) {
  const normalized = String(status ?? 'missing').replaceAll('_', ' ');
  return <span className={`status-badge ${toneForStatus(status)}`}>{label ?? normalized}</span>;
}

function cellStatus(row, effort) {
  const value = row[effort] ?? row.efforts?.[effort] ?? row.cells?.[effort];
  if (typeof value === 'string') {
    return value;
  }
  return value?.status ?? value?.state ?? 'missing';
}

function toneForStatus(status) {
  if (['ready', 'ok', 'available', 'configured', 'proposal_ready', 'ready_for_owner_review', 'approved', 'passed', 'downloaded', 'usable', 'suggested', 'import_available'].includes(status)) return 'ready';
  if (['blocked', 'error', 'failed', 'evidence_missing', 'missing_required'].includes(status)) return 'blocked';
  if (['needs_attention', 'incomplete', 'prepared', 'owner_review_recommended', 'optional', 'disabled', 'not_configured', 'stale', 'limited', 'advisory', 'missing'].includes(status)) return 'attention';
  return 'missing';
}

function playwrightModeNote(mode, t) {
  const notes = {
    disabled: t('settings.playwrightModeDisabled', 'Disabled: Playwright Test evidence stays off. Existing TraceCue review behavior is unchanged.'),
    import_only: t('settings.playwrightModeImportOnly', 'Import only: existing result files can be imported. Browsers and CI are not started.'),
    local_run: t('settings.playwrightModeLocalRun', 'Local run: CLI only. The browser UI stores the mode but does not run Playwright Test.'),
    external_ci: t('settings.playwrightModeExternalCi', 'External CI: existing GitHub Actions artifacts can be fetched with explicit confirmation. CI is not triggered.')
  };
  return notes[mode] ?? t('settings.playwrightModeUnknown', 'This mode changes evidence handling only.');
}

function displayText(value, t) {
  if (value === undefined || value === null || value === '') {
    return t('common.none', 'none');
  }
  return String(value);
}

function policyLabel(value, t) {
  const labels = {
    latest_successful_run: t('regression.targetPolicyLatestRun', 'Latest successful run'),
    latest_successful_branch_run: t('regression.targetPolicyLatestBranchRun', 'Latest successful branch run'),
    specific_head_sha: t('regression.targetPolicySpecificHeadSha', 'Specific commit SHA')
  };
  return labels[value] ?? displayText(value, t);
}
