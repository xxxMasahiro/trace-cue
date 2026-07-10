import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAgenticReviewConfirmation,
  fetchAgenticReviewStatus,
  fetchDashboard,
  prepareAgenticReview,
  repeatAgenticReview,
  saveAgenticReviewDecision,
  setControlCenterPreferences,
  setDisplayLanguage,
  setPlaywrightTestMode,
  startAgenticReview
} from './apiClient.js';
import { designSystemStyle } from './designSystem.js';
import { createTranslator } from './i18n.js';
import { PAGES, WORKFLOW_STAGES } from './pageDefinitions.js';
import { REVIEW_METHOD_IDS, reviewMethodCopy } from './reviewMethods.js';
import { useControlCenterRoute } from './useControlCenterRoute.js';

const ACTIVE_STATES = new Set(['queued', 'preparing', 'dispatching', 'running', 'validating', 'in_progress', 'fetching']);
const COMPLETE_STATES = new Set(['completed', 'complete', 'ready', 'success']);
const FAILED_STATES = new Set(['failed', 'error', 'blocked', 'timed_out']);
const DEFAULT_REVIEW = { url: '', purpose: '', review_method: 'standard' };

export default function App() {
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [locale, setLocale] = useState('en');
  const { route, navigate } = useControlCenterRoute();
  const t = useMemo(() => createTranslator(locale).t, [locale]);
  const style = useMemo(() => designSystemStyle(), []);

  async function loadDashboard({ quiet = false } = {}) {
    if (!quiet) setLoading(true);
    setLoadError(false);
    try {
      const next = await fetchDashboard();
      setDashboard(next);
      setLocale(readLocale(next));
    } catch {
      setLoadError(true);
    } finally {
      if (!quiet) setLoading(false);
    }
  }

  useEffect(() => { loadDashboard(); }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);
  useEffect(() => {
    if (!loading && !loadError) window.requestAnimationFrame(() => document.querySelector('[data-page-heading]')?.focus());
  }, [route.page, route.view, route.itemId, loading, loadError]);

  const items = useMemo(() => normalizeItems(dashboard?.agentic_review?.items), [dashboard]);
  const runningCount = items.filter((item) => isActive(item.state)).length;

  return (
    <main className="app-shell" style={style}>
      <aside className="side-nav" aria-label={t('nav.primary', 'Main menu')}>
        <button className="brand-button" type="button" onClick={() => navigate({ page: 'confirm', view: 'list' })}>
          <span className="brand-mark" aria-hidden="true">T</span><span>TraceCue</span>
        </button>
        <nav className="nav-list">
          {PAGES.map((page) => (
            <button
              key={page.id}
              type="button"
              className={`nav-item${route.page === page.id ? ' active' : ''}`}
              aria-current={route.page === page.id ? 'page' : undefined}
              onClick={() => navigate({ page: page.id, view: 'list' })}
            >
              <span className="nav-icon" aria-hidden="true">{page.icon}</span>
              <span>{t(page.labelKey, page.fallback)}</span>
              {page.id === 'running' && runningCount > 0 ? <span className="nav-count" aria-label={t('aria.runningCount', 'Reviews in progress')}>{runningCount}</span> : null}
            </button>
          ))}
        </nav>
        <p className="side-note">{t('app.localOnly', 'Local workspace')}</p>
      </aside>

      <section className="workspace">
        {loading ? <StatePanel title={t('state.loading.title', 'Loading your reviews')} text={t('state.loading.text', 'Reading the latest status.')} /> : null}
        {!loading && loadError ? <StatePanel title={t('state.loadError.title', 'Your reviews could not be loaded')} text={t('state.loadError.text', 'Check that the Control Center is running, then try again.')} action={<button className="primary-action" type="button" onClick={() => loadDashboard()}>{t('common.retry', 'Try again')}</button>} tone="danger" /> : null}
        {!loading && !loadError ? (
          <ControlCenter
            dashboard={dashboard ?? {}}
            items={items}
            locale={locale}
            setLocale={setLocale}
            route={route}
            navigate={navigate}
            reload={loadDashboard}
            t={t}
          />
        ) : null}
      </section>
    </main>
  );
}

function ControlCenter({ dashboard, items, locale, setLocale, route, navigate, reload, t }) {
  if (route.page === 'running') return <RunningPage items={items} navigate={navigate} reload={reload} t={t} />;
  if (route.page === 'settings') return <SettingsPage dashboard={dashboard} locale={locale} setLocale={setLocale} reload={reload} t={t} />;
  if (route.view === 'new') return <NewReviewPage dashboard={dashboard} navigate={navigate} reload={reload} t={t} />;
  if (route.view === 'work' && route.itemId) return <ReviewWorkspace reviewId={route.itemId} navigate={navigate} reload={reload} t={t} />;
  return <HomePage items={items} navigate={navigate} reload={reload} t={t} />;
}

function HomePage({ items, navigate, reload, t }) {
  const active = items.filter((item) => isActive(item.state));
  const needsDecision = items.filter((item) => isComplete(item.state) && item.remaining > 0);
  const finished = items.filter((item) => isComplete(item.state) && item.remaining === 0);
  const next = needsDecision[0] ?? active[0] ?? items[0] ?? null;
  return (
    <div className="screen" data-testid="tc-cc-home">
      <PageHeading
        title={t('confirm.title', 'Reviews')}
        action={next ? <button className="secondary-action" type="button" onClick={() => navigate({ page: 'confirm', view: 'new' })}><span aria-hidden="true">＋</span>{t('confirm.new', 'New review')}</button> : null}
      />
      <section className="next-work" aria-labelledby="next-work-title">
        <div>
          <p className="eyebrow">{t('confirm.nextEyebrow', 'Next step')}</p>
          <h2 id="next-work-title">{next ? nextActionTitle(next, t) : t('confirm.emptyTitle', 'Start your first review')}</h2>
          <p className="muted">{next ? next.description : t('confirm.emptyText', 'Enter a website and choose what you want to learn.')}</p>
        </div>
        <button className="primary-action" type="button" onClick={() => navigate(next ? { page: 'confirm', view: 'work', itemId: next.id } : { page: 'confirm', view: 'new' })}>
          {next ? t('confirm.continue', 'Continue') : t('confirm.new', 'New review')}<span aria-hidden="true">→</span>
        </button>
      </section>
      <div className="summary-strip" aria-label={t('confirm.summary', 'Review summary')}>
        <Metric label={t('running.title', 'In progress')} value={active.length} />
        <Metric label={t('confirm.decisions', 'Decisions needed')} value={needsDecision.reduce((sum, item) => sum + item.remaining, 0)} />
        <Metric label={t('review.state.completeTitle', 'Complete')} value={finished.length} />
      </div>
      <section className="list-section" aria-labelledby="recent-title">
        <SectionHeading title={t('confirm.recent', 'Recent reviews')} onRefresh={() => reload({ quiet: true })} t={t} />
        {items.length ? <ReviewList items={items} onOpen={(id) => navigate({ page: 'confirm', view: 'work', itemId: id })} t={t} /> : <EmptyPanel title={t('confirm.emptyTitle', 'No reviews yet')} text={t('confirm.emptyText', 'Start a review to find the improvements that matter most.')} />}
      </section>
    </div>
  );
}

function NewReviewPage({ dashboard, navigate, reload, t }) {
  const [form, setForm] = useState(DEFAULT_REVIEW);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [prepared, setPrepared] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const startButtonRef = useRef(null);

  function update(field, value) { setForm((current) => ({ ...current, [field]: value })); }
  async function prepare(event) {
    event.preventDefault();
    setBusy(true);
    setError(false);
    try {
      const next = await prepareAgenticReview({
        url: form.url.trim(),
        purpose: form.purpose.trim(),
        review_method: form.review_method,
        review_effort: form.review_method,
        effort: form.review_method,
        default_viewport: readPreferences(dashboard).defaultViewport,
        viewport: readPreferences(dashboard).defaultViewport,
        ai_suggestions: readPreferences(dashboard).aiSuggestions
      });
      const reviewId = readReviewId(next);
      if (!reviewId) throw new Error('Missing review');
      const preparedOperation = isActive(readState(next)) ? await waitUntilPrepared(reviewId) : next;
      if (isComplete(readState(preparedOperation))) {
        await reload({ quiet: true });
        navigate({ page: 'confirm', view: 'work', itemId: reviewId });
        return;
      }
      const disclosure = await fetchAgenticReviewConfirmation(reviewId);
      setPrepared({ ...next, review_id: reviewId });
      setConfirmation(disclosure);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    setBusy(true);
    setError(false);
    try {
      const consent = readConsent(confirmation);
      const result = await startAgenticReview({
        review_id: prepared.review_id,
        consent_token: consent.token,
        consent_revision: consent.revision,
        nonce: consent.token,
        revision: consent.revision,
        execute_confirmed: true
      });
      const reviewId = readReviewId(result) ?? prepared.review_id;
      setConfirmation(null);
      await reload({ quiet: true });
      navigate({ page: 'confirm', view: 'work', itemId: reviewId });
    } catch {
      setConfirmation(null);
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen narrow-screen" data-testid="tc-cc-new-review">
      <BackButton onClick={() => navigate({ page: 'confirm', view: 'list' })} t={t} />
      <PageHeading eyebrow={t('intake.eyebrow', 'Prepare')} title={t('review.new.title', 'New review')} />
      <form className="review-form" onSubmit={prepare}>
        <label className="field-label" htmlFor="review-url">{t('review.source.url', 'Website URL')}</label>
        <input id="review-url" className="text-input" type="url" inputMode="url" required autoComplete="url" placeholder="https://example.jp" value={form.url} onChange={(event) => update('url', event.target.value)} />
        <p className="field-hint">{t('review.source.urlHint', 'Enter the page you want to review.')}</p>

        <label className="field-label" htmlFor="review-purpose">{t('review.purpose.question', 'What do you want to make easier?')}</label>
        <textarea id="review-purpose" className="text-input" required maxLength="1200" rows="3" placeholder={t('review.purpose.placeholder', 'For example: Help first-time visitors complete a reservation without getting lost.')} value={form.purpose} onChange={(event) => update('purpose', event.target.value)} />

        <fieldset className="choice-fieldset">
          <legend>{t('review.method.legend', 'What kind of result do you need?')}</legend>
          <p className="field-hint">{t('review.method.hint', 'Choose the result closest to your goal.')}</p>
          <div className="method-grid">
            {REVIEW_METHOD_IDS.map((id) => {
              const method = reviewMethodCopy(t, id);
              return (
                <label className={`choice-card${form.review_method === id ? ' selected' : ''}`} key={id}>
                  <input type="radio" name="review-method" value={id} aria-label={method.title} checked={form.review_method === id} onChange={() => update('review_method', id)} />
                  <span className="choice-radio" aria-hidden="true" />
                  <span><strong>{method.title}</strong>{method.recommended ? <small className="recommended">{method.recommendedLabel}</small> : null}<small>{method.description}</small></span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {error ? <InlineNotice tone="danger" title={t('review.prepareFailed', 'The review could not be prepared')} text={t('action.genericError', 'Check the information and try again.')} /> : null}
        <div className="form-actions">
          <button ref={startButtonRef} className="primary-action" type="submit" disabled={busy}>{busy ? t('review.action.starting', 'Preparing...') : t('review.action.start', 'Prepare review')}<span aria-hidden="true">→</span></button>
        </div>
      </form>
      <SendConfirmationDialog
        open={Boolean(confirmation)}
        confirmation={confirmation}
        busy={busy}
        returnFocusRef={startButtonRef}
        onCancel={() => setConfirmation(null)}
        onConfirm={start}
        t={t}
      />
    </div>
  );
}

function SendConfirmationDialog({ open, confirmation, busy, returnFocusRef, onCancel, onConfirm, t }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  function close() {
    onCancel();
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  }
  const disclosure = readDisclosure(confirmation, t);
  return (
    <dialog ref={dialogRef} className="send-dialog" aria-labelledby="send-dialog-title" onCancel={(event) => { event.preventDefault(); close(); }} onClose={() => returnFocusRef.current?.focus()}>
      <div className="dialog-heading">
        <div><p className="eyebrow">{t('send.eyebrow', 'Before sending')}</p><h2 id="send-dialog-title">{t('send.title', 'Start this review?')}</h2></div>
        <button className="icon-action" type="button" onClick={close} aria-label={t('common.close', 'Close')}>×</button>
      </div>
      <p>{t('send.description', 'TraceCue will send the following information to the configured AI service.')}</p>
      <dl className="send-summary">
        <div><dt>{t('send.content', 'Information sent')}</dt><dd>{disclosure.items.join(', ') || t('send.contentFallback', 'The page and your review goal')}</dd></div>
        <div><dt>{t('send.destination', 'Sent to')}</dt><dd>{disclosure.destination || t('send.destinationFallback', 'Your configured AI service')}</dd></div>
        <div><dt>{t('send.storage', 'Saved for')}</dt><dd>{disclosure.storage || t('send.storageFallback', 'This review')}</dd></div>
      </dl>
      <div className="dialog-actions">
        <button className="secondary-action" type="button" onClick={close}>{t('review.action.cancel', 'Cancel')}</button>
        <button className="primary-action" type="button" disabled={busy} onClick={onConfirm}>{busy ? t('send.starting', 'Starting...') : t('review.action.startExecuting', 'Start review')}</button>
      </div>
    </dialog>
  );
}

function RunningPage({ items, navigate, reload, t }) {
  const active = items.filter((item) => isActive(item.state) || item.state === 'dispatch_unknown');
  return (
    <div className="screen" data-testid="tc-cc-running">
      <PageHeading title={t('running.title', 'In progress')} />
      <section className="list-section">
        <SectionHeading title={t('running.current', 'Current reviews')} onRefresh={() => reload({ quiet: true })} t={t} />
        {active.length ? <ReviewList items={active} onOpen={(id) => navigate({ page: 'confirm', view: 'work', itemId: id })} t={t} /> : <EmptyPanel title={t('running.emptyTitle', 'No reviews in progress')} text={t('running.emptyText', 'Reviews that are running will appear here.')} />}
      </section>
    </div>
  );
}

function ReviewWorkspace({ reviewId, navigate, reload, t }) {
  const [operation, setOperation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState(false);
  const [findingIndex, setFindingIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [decisions, setDecisions] = useState({});
  const [confirmation, setConfirmation] = useState(null);
  const startButtonRef = useRef(null);

  async function refresh({ quiet = false } = {}) {
    if (!quiet) setLoading(true);
    try {
      const next = await fetchAgenticReviewStatus(reviewId);
      setOperation(next);
      setStatusError(false);
    } catch {
      setStatusError(true);
    } finally {
      if (!quiet) setLoading(false);
    }
  }
  useEffect(() => {
    setOperation(null);
    setFindingIndex(0);
    setDecisions({});
    refresh();
  }, [reviewId]);
  useEffect(() => {
    if (!operation || !isActive(readState(operation))) return undefined;
    const timer = window.setInterval(() => refresh({ quiet: true }), 2000);
    return () => window.clearInterval(timer);
  }, [operation, reviewId]);

  const state = readState(operation);
  const findings = normalizeFindings(operation);
  const currentFinding = findings[findingIndex] ?? null;
  const knownDecisions = useMemo(() => {
    const initial = Object.fromEntries(findings.filter((finding) => finding.decision).map((finding) => [finding.id, finding.decision]));
    return { ...initial, ...decisions };
  }, [findings, decisions]);
  const allDecided = findings.length > 0 && findings.every((finding) => knownDecisions[finding.id]);

  async function decide(decision) {
    if (!currentFinding) return;
    setSaving(true);
    setStatusError(false);
    try {
      await saveAgenticReviewDecision({ review_id: reviewId, finding_id: currentFinding.id, decision });
      setDecisions((current) => ({ ...current, [currentFinding.id]: decision }));
      if (findingIndex < findings.length - 1) setFindingIndex(findingIndex + 1);
      else await refresh({ quiet: true });
    } catch {
      setStatusError(true);
    } finally {
      setSaving(false);
    }
  }
  async function repeat(kind) {
    setSaving(true);
    setStatusError(false);
    try {
      const next = await repeatAgenticReview({ review_id: reviewId, repeat_kind: kind });
      const nextId = readReviewId(next);
      if (!nextId) throw new Error('Missing review');
      await reload({ quiet: true });
      navigate({ page: 'confirm', view: 'work', itemId: nextId });
    } catch {
      setStatusError(true);
    } finally {
      setSaving(false);
    }
  }
  async function requestStartConfirmation() {
    setSaving(true);
    setStatusError(false);
    try {
      setConfirmation(await fetchAgenticReviewConfirmation(reviewId));
    } catch {
      setStatusError(true);
    } finally {
      setSaving(false);
    }
  }
  async function resumeStart() {
    setSaving(true);
    setStatusError(false);
    try {
      const consent = readConsent(confirmation);
      await startAgenticReview({
        review_id: reviewId,
        consent_token: consent.token,
        consent_revision: consent.revision,
        nonce: consent.token,
        revision: consent.revision,
        execute_confirmed: true
      });
      setConfirmation(null);
      await refresh({ quiet: true });
      await reload({ quiet: true });
    } catch {
      setConfirmation(null);
      setStatusError(true);
    } finally {
      setSaving(false);
    }
  }

  if (loading && !operation) return <div className="screen"><StatePanel title={t('review.state.loadingTitle', 'Loading review')} text={t('review.state.loadingText', 'Reading the latest status.')} /></div>;
  if (!operation) return <div className="screen"><BackButton onClick={() => navigate({ page: 'confirm', view: 'list' })} t={t} /><StatePanel tone="danger" title={t('review.state.failedTitle', 'The review could not be loaded')} text={t('review.state.failedText', 'Try again in a moment.')} action={<button className="primary-action" type="button" onClick={() => refresh()}>{t('common.retry', 'Try again')}</button>} /></div>;

  return (
    <div className="screen" data-testid="tc-cc-review-workspace">
      <BackButton onClick={() => navigate({ page: 'confirm', view: 'list' })} t={t} />
      <PageHeading eyebrow={t('work.eyebrow', 'Review')} title={reviewTitle(operation)} />
      <WorkflowSteps state={state} hasFindings={findings.length > 0} allDecided={allDecided} t={t} />
      {statusError ? <InlineNotice tone="warning" title={t('status.updateFailed', 'The latest status could not be read')} text={t('status.updateFailedText', 'The information already shown is still available. Try refreshing.')} action={<button className="link-action" type="button" onClick={() => refresh({ quiet: true })}>{t('app.refresh', 'Refresh')}</button>} /> : null}
      {state === 'confirmation_required' ? <StatePanel title={t('confirmationReady.title', 'The review is ready to start')} text={t('confirmationReady.text', 'Check what will be sent before starting the review.')} action={<button ref={startButtonRef} className="primary-action" type="button" disabled={saving} onClick={requestStartConfirmation}>{t('confirmationReady.action', 'Review and start')}</button>} /> : null}
      {state === 'dispatch_unknown' ? <UnknownDispatch onRefresh={() => refresh()} t={t} /> : null}
      {isFailed(state) ? <FailedReview onRepeat={() => repeat('recheck')} busy={saving} t={t} /> : null}
      {isActive(state) ? <ProgressView operation={operation} t={t} /> : null}
      {isComplete(state) && findings.length === 0 ? <NoFindings onRepeat={() => repeat('deeper')} busy={saving} t={t} /> : null}
      {isComplete(state) && currentFinding ? (
        <ResultsView
          findings={findings}
          findingIndex={findingIndex}
          setFindingIndex={setFindingIndex}
          decisions={knownDecisions}
          onDecide={decide}
          onRepeat={repeat}
          saving={saving}
          allDecided={allDecided}
          canDeepen={(operation.review_effort ?? operation.review_method) !== 'xhigh'}
          t={t}
        />
      ) : null}
      <SendConfirmationDialog open={Boolean(confirmation)} confirmation={confirmation} busy={saving} returnFocusRef={startButtonRef} onCancel={() => setConfirmation(null)} onConfirm={resumeStart} t={t} />
    </div>
  );
}

function ProgressView({ operation, t }) {
  const steps = normalizeSteps(operation);
  const percent = readPercent(operation);
  const current = readCurrentStep(operation);
  return (
    <section className="progress-panel" aria-live="polite">
      <div className="progress-mark" aria-hidden="true"><span /></div>
      <div>
        <p className="eyebrow">{t('review.progress.title', 'Review in progress')}</p>
        <h2>{current || reviewMethodCopy(t, operation.review_effort ?? operation.review_method).progress}</h2>
        <p className="muted">{t('review.progress.background', 'You can leave this screen while the review continues.')}</p>
        {Number.isFinite(percent) ? <div className="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div> : null}
        {steps.length ? <ol className="operation-steps">{steps.map((step) => <li className={step.done ? 'done' : step.current ? 'current' : ''} key={step.id}><span aria-hidden="true">{step.done ? '✓' : '•'}</span>{step.label}</li>)}</ol> : null}
      </div>
    </section>
  );
}

function ResultsView({ findings, findingIndex, setFindingIndex, decisions, onDecide, onRepeat, saving, allDecided, canDeepen, t }) {
  const finding = findings[findingIndex];
  const decision = decisions[finding.id] ?? null;
  return (
    <div className="results-layout">
      <aside className="finding-list" aria-label={t('results.list', 'Improvements')}>
        <div className="finding-list-heading"><strong>{t('results.count', 'Improvements')}</strong><span>{findings.length}</span></div>
        {findings.map((item, index) => (
          <button className={index === findingIndex ? 'active' : ''} type="button" key={item.id} onClick={() => setFindingIndex(index)} aria-current={index === findingIndex ? 'true' : undefined}>
            <span><strong>{item.title}</strong><small>{item.area}</small></span>
            {decisions[item.id] ? <span className="decision-check" aria-label={t('results.decided', 'Decided')}>✓</span> : <span aria-hidden="true">›</span>}
          </button>
        ))}
      </aside>
      <article className="finding-detail">
        <p className="eyebrow">{t('review.finding.priorityTitle', 'What to improve')}</p>
        <h2>{finding.title}</h2>
        {finding.impact ? <p className="finding-impact">{finding.impact}</p> : null}
        {finding.recommendation ? <section><h3>{t('review.finding.recommendation', 'Recommended change')}</h3><p>{finding.recommendation}</p></section> : null}
        {finding.reason ? <details><summary>{t('review.finding.evidenceOpen', 'Why this matters')}</summary><p>{finding.reason}</p></details> : null}
        {finding.area ? <p className="finding-area"><strong>{t('results.screen', 'Where')}</strong><span>{finding.area}</span></p> : null}
        <fieldset className="decision-fieldset" disabled={saving}>
          <legend>{t('decision.question', 'What will you do?')}</legend>
          <button className={decision === 'fix' ? 'selected' : ''} type="button" onClick={() => onDecide('fix')}><span aria-hidden="true">✓</span><span><strong>{t('decision.fix', 'Fix this')}</strong><small>{t('decision.fixHint', 'Keep it in the next work list')}</small></span></button>
          <button className={decision === 'later' ? 'selected' : ''} type="button" onClick={() => onDecide('later')}><span aria-hidden="true">◷</span><span><strong>{t('decision.later', 'Decide later')}</strong><small>{t('decision.laterHint', 'Keep it without committing yet')}</small></span></button>
          <button className={decision === 'ask' ? 'selected' : ''} type="button" onClick={() => onDecide('ask')}><span aria-hidden="true">?</span><span><strong>{t('decision.ask', 'Ask someone')}</strong><small>{t('decision.askHint', 'Mark it for a conversation')}</small></span></button>
        </fieldset>
        {allDecided ? (
          <section className="completion-actions">
            <h3>{t('decision.complete', 'All improvements have a decision')}</h3>
            <p className="muted">{t('decision.completeText', 'Choose what you would like TraceCue to do next.')}</p>
            <div className="button-row">
              <button className="primary-action" type="button" disabled={saving} onClick={() => onRepeat('recheck')}>{t('review.action.recheck', 'Review after changes')}</button>
              {canDeepen ? <button className="secondary-action" type="button" disabled={saving} onClick={() => onRepeat('deeper')}>{t('review.followUp.open', 'Review in more detail')}</button> : null}
            </div>
          </section>
        ) : null}
      </article>
    </div>
  );
}

function SettingsPage({ dashboard, locale, setLocale, reload, t }) {
  const defaults = readPreferences(dashboard);
  const [form, setForm] = useState(() => ({ locale, ...defaults }));
  const [state, setState] = useState('idle');
  function update(field, value) { setForm((current) => ({ ...current, [field]: value })); }
  async function save(event) {
    event.preventDefault();
    setState('saving');
    try {
      const language = dashboard?.settings?.display_language ?? {};
      const playwright = dashboard?.settings?.playwright_test ?? {};
      if (form.locale !== language.current_locale) {
        await setDisplayLanguage({
          locale: form.locale,
          confirm: language.write_confirm ?? 'set-control-center-display-language'
        });
      }
      if (form.playwrightMode !== playwright.selected_mode) {
        await setPlaywrightTestMode({
          mode: form.playwrightMode,
          confirm: playwright.write_confirm ?? 'set-playwright-test-mode'
        });
      }
      await setControlCenterPreferences({
        default_viewport: form.defaultViewport,
        ai_suggestions_enabled: form.aiSuggestions,
        confirm: 'save-control-center-preferences'
      });
      await reload({ quiet: true });
      setLocale(form.locale);
      setState('saved');
    } catch {
      setState('error');
    }
  }
  return (
    <div className="screen narrow-screen" data-testid="tc-cc-settings">
      <PageHeading title={t('settings.title', 'Settings')} />
      <form className="settings-form" onSubmit={save}>
        <SettingRow title={t('settings.languageRowTitle', 'Display language')} text={t('settings.languageRowDescription', 'The language used in the Control Center.')}>
          <select value={form.locale} onChange={(event) => update('locale', event.target.value)} aria-label={t('settings.languageRowTitle', 'Display language')}>
            {localeOptions(dashboard).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </SettingRow>
        <SettingRow title={t('settings.viewport', 'Default screen size')} text={t('settings.viewportHint', 'The screen size used when a review starts.')}>
          <select value={form.defaultViewport} onChange={(event) => update('defaultViewport', event.target.value)} aria-label={t('settings.viewport', 'Default screen size')}>
            <option value="desktop">{t('review.device.desktop', 'Computer')}</option>
            <option value="mobile">{t('review.device.mobile', 'Smartphone')}</option>
            <option value="both">{t('review.device.both', 'Both')}</option>
          </select>
        </SettingRow>
        <SettingRow title={t('settings.playwrightMode', 'Automated checks')} text={t('settings.playwrightModeHint', 'Choose how existing browser checks are used.')}>
          <select value={form.playwrightMode} onChange={(event) => update('playwrightMode', event.target.value)} aria-label={t('settings.playwrightMode', 'Automated checks')}>
            <option value="disabled">{t('settings.playwrightOff', 'Do not use')}</option>
            <option value="import_only">{t('settings.playwrightExisting', 'Use saved results')}</option>
            <option value="local_run">{t('settings.playwrightLocal', 'Use results on this computer')}</option>
            <option value="external_ci">{t('settings.playwrightCi', 'Use approved shared results')}</option>
          </select>
        </SettingRow>
        <SettingRow title={t('settings.aiSuggestions', 'AI suggestions')} text={t('settings.aiSuggestionsHint', 'Include suggested improvements in review results.')}>
          <Toggle checked={form.aiSuggestions} onChange={(checked) => update('aiSuggestions', checked)} label={t('settings.aiSuggestions', 'AI suggestions')} />
        </SettingRow>
        <SettingRow title={t('settings.sendConfirmation', 'Confirm before sending')} text={t('settings.sendConfirmationHint', 'Always show what will be sent before a review starts.')}>
          <Toggle checked disabled label={t('settings.sendConfirmation', 'Confirm before sending')} />
        </SettingRow>
        {state === 'saved' ? <InlineNotice tone="success" title={t('settings.saved', 'Settings saved')} /> : null}
        {state === 'error' ? <InlineNotice tone="danger" title={t('settings.saveFailed', 'Settings could not be saved')} text={t('action.genericError', 'Try again.')} /> : null}
        <div className="form-actions"><button className="primary-action" type="submit" disabled={state === 'saving'}>{state === 'saving' ? t('settings.saving', 'Saving...') : t('settings.saveAll', 'Save settings')}</button></div>
      </form>
    </div>
  );
}

function PageHeading({ eyebrow = null, title, action = null }) {
  return <header className="page-header"><div>{eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}<h1 tabIndex="-1" data-page-heading>{title}</h1></div>{action}</header>;
}

function SectionHeading({ title, onRefresh, t }) {
  return <div className="section-heading"><h2>{title}</h2><button className="icon-action" type="button" onClick={onRefresh} aria-label={t('app.refresh', 'Refresh')} title={t('app.refresh', 'Refresh')}>↻</button></div>;
}

function BackButton({ onClick, t }) {
  return <button className="back-action" type="button" onClick={onClick}><span aria-hidden="true">←</span>{t('common.back', 'Back')}</button>;
}

function Metric({ label, value }) {
  return <div className="metric"><strong>{value}</strong><span>{label}</span></div>;
}

function ReviewList({ items, onOpen, t }) {
  return <ul className="review-list">{items.map((item) => <li key={item.id}><button type="button" onClick={() => onOpen(item.id)}><span className={`status-dot ${stateTone(item.state)}`} aria-hidden="true" /><span className="review-list-copy"><strong>{item.title}</strong><small>{item.description}</small></span><StatusBadge state={item.state} t={t} /><span aria-hidden="true">›</span></button></li>)}</ul>;
}

function StatusBadge({ state, t }) {
  const label = state === 'dispatch_unknown' ? t('status.checking', 'Checking status') : isActive(state) ? t('running.title', 'In progress') : isComplete(state) ? t('review.state.completeTitle', 'Complete') : isFailed(state) ? t('status.needsHelp', 'Needs attention') : t('status.ready', 'Ready');
  return <span className={`status-badge ${stateTone(state)}`}>{label}</span>;
}

function WorkflowSteps({ state, hasFindings, allDecided, t }) {
  let current = 0;
  if (isActive(state) || state === 'dispatch_unknown') current = 1;
  if (isComplete(state) && hasFindings) current = allDecided ? 3 : 2;
  if (isComplete(state) && !hasFindings) current = 4;
  return <ol className="workflow-steps" aria-label={t('aria.workflowProgress', 'Review progress')}>{WORKFLOW_STAGES.map((stage, index) => <li className={index < current ? 'done' : index === current ? 'current' : ''} key={stage.id}><span>{index < current ? '✓' : index + 1}</span><small>{t(stage.labelKey, stage.fallback)}</small></li>)}</ol>;
}

function StatePanel({ title, text = null, action = null, tone = 'neutral' }) {
  return <section className={`state-panel ${tone}`} role={tone === 'danger' ? 'alert' : undefined}><h2>{title}</h2>{text ? <p>{text}</p> : null}{action}</section>;
}

function EmptyPanel({ title, text }) { return <StatePanel title={title} text={text} />; }

function InlineNotice({ title, text = null, action = null, tone = 'neutral' }) {
  return <div className={`inline-notice ${tone}`} role={tone === 'danger' ? 'alert' : 'status'}><div><strong>{title}</strong>{text ? <p>{text}</p> : null}</div>{action}</div>;
}

function UnknownDispatch({ onRefresh, t }) {
  return <StatePanel tone="warning" title={t('dispatchUnknown.title', 'We are checking whether the review started')} text={t('dispatchUnknown.text', 'Do not start another review yet. Refresh the status to avoid running it twice.')} action={<button className="primary-action" type="button" onClick={onRefresh}>{t('dispatchUnknown.action', 'Check status')}</button>} />;
}

function FailedReview({ onRepeat, busy, t }) {
  return <StatePanel tone="danger" title={t('failed.title', 'The review stopped before it finished')} text={t('failed.text', 'Your review details are still saved. You can try the review again.')} action={<button className="primary-action" type="button" disabled={busy} onClick={onRepeat}>{t('review.action.retry', 'Try again')}</button>} />;
}

function NoFindings({ onRepeat, busy, t }) {
  return <StatePanel tone="success" title={t('review.state.noFindingsTitle', 'No major improvements were found')} text={t('noFindings.text', 'This review is complete. You can run a more detailed review if needed.')} action={<button className="secondary-action" type="button" disabled={busy} onClick={onRepeat}>{t('review.followUp.open', 'Review in more detail')}</button>} />;
}

function SettingRow({ title, text, children }) {
  return <div className="setting-row"><div><h2>{title}</h2><p>{text}</p></div><div className="setting-control">{children}</div></div>;
}

function Toggle({ checked, disabled = false, onChange = () => {}, label }) {
  return <label className={`toggle${disabled ? ' locked' : ''}`}><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span aria-hidden="true" /><span className="sr-only">{label}</span></label>;
}

function normalizeItems(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const state = readState(item);
    const findings = normalizeFindings(item);
    const remaining = findings.filter((finding) => !finding.decision).length;
    return {
      ...item,
      id: readReviewId(item) ?? `review-${index}`,
      state,
      title: reviewTitle(item),
      description: item.purpose ?? item.summary ?? stateDescription(state),
      remaining
    };
  });
}

function normalizeFindings(operation) {
  const value = operation?.result?.findings ?? operation?.findings ?? operation?.result?.agentic_human_review_findings ?? [];
  if (!Array.isArray(value)) return [];
  return value.map((finding, index) => ({
    ...finding,
    id: String(finding.finding_id ?? finding.id ?? `finding-${index}`),
    title: finding.title ?? finding.message ?? finding.summary ?? finding.name ?? 'Improvement',
    impact: finding.impact ?? finding.description ?? finding.issue ?? '',
    recommendation: finding.recommendation ?? finding.suggested_change ?? finding.action ?? '',
    reason: finding.reason ?? finding.evidence ?? finding.why ?? '',
    area: finding.screen ?? finding.area ?? finding.location_label ?? '',
    decision: normalizeDecision(finding.decision ?? decisionForFinding(operation?.decisions, finding.finding_id ?? finding.id))
  }));
}

function normalizeSteps(operation) {
  const value = operation?.progress?.steps ?? operation?.steps ?? [];
  if (!Array.isArray(value)) return [];
  return value.map((step, index) => ({
    id: String(step.id ?? step.key ?? index),
    label: step.label ?? step.title ?? step.name ?? '',
    done: step.done === true || ['complete', 'completed', 'success'].includes(String(step.state ?? step.status ?? '').toLowerCase()),
    current: step.current === true || ['running', 'active', 'in_progress'].includes(String(step.state ?? step.status ?? '').toLowerCase())
  })).filter((step) => step.label);
}

function readDisclosure(value, t) {
  const source = value?.disclosure ?? value?.operation?.disclosure ?? value?.confirmation?.disclosure ?? value ?? {};
  const rawItems = source.send_items ?? source.transfer_items ?? source.content ?? source.items ?? [];
  const items = Array.isArray(rawItems) ? rawItems
    .filter((item) => typeof item === 'string' || item.sent !== false)
    .map((item) => {
      if (typeof item === 'string') return item;
      const fallback = item.label ?? item.title ?? item.description;
      return item.id ? t(`send.item.${item.id}`, fallback) : fallback;
    })
    .filter(Boolean) : [];
  return {
    items,
    destination: source.destination_label ?? source.service_label ?? source.service_name ?? '',
    storage: source.storage_label ?? source.retention_label ?? ''
  };
}

function readConsent(value) {
  const source = value?.confirmation ?? value ?? {};
  return {
    token: source.consent_token ?? source.token ?? source.nonce,
    revision: source.consent_revision ?? source.revision
  };
}

function readPreferences(dashboard) {
  const settings = dashboard?.settings ?? {};
  const preferences = settings.control_center ?? settings.control_center_preferences ?? {};
  const mode = settings.playwright_test?.selected_mode ?? settings.playwright_test?.mode ?? 'disabled';
  return {
    defaultViewport: preferences.default_viewport ?? 'both',
    playwrightMode: ['disabled', 'import_only', 'local_run', 'external_ci'].includes(mode) ? mode : 'disabled',
    aiSuggestions: preferences.ai_suggestions_enabled !== false
  };
}

function localeOptions(dashboard) {
  const configured = dashboard?.settings?.display_language?.supported_locales;
  if (Array.isArray(configured) && configured.length) return configured.map((item) => {
    if (typeof item === 'string') return { value: item, label: localeLabel(item) };
    const value = item.locale ?? item.code ?? item.id;
    return { value, label: item.native_name ?? item.label ?? localeLabel(value) };
  });
  return ['ja', 'en', 'ko', 'zh-Hans', 'zh-Hant', 'es', 'de', 'fr', 'pt-BR', 'th', 'hi', 'ar'].map((value) => ({ value, label: localeLabel(value) }));
}

function localeLabel(locale) {
  return ({ ja: '日本語', en: 'English', ko: '한국어', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', es: 'Español', de: 'Deutsch', fr: 'Français', 'pt-BR': 'Português (Brasil)', th: 'ไทย', hi: 'हिन्दी', ar: 'العربية' })[locale] ?? locale;
}

function readLocale(dashboard) { return dashboard?.settings?.display_language?.current_locale ?? dashboard?.settings?.control_center?.locale ?? 'en'; }
function readReviewId(value) { return value?.review_id ?? value?.id ?? value?.operation?.review_id ?? value?.operation?.id ?? null; }
function readState(value) { return String(value?.state ?? value?.status ?? value?.operation?.state ?? 'ready').toLowerCase(); }
function readPercent(value) { const number = Number(value?.progress?.percent ?? value?.progress_percent); return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null; }
function readCurrentStep(value) { return value?.progress?.current_label ?? value?.progress?.current_step_label ?? value?.current_step_label ?? ''; }
function isActive(state) { return ACTIVE_STATES.has(state); }
function isComplete(state) { return COMPLETE_STATES.has(state); }
function isFailed(state) { return FAILED_STATES.has(state); }
function stateTone(state) { return state === 'dispatch_unknown' ? 'warning' : isActive(state) ? 'active' : isComplete(state) ? 'success' : isFailed(state) ? 'danger' : 'neutral'; }
function stateDescription(state) { return isActive(state) ? 'Review in progress' : isComplete(state) ? 'Review complete' : isFailed(state) ? 'Review needs attention' : state === 'dispatch_unknown' ? 'Checking whether the review started' : 'Ready to review'; }
function nextActionTitle(item, t) { return isActive(item.state) || item.state === 'dispatch_unknown' ? t('next.running', 'Check the current review') : item.remaining > 0 ? t('next.decide', 'Decide what to do with the improvements') : t('next.review', 'View the latest result'); }

function reviewTitle(value) {
  if (value?.title || value?.target_label || value?.target) return value.title ?? value.target_label ?? value.target;
  const url = value?.url ?? value?.target_url ?? value?.operation?.target;
  if (url) {
    try { return new URL(url).hostname; } catch { return 'Website review'; }
  }
  return 'Website review';
}

function normalizeDecision(value) {
  const decision = typeof value === 'string' ? value : value?.decision;
  return ['fix', 'later', 'ask'].includes(decision) ? decision : null;
}

function decisionForFinding(decisions, findingId) {
  if (!Array.isArray(decisions)) return decisions?.[findingId];
  return decisions.find((decision) => decision?.finding_id === findingId)?.value;
}

async function waitUntilPrepared(reviewId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const operation = await fetchAgenticReviewStatus(reviewId);
    const state = readState(operation);
    if (state === 'confirmation_required' || isComplete(state)) return operation;
    if (isFailed(state) || state === 'dispatch_unknown') throw new Error('Review preparation stopped');
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  throw new Error('Review preparation timed out');
}
