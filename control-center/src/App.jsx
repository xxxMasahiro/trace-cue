import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAgenticReviewConfirmation,
  fetchAgenticReviewStatus,
  fetchDashboard,
  completeReviewIntake,
  cancelCodexSubscription,
  cancelAgenticReview,
  createAiSetupIntent,
  disconnectAiService,
  fetchCodexSubscriptionStatus,
  getReviewIntakeResult,
  getMediaReviewResult,
  fetchMediaReviewReadiness,
  fetchMediaReviewStatus,
  inspectMediaReviewUrl,
  listReviewIntakeResults,
  prepareAgenticReview,
  recoverAgenticReview,
  refreshAiConnections,
  repeatAgenticReview,
  resumeAgenticReview,
  saveAgenticReviewDecision,
  saveAiConnectionSelection,
  startCodexSubscription,
  finishCodexSubscription,
  submitAiApiKey,
  setControlCenterPreferences,
  startAgenticReview,
  uploadReviewIntake,
  uploadMediaReviewSource,
  startMediaReview,
  cancelMediaReview,
  cleanupMediaReviewOperation,
  discardMediaReviewSource
} from './apiClient.js';
import { designSystemStyle } from './designSystem.js';
import { createTranslator } from './i18n.js';
import { PAGES, WORKFLOW_STAGES } from './pageDefinitions.js';
import { REVIEW_METHOD_IDS, reviewMethodCopy } from './reviewMethods.js';
import { useControlCenterRoute } from './useControlCenterRoute.js';

const ACTIVE_STATES = new Set(['queued', 'prepared', 'preparing', 'dispatching', 'running', 'cancelling', 'validating', 'in_progress', 'fetching']);
const COMPLETE_STATES = new Set(['completed', 'completed_retained', 'cleaned', 'complete', 'ready', 'success']);
const FAILED_STATES = new Set(['failed', 'error', 'blocked', 'timed_out']);
const PREPARED_STATES = new Set(['prepared', 'evidence_ready']);
const ATTENTION_STATES = new Set(['needs_attention', 'evidence_missing']);
const DEFAULT_REVIEW = {
  source_kind: 'website',
  url: '',
  media_input_mode: 'url',
  media_url: '',
  retention: 'ephemeral',
  rights_declared: false,
  purpose: '',
  review_method: 'standard',
  continue_without_ai: false
};

export default function App() {
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [intakeResults, setIntakeResults] = useState([]);
  const [mediaReviews, setMediaReviews] = useState([]);
  const [intakeLoadError, setIntakeLoadError] = useState(false);
  const [locale, setLocale] = useState('en');
  const dashboardRequestGeneration = useRef(0);
  const { route, navigate } = useControlCenterRoute();
  const t = useMemo(() => createTranslator(locale).t, [locale]);
  const style = useMemo(() => designSystemStyle(), []);

  async function loadDashboard({ quiet = false } = {}) {
    const generation = ++dashboardRequestGeneration.current;
    if (!quiet) setLoading(true);
    setLoadError(null);
    try {
      const [dashboardResult, intakeResult] = await Promise.allSettled([
        fetchDashboard(),
        listReviewIntakeResults()
      ]);
      if (dashboardResult.status === 'rejected') throw dashboardResult.reason;
      const next = dashboardResult.value;
      if (generation !== dashboardRequestGeneration.current) return null;
      setDashboard(next);
      if (intakeResult.status === 'fulfilled') {
        setIntakeResults(intakeResult.value);
        setIntakeLoadError(false);
      } else {
        setIntakeLoadError(true);
      }
      setMediaReviews(Array.isArray(next.media_reviews) ? next.media_reviews : []);
      setLocale(readLocale(next));
      return next;
    } catch (caught) {
      if (generation === dashboardRequestGeneration.current) setLoadError(controlCenterLoadError(caught));
      return null;
    } finally {
      if (!quiet && generation === dashboardRequestGeneration.current) setLoading(false);
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

  const items = useMemo(() => sortItemsByRecency([
    ...normalizeItems(dashboard?.agentic_review?.items, t),
    ...normalizeIntakeItems(intakeResults, t),
    ...normalizeMediaReviewItems(mediaReviews, t)
  ]), [dashboard, intakeResults, mediaReviews, t]);
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
        {!loading && loadError === 'session' ? <StatePanel title={t('state.sessionEnded.title', 'Open the Control Center again')} text={t('state.sessionEnded.text', 'This private browser session has ended. Open the Control Center in the usual way to continue.')} tone="danger" /> : null}
        {!loading && loadError && loadError !== 'session' ? <StatePanel title={t('state.loadError.title', 'Your reviews could not be loaded')} text={t('state.loadError.text', 'Check that the Control Center is running, then try again.')} action={<button className="primary-action" type="button" onClick={() => loadDashboard()}>{t('common.retry', 'Try again')}</button>} tone="danger" /> : null}
        {!loading && !loadError ? (
          <ControlCenter
            dashboard={dashboard ?? {}}
            items={items}
            intakeResults={intakeResults}
            intakeLoadError={intakeLoadError}
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

function ControlCenter({ dashboard, items, intakeResults, intakeLoadError, locale, setLocale, route, navigate, reload, t }) {
  if (route.page === 'running') return <RunningPage items={items} navigate={navigate} reload={reload} t={t} />;
  if (route.page === 'settings') return <SettingsPage dashboard={dashboard} locale={locale} setLocale={setLocale} reload={reload} t={t} />;
  if (route.view === 'new') return <NewReviewPage dashboard={dashboard} navigate={navigate} reload={reload} t={t} />;
  if (route.view === 'work' && route.itemId) {
    if (route.itemId.startsWith('media-') && /^[a-f0-9]{32}$/u.test(route.itemId.slice('media-'.length))) {
      return <MediaReviewPage operationId={route.itemId.slice('media-'.length)} navigate={navigate} reload={reload} t={t} />;
    }
    if (/^[a-f0-9]{32}$/u.test(route.itemId)) {
      return <SavedIntakeResultPage resultId={route.itemId} locale={locale} navigate={navigate} t={t} />;
    }
    return <ReviewWorkspace reviewId={route.itemId} dashboard={dashboard} navigate={navigate} reload={reload} t={t} />;
  }
  return <HomePage items={items} intakeLoadError={intakeLoadError} navigate={navigate} reload={reload} t={t} />;
}

function HomePage({ items, intakeLoadError, navigate, reload, t }) {
  const active = items.filter((item) => isActive(item.state));
  const needsDecision = items.filter((item) => isComplete(item.state) && item.remaining > 0);
  const finished = items.filter((item) => isComplete(item.state) && item.remaining === 0);
  const actionableItems = items.filter((item) => item.state !== 'cancelled');
  const next = needsDecision[0] ?? active[0] ?? actionableItems[0] ?? null;
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
          {next ? t('confirm.continue', 'Continue') : t('confirm.new', 'New review')}<DirectionalSymbol symbol="→" />
        </button>
      </section>
      <div className="summary-strip" aria-label={t('confirm.summary', 'Review summary')}>
        <Metric label={t('running.title', 'In progress')} value={active.length} />
        <Metric label={t('confirm.decisions', 'Decisions needed')} value={needsDecision.reduce((sum, item) => sum + item.remaining, 0)} />
        <Metric label={t('review.state.completeTitle', 'Complete')} value={finished.length} />
      </div>
      <section className="list-section" aria-labelledby="recent-title">
        <SectionHeading title={t('confirm.recent', 'Recent reviews')} onRefresh={() => reload({ quiet: true })} t={t} />
        {intakeLoadError ? <InlineNotice
          tone="warning"
          title={t('intake.resultsLoadFailed', 'Some saved results could not be loaded')}
          text={t('intake.resultsLoadFailedText', 'The results already shown are still available. Try loading the saved results again.')}
          action={<button className="link-action" type="button" onClick={() => reload({ quiet: true })}>{t('common.retry', 'Try again')}</button>}
        /> : null}
        {items.length ? <ReviewList items={items} onOpen={(id) => navigate({ page: 'confirm', view: 'work', itemId: id })} t={t} /> : <EmptyPanel title={t('confirm.emptyTitle', 'No reviews yet')} text={t('confirm.emptyText', 'Start a review to find the improvements that matter most.')} />}
      </section>
    </div>
  );
}

function NewReviewPage({ dashboard, navigate, reload, t }) {
  const [form, setForm] = useState(DEFAULT_REVIEW);
  const [file, setFile] = useState(null);
  const [pendingIntakeId, setPendingIntakeId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [localResult, setLocalResult] = useState(null);
  const [mediaReadiness, setMediaReadiness] = useState(null);
  const [mediaDecision, setMediaDecision] = useState(null);
  const [pendingMediaSourceId, setPendingMediaSourceId] = useState(null);
  const [prepared, setPrepared] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [needsAiRefresh, setNeedsAiRefresh] = useState(false);
  const [aiDraft, setAiDraft] = useState(() => readAiSelection(dashboard?.ai_connections));
  const [aiEditorOpen, setAiEditorOpen] = useState(false);
  const [aiSetupOpen, setAiSetupOpen] = useState(false);
  const startButtonRef = useRef(null);
  const aiSetupButtonRef = useRef(null);
  const fileInputRef = useRef(null);
  const actionGenerationRef = useRef(0);
  const actionAbortRef = useRef(null);
  const mediaOperationIdRef = useRef(null);

  useEffect(() => () => {
    actionGenerationRef.current += 1;
    actionAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    setAiDraft(readAiSelection(dashboard?.ai_connections));
  }, [dashboard?.ai_connections?.capability_token, dashboard?.ai_connections?.settings_revision]);

  useEffect(() => {
    if (form.source_kind !== 'video') return undefined;
    let active = true;
    fetchMediaReviewReadiness()
      .then((value) => { if (active) setMediaReadiness(value); })
      .catch(() => { if (active) setMediaReadiness({ status: 'unavailable' }); });
    return () => { active = false; };
  }, [form.source_kind]);

  function update(field, value) { setForm((current) => ({ ...current, [field]: value })); }
  function clearFileSelection() {
    const stagedSourceId = pendingMediaSourceId;
    setFile(null);
    setPendingIntakeId(null);
    setPendingMediaSourceId(null);
    mediaOperationIdRef.current = null;
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (stagedSourceId) discardMediaReviewSource(stagedSourceId).catch(() => {});
  }
  function selectFile(nextFile) {
    const stagedSourceId = pendingMediaSourceId;
    setPendingIntakeId(null);
    setPendingMediaSourceId(null);
    mediaOperationIdRef.current = createMediaOperationId();
    setFile(nextFile);
    if (stagedSourceId) discardMediaReviewSource(stagedSourceId).catch(() => {});
  }
  async function refreshMediaReadiness() {
    setBusy(true);
    setError(null);
    try {
      setMediaReadiness(await fetchMediaReviewReadiness({ refresh: true }));
    } catch (caught) {
      setMediaReadiness({ status: 'unavailable' });
      setError(uiErrorMessage(caught, t));
    } finally {
      setBusy(false);
    }
  }
  async function prepare(event) {
    event.preventDefault();
    if (localResult) return;
    const action = beginPageAction(actionGenerationRef, actionAbortRef);
    setBusy(true);
    setError(null);
    setNeedsAiRefresh(false);
    setLocalResult(null);
    let mediaAttemptId = null;
    try {
      if (form.source_kind === 'video') {
        if (form.media_input_mode === 'url') {
          const decision = await inspectMediaReviewUrl(form.media_url.trim());
          if (!isCurrentPageAction(actionGenerationRef, action)) return;
          setMediaDecision(decision);
          return;
        }
        if (!file) throw new Error('Missing file');
        if (!form.rights_declared) throw new Error('Media rights confirmation required');
        let sourceId = pendingMediaSourceId;
        if (!sourceId) {
          const source = await uploadMediaReviewSource(file, { signal: action.signal });
          if (!isCurrentPageAction(actionGenerationRef, action)) return;
          sourceId = source.source_id;
          setPendingMediaSourceId(sourceId);
        }
        mediaAttemptId = mediaOperationIdRef.current ?? createMediaOperationId();
        mediaOperationIdRef.current = mediaAttemptId;
        const operation = await startMediaReview({
          source_id: sourceId,
          operation_id: mediaAttemptId,
          retention: form.retention,
          rights_declared: true,
          rights_confirm: 'use-owned-or-authorized-media',
          confirm: 'execute-media-review'
        }, { signal: action.signal });
        if (!isCurrentPageAction(actionGenerationRef, action)) return;
        setPendingMediaSourceId(null);
        mediaOperationIdRef.current = null;
        await reload({ quiet: true });
        if (!isCurrentPageAction(actionGenerationRef, action)) return;
        navigate({ page: 'confirm', view: 'work', itemId: `media-${operation.operation_id}` });
        return;
      }
      if (form.source_kind !== 'website') {
        if (!file) throw new Error('Missing file');
        let intakeId = pendingIntakeId;
        if (!intakeId) {
          const intake = await uploadReviewIntake(file, form.source_kind);
          if (!isCurrentPageAction(actionGenerationRef, action)) return;
          intakeId = intake.id;
          setPendingIntakeId(intakeId);
        }
        const result = await completeReviewIntake({
          intake_id: intakeId,
          ...(form.source_kind === 'document_text' ? {
            purpose: form.purpose.trim(),
            effort: form.review_method
          } : {})
        });
        if (!isCurrentPageAction(actionGenerationRef, action)) return;
        setPendingIntakeId(null);
        setLocalResult(result);
        await reload({ quiet: true });
        return;
      }
      const preferences = readPreferences(dashboard);
      const aiConnections = dashboard?.ai_connections ?? {};
      const aiAvailable = aiConnections.status === 'available' && Boolean(aiDraft?.connection_option_id);
      if (preferences.aiSuggestions && !aiAvailable && !form.continue_without_ai) {
        throw new Error('AI choice required');
      }
      const next = await prepareAgenticReview({
        url: form.url.trim(),
        purpose: form.purpose.trim(),
        review_method: form.review_method,
        review_effort: form.review_method,
        effort: form.review_method,
        default_viewport: readPreferences(dashboard).defaultViewport,
        viewport: readPreferences(dashboard).defaultViewport,
        ai_suggestions: preferences.aiSuggestions && aiAvailable && !form.continue_without_ai,
        ...(preferences.aiSuggestions && aiAvailable && !form.continue_without_ai ? {
          connection_option_id: aiDraft.connection_option_id,
          model_option_id: aiDraft.model_option_id,
          effort_option_id: aiDraft.effort_option_id,
          capability_revision: aiConnections.revision,
          capability_token: aiConnections.capability_token
        } : {})
      }, { signal: action.signal });
      if (!isCurrentPageAction(actionGenerationRef, action)) return;
      const reviewId = readReviewId(next);
      if (!reviewId) throw new Error('Missing review');
      const preparedOperation = isActive(readState(next))
        ? await waitUntilPrepared(reviewId, { signal: action.signal })
        : next;
      if (!isCurrentPageAction(actionGenerationRef, action)) return;
      if (isComplete(readState(preparedOperation))) {
        await reload({ quiet: true });
        if (!isCurrentPageAction(actionGenerationRef, action)) return;
        navigate({ page: 'confirm', view: 'work', itemId: reviewId });
        return;
      }
      const disclosure = await fetchAgenticReviewConfirmation(reviewId, { signal: action.signal });
      if (!isCurrentPageAction(actionGenerationRef, action)) return;
      setPrepared({ ...next, review_id: reviewId });
      setConfirmation(disclosure);
    } catch (caught) {
      if (!isCurrentPageAction(actionGenerationRef, action)) return;
      if (mediaAttemptId && !caught?.envelope) {
        try {
          const recovered = await fetchMediaReviewStatus(mediaAttemptId, { signal: action.signal });
          if (!isCurrentPageAction(actionGenerationRef, action)) return;
          if (recovered?.operation_id === mediaAttemptId) {
            await reload({ quiet: true });
            if (!isCurrentPageAction(actionGenerationRef, action)) return;
            navigate({ page: 'confirm', view: 'work', itemId: `media-${mediaAttemptId}` });
            return;
          }
        } catch {}
      }
      if (['CONTROL_CENTER_MEDIA_SOURCE_UNAVAILABLE', 'CONTROL_CENTER_MEDIA_SOURCE_CHANGED'].includes(apiErrorCode(caught))) {
        if (pendingMediaSourceId) discardMediaReviewSource(pendingMediaSourceId).catch(() => {});
        setPendingMediaSourceId(null);
        mediaOperationIdRef.current = null;
      }
      if (!sameIntakeRetryAvailable(caught)) setPendingIntakeId(null);
      if (requiresAiProjectionRefresh(apiErrorCode(caught))) {
        const nextDashboard = await reload({ quiet: true });
        if (!isCurrentPageAction(actionGenerationRef, action)) return;
        setAiDraft(readAiSelection(nextDashboard?.ai_connections));
        setNeedsAiRefresh(true);
        setError(t('review.ai.changedBeforePrepare', 'AI availability changed. Your review details are still here; check the current choice and prepare again.'));
      } else {
        setError(uiErrorMessage(caught, t));
      }
    } finally {
      if (isCurrentPageAction(actionGenerationRef, action)) setBusy(false);
    }
  }

  const sourceOptions = [
    { id: 'website', icon: '◎', title: t('review.source.website', 'Website'), text: t('review.source.websiteText', 'Check a page in the browser.') },
    { id: 'image', icon: '▣', title: t('review.source.image', 'Image'), text: t('review.source.imageText', 'Prepare image evidence.') },
    { id: 'document_text', icon: '≡', title: t('review.source.document', 'Document'), text: t('review.source.documentText', 'Prepare a review proposal from text.') },
    { id: 'playwright_result', icon: '✓', title: t('review.source.testResult', 'Test result'), text: t('review.source.testResultText', 'Summarize saved browser-check results.') },
    { id: 'video', icon: '▶', title: t('review.source.video', 'Video'), text: t('review.source.videoText', 'Review timing, sound, captions, and clarity.') }
  ];
  const accept = form.source_kind === 'image'
    ? '.png,.jpg,.jpeg,.gif,.webp'
    : form.source_kind === 'video'
      ? (mediaReadiness?.local_input?.accepted_extensions?.join(',') || '.mp4,.mov,.m4v,.mkv,.webm')
    : form.source_kind === 'document_text'
      ? '.txt,.md,.markdown,.json'
      : '.json,.xml';
  const preferences = readPreferences(dashboard);
  const aiConnections = dashboard?.ai_connections ?? { status: 'not_checked', connections: [], selection: null };
  const selectedAiSummary = describeAiSelection(aiConnections, aiDraft);
  const needsAiChoice = form.source_kind === 'website'
    && preferences.aiSuggestions
    && (aiConnections.status !== 'available' || !selectedAiSummary);
  const needsReviewGoal = form.source_kind === 'website' || form.source_kind === 'document_text';
  const videoLocal = form.source_kind === 'video' && form.media_input_mode === 'local';
  const sourceMissing = form.source_kind === 'video'
    ? (videoLocal ? !file : !form.media_url.trim())
    : (form.source_kind !== 'website' && !file);
  const videoNotReady = videoLocal && mediaReadiness?.status !== 'ready';
  async function start() {
    const action = beginPageAction(actionGenerationRef, actionAbortRef);
    setBusy(true);
    setError(null);
    try {
      const consent = readConsent(confirmation);
      const result = await startAgenticReview({
        review_id: prepared.review_id,
        consent_token: consent.token,
        consent_revision: consent.revision,
        nonce: consent.token,
        revision: consent.revision,
        execute_confirmed: true
      }, { signal: action.signal });
      if (!isCurrentPageAction(actionGenerationRef, action)) return;
      const reviewId = readReviewId(result) ?? prepared.review_id;
      setConfirmation(null);
      await reload({ quiet: true });
      if (!isCurrentPageAction(actionGenerationRef, action)) return;
      navigate({ page: 'confirm', view: 'work', itemId: reviewId });
    } catch (caught) {
      if (!isCurrentPageAction(actionGenerationRef, action)) return;
      setConfirmation(null);
      if (apiErrorCode(caught) === 'CONTROL_CENTER_AGENTIC_REVIEW_DESTINATION_CHANGED') {
        setPrepared(null);
        setNeedsAiRefresh(true);
        const nextDashboard = await reload({ quiet: true });
        if (!isCurrentPageAction(actionGenerationRef, action)) return;
        setAiDraft(readAiSelection(nextDashboard?.ai_connections));
        setError(t('review.ai.changedBeforeSend', 'The AI choice changed before anything was sent. Update availability, then prepare this review again.'));
      } else if (!caught?.envelope) {
        navigate({ page: 'confirm', view: 'work', itemId: prepared.review_id });
      } else {
        setError(uiErrorMessage(caught, t));
      }
    } finally {
      if (isCurrentPageAction(actionGenerationRef, action)) setBusy(false);
    }
  }

  async function cancelPreparedReview() {
    const reviewId = prepared?.review_id;
    if (!reviewId) {
      setConfirmation(null);
      return;
    }
    const action = beginPageAction(actionGenerationRef, actionAbortRef);
    setBusy(true);
    try {
      await cancelAgenticReview(reviewId, { signal: action.signal });
      if (!isCurrentPageAction(actionGenerationRef, action)) return;
      setConfirmation(null);
      setPrepared(null);
      await reload({ quiet: true });
    } catch {
      if (!isCurrentPageAction(actionGenerationRef, action)) return;
      setConfirmation(null);
      await reload({ quiet: true });
      if (!isCurrentPageAction(actionGenerationRef, action)) return;
      navigate({ page: 'confirm', view: 'work', itemId: reviewId });
    } finally {
      if (isCurrentPageAction(actionGenerationRef, action)) setBusy(false);
    }
  }

  return (
    <div className="screen narrow-screen" data-testid="tc-cc-new-review">
      <PageHeading
        title={t('review.new.title', 'New review')}
        action={<button className="link-action" type="button" onClick={() => navigate({ page: 'confirm', view: 'list' })}>{t('common.close', 'Close')}</button>}
      />
      {form.source_kind === 'website' ? <WorkflowSteps state="draft" hasFindings={false} allDecided={false} t={t} /> : null}
      <form className="review-form" onSubmit={prepare}>
        <fieldset className="choice-fieldset source-fieldset">
          <legend>{t('review.source.question', 'What would you like to review?')}</legend>
          <div className="source-grid">
            {sourceOptions.map((source) => (
              <label className={`source-choice${form.source_kind === source.id ? ' selected' : ''}`} key={source.id}>
                <input type="radio" name="source-kind" value={source.id} checked={form.source_kind === source.id} onChange={() => { update('source_kind', source.id); clearFileSelection(); setLocalResult(null); setMediaDecision(null); }} />
                <span className="source-icon" aria-hidden="true">{source.icon}</span>
                <span><strong>{source.title}</strong><small>{source.text}</small></span>
              </label>
            ))}
          </div>
        </fieldset>

        {form.source_kind === 'website' ? (
          <>
            <label className="field-label" htmlFor="review-url">{t('review.source.url', 'Website URL')}</label>
            <input id="review-url" className="text-input" type="url" inputMode="url" required autoComplete="url" placeholder="https://example.jp" value={form.url} onChange={(event) => update('url', event.target.value)} />
            <p className="field-hint">{t('review.source.urlHint', 'Enter the page you want to review.')}</p>
          </>
        ) : form.source_kind === 'video' ? (
          <section className="media-review-input" aria-labelledby="media-review-input-title">
            <div className="section-heading compact-heading">
              <div><p className="eyebrow">{t('media.localFirst', 'Local-first media review')}</p><h2 id="media-review-input-title">{t('media.input.title', 'Choose how to review the video')}</h2></div>
              <span className={`status-pill ${mediaReadiness?.status === 'ready' ? 'status-success' : 'status-warning'}`}>{mediaReadiness?.status === 'ready' ? t('media.ready', 'Ready') : mediaReadiness?.status === 'uninspected' ? t('media.notChecked', 'Not checked') : mediaReadiness?.status === 'unsupported' ? t('media.capability.unsupported', 'Unsupported') : t('media.setupNeeded', 'Setup needed')}</span>
            </div>
            <fieldset className="choice-fieldset compact-fieldset">
              <legend>{t('media.input.legend', 'Video source')}</legend>
              <div className="method-grid two-column-grid">
                <label className={`choice-card${form.media_input_mode === 'url' ? ' selected' : ''}`}>
                  <input type="radio" name="media-input-mode" value="url" checked={form.media_input_mode === 'url'} onChange={() => { update('media_input_mode', 'url'); clearFileSelection(); setMediaDecision(null); }} />
                  <span className="choice-radio" aria-hidden="true" />
                  <span><strong>{t('media.input.url', 'Video URL')}</strong><small>{t('media.input.urlText', 'Check what TraceCue can safely inspect before any playback.')}</small></span>
                </label>
                <label className={`choice-card${form.media_input_mode === 'local' ? ' selected' : ''}`}>
                  <input type="radio" name="media-input-mode" value="local" checked={form.media_input_mode === 'local'} onChange={() => { update('media_input_mode', 'local'); setMediaDecision(null); }} />
                  <span className="choice-radio" aria-hidden="true" />
                  <span><strong>{t('media.input.local', 'Local video')}</strong><small>{t('media.input.localText', 'Run the full review privately on this computer.')}</small></span>
                </label>
              </div>
            </fieldset>
            {form.media_input_mode === 'url' ? <>
              <label className="field-label" htmlFor="media-review-url">{t('media.url.label', 'Video URL')}</label>
              <input id="media-review-url" className="text-input" type="url" inputMode="url" required autoComplete="url" placeholder="https://www.youtube.com/watch?v=…" value={form.media_url} onChange={(event) => { update('media_url', event.target.value); setMediaDecision(null); }} />
              <p className="field-hint">{t('media.url.hint', 'TraceCue checks the provider and allowed capabilities without downloading or contacting the URL.')}</p>
              {mediaDecision ? <MediaSourceDecision decision={mediaDecision} t={t} /> : null}
            </> : <>
              <div className="file-field">
                <label className={`file-drop${file ? ' selected' : ''}`} htmlFor="review-file" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); selectFile(event.dataTransfer.files?.[0] ?? null); }}>
                  <span className="file-mark" aria-hidden="true">＋</span>
                  <span><strong>{file ? t('review.file.selected', 'File selected') : t('media.file.choose', 'Choose a video')}</strong><small>{file ? t('review.file.privateName', 'The file name stays private.') : mediaInputLimitLabel(mediaReadiness, t)}</small></span>
                </label>
                <input ref={fileInputRef} id="review-file" className="sr-only" type="file" aria-required="true" accept={accept} onChange={(event) => selectFile(event.target.files?.[0] ?? null)} />
                <p className="field-hint">{t('media.file.localOnly', 'Video, audio, frames, and the full transcript stay in private local storage.')}</p>
              </div>
              <label className="check-option media-rights-confirmation">
                <input type="checkbox" checked={form.rights_declared} onChange={(event) => update('rights_declared', event.target.checked)} />
                <span className="check-option-mark" aria-hidden="true" />
                <span>{t('media.rights.confirm', 'I own this video or have permission to review it.')}</span>
              </label>
              <fieldset className="choice-fieldset compact-fieldset">
                <legend>{t('media.retention.legend', 'After the review')}</legend>
                <div className="method-grid two-column-grid">
                  <label className={`choice-card${form.retention === 'ephemeral' ? ' selected' : ''}`}>
                    <input type="radio" name="media-retention" value="ephemeral" checked={form.retention === 'ephemeral'} onChange={() => update('retention', 'ephemeral')} />
                    <span className="choice-radio" aria-hidden="true" />
                    <span><strong>{t('media.retention.delete', 'Remove private source data')}</strong><small>{t('media.retention.deleteText', 'Recommended. Keep only the bounded review report.')}</small></span>
                  </label>
                  <label className={`choice-card${form.retention === 'project-retained' ? ' selected' : ''}`}>
                    <input type="radio" name="media-retention" value="project-retained" checked={form.retention === 'project-retained'} onChange={() => update('retention', 'project-retained')} />
                    <span className="choice-radio" aria-hidden="true" />
                    <span><strong>{t('media.retention.keep', 'Keep private source data')}</strong><small>{t('media.retention.keepText', 'Keep it privately until you explicitly clean it up.')}</small></span>
                  </label>
                </div>
              </fieldset>
              {mediaReadiness?.status !== 'ready' ? <InlineNotice tone="warning" title={mediaReadinessNotice(mediaReadiness, t).title} text={mediaReadinessNotice(mediaReadiness, t).text} action={<button className="secondary-action compact" type="button" disabled={busy} onClick={refreshMediaReadiness}>{busy ? t('media.check.running', 'Checking…') : t('media.check.action', 'Check local setup')}</button>} /> : null}
            </>}
          </section>
        ) : (
          <div className="file-field">
            <label
              className={`file-drop${file ? ' selected' : ''}`}
              htmlFor="review-file"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); selectFile(event.dataTransfer.files?.[0] ?? null); }}
            >
              <span className="file-mark" aria-hidden="true">＋</span>
              <span><strong>{file ? t('review.file.selected', 'File selected') : t('review.file.choose', 'Choose a file')}</strong><small>{file ? t('review.file.privateName', 'The file name stays private.') : t('review.file.drop', 'You can also drop it here.')}</small></span>
            </label>
            <input ref={fileInputRef} id="review-file" className="sr-only" type="file" aria-required="true" accept={accept} onChange={(event) => selectFile(event.target.files?.[0] ?? null)} />
            <p className="field-hint">{t('review.file.localOnly', 'The file stays in this local workspace. Its path is not shown.')}</p>
          </div>
        )}

        {needsReviewGoal ? <><label className="field-label" htmlFor="review-purpose">{t('review.purpose.question', 'What do you want to make easier?')}</label>
        <input id="review-purpose" className="text-input" type="text" required maxLength="1200" placeholder={t('review.purpose.placeholder', 'For example: Help first-time visitors complete a reservation without getting lost.')} value={form.purpose} onChange={(event) => update('purpose', event.target.value)} /></> : null}

        {needsAiChoice ? (
          <div className="ai-choice">
            <div><strong>{t('review.ai.notReady', 'AI suggestions need setup')}</strong><p>{aiSetupGuidance(aiConnections, t)}</p></div>
            {aiConnections.status === 'available' && firstAvailableAiSelection(aiConnections) ? (
              <AiConnectionEditor aiConnections={aiConnections} value={aiDraft} onChange={(value) => { setAiDraft(value); update('continue_without_ai', false); }} t={t} compact />
            ) : null}
            <div className="ai-choice-actions">
              {aiConnections.status === 'available' && !selectedAiSummary && firstAvailableAiSelection(aiConnections) ? (
                <button className="primary-action compact" type="button" onClick={() => { setAiDraft(firstAvailableAiSelection(aiConnections)); update('continue_without_ai', false); }}>{t('review.ai.useShown', 'Use this AI')}</button>
              ) : <button ref={aiSetupButtonRef} className="primary-action compact" type="button" onClick={() => setAiSetupOpen(true)}>{t('aiSetup.open', 'Set up AI')}</button>}
              <label className="check-option">
                <input type="checkbox" aria-label={t('review.ai.continueLocal', 'Continue without AI')} checked={form.continue_without_ai} onChange={(event) => update('continue_without_ai', event.target.checked)} />
                <span className="check-option-mark" aria-hidden="true" />
                <span>{t('review.ai.continueLocal', 'Continue without AI')}</span>
              </label>
            </div>
          </div>
        ) : null}
        {form.source_kind === 'website' && preferences.aiSuggestions && aiConnections.status === 'available' && selectedAiSummary ? (
          <section className="ai-review-choice" aria-labelledby="review-ai-summary">
            <div><strong id="review-ai-summary">{t('review.ai.summary', 'AI suggestions')}</strong><p>{selectedAiSummary.connection.name} · {selectedAiSummary.model.name}</p></div>
            {hasAlternativeAiSelection(aiConnections, aiDraft) ? <button className="link-action" type="button" onClick={() => setAiEditorOpen((value) => !value)} aria-expanded={aiEditorOpen}>{t('common.change', 'Change')}</button> : null}
            {aiEditorOpen ? <AiConnectionEditor aiConnections={aiConnections} value={aiDraft} onChange={(value) => { setAiDraft(value); update('continue_without_ai', false); }} t={t} compact /> : null}
          </section>
        ) : null}
        {needsReviewGoal ? <fieldset className="choice-fieldset">
          <legend>{t('review.method.legend', 'What kind of result do you need?')}</legend>
          <p className="field-hint">{t('review.method.hint', 'Choose the result closest to your goal.')}</p>
          <div className="method-grid">
            {REVIEW_METHOD_IDS.map((id) => {
              const method = reviewMethodCopy(t, id);
              return (
                <label className={`choice-card${form.review_method === id ? ' selected' : ''}`} key={id}>
                  <input type="radio" name="review-method" value={id} aria-label={method.title} checked={form.review_method === id} onChange={() => update('review_method', id)} />
                  <span className="choice-radio" aria-hidden="true" />
                  <span><strong>{method.title}{method.recommended ? <span className="recommended">{method.recommendedLabel}</span> : null}</strong><small>{method.description}</small></span>
                </label>
              );
            })}
          </div>
        </fieldset> : null}
        {localResult ? <IntakeResult result={localResult} onOpen={() => navigate({ page: 'confirm', view: 'work', itemId: localResult.id })} t={t} /> : null}
        {error ? <InlineNotice tone="danger" title={t('review.prepareFailed', 'The review could not be prepared')} text={error} action={needsAiRefresh ? <button className="link-action" type="button" onClick={() => navigate({ page: 'settings', view: 'settings' })}>{t('review.ai.openSettings', 'Open AI settings')}</button> : null} /> : null}
        <div className="form-actions">
          <button className="secondary-action" type="button" onClick={() => navigate({ page: 'confirm', view: 'list' })}>{t('common.back', 'Back')}</button>
          {localResult
            ? <button className="primary-action" type="button" onClick={() => { clearFileSelection(); setLocalResult(null); setError(null); }}>{t('intake.result.prepareAnother', 'Prepare another')}</button>
            : <button ref={startButtonRef} className="primary-action" type="submit" disabled={busy || sourceMissing || videoNotReady || (videoLocal && !form.rights_declared) || (needsAiChoice && !form.continue_without_ai)}>{busy ? t('review.action.starting', 'Preparing...') : form.source_kind === 'video' ? (videoLocal ? t('media.action.start', 'Start video review') : t('media.action.inspect', 'Check URL capabilities')) : sourceActionLabel(form.source_kind, t)}<DirectionalSymbol symbol="→" /></button>}
        </div>
      </form>
      <SendConfirmationDialog
        open={Boolean(confirmation)}
        confirmation={confirmation}
        busy={busy}
        returnFocusRef={startButtonRef}
        onCancel={cancelPreparedReview}
        onConfirm={start}
        t={t}
      />
      <AiSetupDialog
        open={aiSetupOpen}
        aiSetup={dashboard?.ai_setup}
        aiConnections={dashboard?.ai_connections}
        returnFocusRef={aiSetupButtonRef}
        fallbackFocusRef={startButtonRef}
        onClose={() => setAiSetupOpen(false)}
        onComplete={async () => {
          const next = await reload({ quiet: true });
          setAiDraft(readAiSelection(next?.ai_connections));
          update('continue_without_ai', false);
          return next;
        }}
        t={t}
      />
    </div>
  );
}

function IntakeResult({ result, onOpen = null, t }) {
  const presentation = intakeResultPresentation(result, t);
  return <InlineNotice tone={presentation.tone} title={presentation.title} text={presentation.text} action={onOpen ? <button className="link-action" type="button" onClick={onOpen}>{t('intake.result.open', 'Open result')}</button> : null} />;
}

function MediaSourceDecision({ decision, t }) {
  const capability = decision?.capabilities?.[0] ?? 'unsupported';
  const copy = capability === 'playback_inspection'
    ? {
        tone: 'success',
        title: t('media.url.playbackTitle', 'Official-player inspection is available'),
        text: t('media.url.playbackText', 'TraceCue may inspect playback state through the official player. It will not download or extract the media.')
      }
    : capability === 'metadata_only'
      ? {
          tone: 'warning',
          title: t('media.url.metadataTitle', 'Only source information can be checked'),
          text: t('media.url.metadataText', 'Full media analysis is not authorized for this URL. Use an owned or authorized local file for a complete review.')
        }
      : {
          tone: 'danger',
          title: t('media.url.unsupportedTitle', 'This source cannot be reviewed safely'),
          text: t('media.url.unsupportedText', 'TraceCue did not contact, download, or inspect media from this URL.')
        };
  return <div className="media-source-decision" data-testid="tc-media-source-decision">
    <InlineNotice tone={copy.tone} title={copy.title} text={copy.text} />
    <dl className="result-facts compact-facts">
      <div><dt>{t('media.url.source', 'Source')}</dt><dd>{decision?.source?.display_label ?? t('media.url.privateSource', 'Private source')}</dd></div>
      <div><dt>{t('media.url.capability', 'Available review')}</dt><dd>{mediaCapabilityLabel(capability, t)}</dd></div>
      <div><dt>{t('media.url.network', 'Network activity')}</dt><dd>{t('media.url.noNetwork', 'None during this capability check')}</dd></div>
    </dl>
  </div>;
}

function MediaReviewPage({ operationId, navigate, reload, t }) {
  const [operation, setOperation] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let timer = null;
    let active = true;
    async function refresh() {
      try {
        const next = await fetchMediaReviewStatus(operationId, { signal: controller.signal });
        if (!active) return;
        setOperation(next);
        setError(null);
        if (next?.result_available) {
          const completed = await getMediaReviewResult(operationId);
          if (active) setResult(completed);
        }
        if (active && isActive(readState(next))) timer = window.setTimeout(refresh, 750);
      } catch (caught) {
        if (active && !controller.signal.aborted) setError(uiErrorMessage(caught, t));
      }
    }
    refresh();
    return () => {
      active = false;
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [operationId, t]);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const next = await cancelMediaReview(operationId);
      setOperation(next);
      await reload({ quiet: true });
    } catch (caught) {
      setError(uiErrorMessage(caught, t));
    } finally {
      setBusy(false);
    }
  }

  async function cleanup() {
    setBusy(true);
    setError(null);
    try {
      await cleanupMediaReviewOperation(operationId, operation?.retention);
      setOperation((current) => current ? { ...current, state: 'cleaned', cleanup_available: false, capabilities: { ...current.capabilities, cleanup: false } } : current);
      await reload({ quiet: true });
    } catch (caught) {
      try {
        const recovered = await fetchMediaReviewStatus(operationId);
        if (recovered?.state === 'cleaned') {
          setOperation(recovered);
          await reload({ quiet: true });
          return;
        }
      } catch {}
      setError(uiErrorMessage(caught, t));
    } finally {
      setBusy(false);
    }
  }

  const state = readState(operation);
  const active = isActive(state);
  const progress = Number(operation?.progress?.percent);
  const findings = result ? [...(result.deterministic_findings ?? []), ...(result.advisory_findings ?? [])] : [];
  return <div className="screen narrow-screen" data-testid="tc-cc-media-review">
    <BackButton onClick={() => navigate({ page: 'confirm', view: 'list' })} t={t} />
    <PageHeading eyebrow={t('media.result.eyebrow', 'Private local video review')} title={t('media.result.title', 'Video review')} />
    {!operation && !error ? <StatePanel title={t('review.state.loadingTitle', 'Loading review')} text={t('review.state.loadingText', 'Reading the latest status.')} /> : null}
    {operation && active ? <section className="progress-panel media-progress" aria-live="polite">
      <span className="progress-mark" aria-hidden="true">▶</span>
      <div>
        <p className="eyebrow">{t('media.progress.local', 'Processing privately on this computer')}</p>
        <h2>{mediaProgressLabel(operation?.progress?.phase, t)}</h2>
        <p className="muted">{Number.isFinite(progress) ? formatCopy(t('media.progress.percent', '{percent}% complete'), { percent: Math.round(progress) }) : t('media.progress.wait', 'This page updates automatically.')}</p>
      </div>
      {operation?.capabilities?.cancel ? <button className="secondary-action" type="button" disabled={busy} onClick={cancel}>{t('media.action.cancel', 'Stop review')}</button> : null}
    </section> : null}
    {error ? <InlineNotice tone="danger" title={t('media.result.loadFailed', 'The video review could not be loaded')} text={error} /> : null}
    {operation && ['failed', 'cancelled', 'interrupted', 'cleanup_required'].includes(state) ? <StatePanel
      tone={state === 'cancelled' ? 'warning' : 'danger'}
      title={state === 'cancelled' ? t('media.result.cancelled', 'The video review was stopped') : t('media.result.failed', 'The video review did not finish')}
      text={operation?.errors?.[0]?.message ?? t('media.result.failedText', 'No successful result was recorded.')}
      action={operation?.cleanup_available ? <button className="secondary-action" type="button" disabled={busy} onClick={cleanup}>{t('media.action.cleanup', 'Remove private source data')}</button> : null}
    /> : null}
    {result ? <section className="media-review-result">
      <InlineNotice
        tone="success"
        title={t('media.result.ready', 'Your time-coded review is ready')}
        text={formatCopy(t('media.result.summary', '{count} evidence-linked finding(s). Deterministic measurements and advisory evaluations are shown separately.'), { count: findings.length })}
      />
      <div className="summary-strip" aria-label={t('media.result.summaryLabel', 'Video review summary')}>
        <Metric label={t('media.result.technical', 'Technical measurements')} value={result.deterministic_findings?.length ?? 0} />
        <Metric label={t('media.result.advisory', 'Advisory evaluations')} value={result.advisory_findings?.length ?? 0} />
        <Metric label={t('media.result.transcriptSegments', 'Timed speech segments')} value={result.transcript?.timed_segment_count ?? 0} />
      </div>
      <MediaFindingSection title={t('media.result.technical', 'Technical measurements')} findings={result.deterministic_findings ?? []} t={t} />
      <MediaFindingSection title={t('media.result.advisory', 'Advisory evaluations')} findings={result.advisory_findings ?? []} t={t} />
      {result.limitations?.length ? <section className="media-limitations"><h2>{t('media.result.limitations', 'Review limitations')}</h2><ul>{result.limitations.map((item) => <li key={item}>{humanizeMediaToken(item)}</li>)}</ul></section> : null}
      <InlineNotice tone="neutral" title={t('media.result.privacy', 'Private source data stays protected')} text={t('media.result.privacyText', 'The report contains no raw video, audio, frames, absolute paths, or complete transcript. Nothing was sent outside this computer.')} />
      {operation?.cleanup_available ? <div className="form-actions"><button className="secondary-action" type="button" disabled={busy} onClick={cleanup}>{t('media.action.cleanup', 'Remove private source data')}</button></div> : null}
    </section> : null}
  </div>;
}

function MediaFindingSection({ title, findings, t }) {
  return <section className="media-finding-section"><h2>{title}</h2>{findings.length ? <ol className="media-finding-list">{findings.map((finding) => <li className="media-finding-card" key={finding.id}>
    <div className="media-finding-heading"><span className={`status-badge ${mediaSeverityTone(finding.severity)}`}>{humanizeMediaToken(finding.severity)}</span><strong>{finding.timecode?.start ?? '00:00.000'}–{finding.timecode?.end ?? finding.timecode?.start ?? '00:00.000'}</strong></div>
    <h3>{humanizeMediaToken(finding.kind)}</h3>
    <dl className="result-facts compact-facts">
      <div><dt>{t('media.finding.evidence', 'Evidence')}</dt><dd>{(finding.evidence ?? []).join(' ')}</dd></div>
      <div><dt>{t('media.finding.method', 'Method')}</dt><dd>{humanizeMediaToken(finding.method)}</dd></div>
      <div><dt>{t('media.finding.confidence', 'Confidence')}</dt><dd>{formatConfidence(finding.confidence)}</dd></div>
      <div><dt>{t('media.finding.classification', 'Classification')}</dt><dd>{finding.classification === 'deterministic_measurement' ? t('media.finding.deterministic', 'Technical measurement') : t('media.finding.advisory', 'Advisory evaluation')}</dd></div>
      {finding.limitations?.length ? <div><dt>{t('media.finding.limitations', 'Limitations')}</dt><dd>{finding.limitations.map(humanizeMediaToken).join('; ')}</dd></div> : null}
      <div><dt>{t('media.finding.recommendation', 'Recommended fix')}</dt><dd>{finding.recommendation}</dd></div>
    </dl>
  </li>)}</ol> : <p className="muted">{t('media.result.none', 'No findings in this category.')}</p>}</section>;
}

function mediaInputLimitLabel(readiness, t) {
  const extensions = readiness?.local_input?.accepted_extensions;
  const maximumBytes = readiness?.local_input?.maximum_bytes;
  const formats = Array.isArray(extensions) && extensions.length
    ? extensions.map((value) => value.replace(/^\./u, '').toUpperCase()).join(', ')
    : t('media.file.formatsFallback', 'Supported video formats');
  const size = Number.isSafeInteger(maximumBytes) && maximumBytes > 0
    ? maximumBytes >= 1024 * 1024
      ? `${Math.floor(maximumBytes / (1024 * 1024))} MB`
      : `${Math.floor(maximumBytes / 1024)} KB`
    : t('media.file.privateLimit', 'the configured local limit');
  return formatCopy(t('media.file.limit', '{formats} · up to {size}'), { formats, size });
}

function SavedIntakeResultPage({ resultId, locale, navigate, t }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let active = true;
    getReviewIntakeResult(resultId)
      .then((value) => { if (active) setResult(value); })
      .catch((caught) => { if (active) setError(uiErrorMessage(caught, t)); });
    return () => { active = false; };
  }, [resultId, t]);
  return <div className="screen narrow-screen" data-testid="tc-cc-intake-result">
    <BackButton onClick={() => navigate({ page: 'confirm', view: 'list' })} t={t} />
    <PageHeading eyebrow={t('intake.result.savedEyebrow', 'Result details')} title={t('intake.result.savedTitle', 'Saved result')} />
    {!result && !error ? <StatePanel title={t('review.state.loadingTitle', 'Loading review')} text={t('review.state.loadingText', 'Reading the latest status.')} /> : null}
    {error ? <StatePanel tone="danger" title={t('review.state.failedTitle', 'The result could not be loaded')} text={error} /> : null}
    {result ? <section className="saved-intake-result">
      <IntakeResult result={result} t={t} />
      <dl className="result-facts">
        <div><dt>{t('intake.result.kind', 'Reviewed item')}</dt><dd>{intakeKindLabel(result.source_kind, t)}</dd></div>
        <div><dt>{t('intake.result.savedAt', 'Saved')}</dt><dd>{formatCompletedAt(result.completed_at, locale)}</dd></div>
        {result.review_goal ? <div><dt>{t('review.purpose.question', 'Review goal')}</dt><dd>{result.review_goal}</dd></div> : null}
        {savedResultFacts(result, t, locale).map((fact) => <div key={fact.key}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
      </dl>
    </section> : null}
  </div>;
}

function intakeResultPresentation(result, t) {
  const summary = result?.summary ?? {};
  if (result?.outcome === 'test_evidence_ready') {
    const total = safeCount(summary.total);
    const passed = safeCount(summary.passed);
    const failed = safeCount(summary.failed);
    const timedOut = safeCount(summary.timed_out);
    const status = String(summary.status ?? '').toLowerCase();
    if (failed > 0 || timedOut > 0 || ['failed', 'blocked', 'stale', 'error'].includes(status)) {
      return {
        tone: 'danger',
        title: t('intake.result.testAttentionTitle', 'Some automated checks need attention'),
        text: timedOut > 0
          ? formatCopy(t('intake.result.testTimeoutText', '{failed} failed and {timedOut} timed out among {total} checks. {passed} passed.'), { failed, timedOut, total, passed })
          : formatCopy(t('intake.result.testAttentionText', '{failed} of {total} checks did not pass. {passed} passed.'), { failed, total, passed })
      };
    }
    if (total === 0 || passed + failed + timedOut === 0 || ['empty', 'evidence_missing'].includes(status)) {
      return {
        tone: 'warning',
        title: t('intake.result.testMissingTitle', 'No usable automated-check result was found'),
        text: t('intake.result.testMissingText', 'Choose a result that contains at least one completed check.')
      };
    }
    return {
      tone: 'success',
      title: t('intake.result.testTitle', 'The test result is organized'),
      text: formatCopy(t('intake.result.testSummaryText', '{passed} of {total} checks passed.'), { total, passed })
    };
  }
  if (result?.outcome === 'image_evidence_ready') {
    const dimensions = summary.width && summary.height ? `${summary.width} × ${summary.height}` : null;
    return {
      tone: 'success',
      title: t('intake.result.imageTitle', 'Image evidence is ready'),
      text: dimensions
        ? formatCopy(t('intake.result.imageSummaryText', 'The image is {dimensions}. It stays in this local workspace.'), { dimensions })
        : t('intake.result.imageText', 'TraceCue checked the image format and prepared local evidence. A visual AI review was not run.')
    };
  }
  if (result?.outcome === 'review_proposal_ready') {
    return {
      tone: 'success',
      title: t('intake.result.documentTitle', 'The review proposal is ready'),
      text: Number.isInteger(summary.characters)
        ? formatCopy(t('intake.result.documentSummaryText', '{characters} characters were prepared for the selected review.'), { characters: summary.characters })
        : t('intake.result.documentText', 'TraceCue prepared the document for the next review step. No external AI review was run.')
    };
  }
  return { tone: 'neutral', title: t('intake.ready', 'Review preparation is ready'), text: '' };
}

function savedResultFacts(result, t, locale) {
  const summary = result?.summary ?? {};
  if (result?.source_kind === 'playwright_result') {
    return [
      { key: 'total', label: t('intake.result.total', 'Checks'), value: formatNumber(summary.total, locale) },
      { key: 'passed', label: t('intake.result.passed', 'Passed'), value: formatNumber(summary.passed, locale) },
      { key: 'failed', label: t('intake.result.failed', 'Failed'), value: formatNumber(summary.failed, locale) },
      { key: 'timed-out', label: t('intake.result.timedOut', 'Timed out'), value: formatNumber(summary.timed_out, locale) },
      { key: 'skipped', label: t('intake.result.skipped', 'Not run'), value: formatNumber(summary.skipped, locale) }
    ];
  }
  if (result?.source_kind === 'image') {
    const facts = [];
    if (summary.format) facts.push({ key: 'format', label: t('intake.result.format', 'Image type'), value: String(summary.format).toUpperCase() });
    if (summary.width && summary.height) facts.push({ key: 'dimensions', label: t('intake.result.dimensions', 'Image size'), value: `${formatNumber(summary.width, locale)} × ${formatNumber(summary.height, locale)}` });
    facts.push({ key: 'findings', label: t('intake.result.findings', 'Improvements found'), value: formatNumber(summary.finding_count, locale) });
    return facts;
  }
  if (result?.source_kind === 'document_text') {
    const facts = [];
    if (REVIEW_METHOD_IDS.includes(result.review_method)) facts.push({ key: 'method', label: t('intake.result.method', 'Review detail'), value: reviewMethodCopy(t, result.review_method).title });
    if (Number.isInteger(summary.characters)) facts.push({ key: 'characters', label: t('intake.result.characters', 'Characters'), value: formatNumber(summary.characters, locale) });
    if (Number.isInteger(summary.sections)) facts.push({ key: 'sections', label: t('intake.result.sections', 'Sections'), value: formatNumber(summary.sections, locale) });
    return facts;
  }
  return [];
}

function sourceActionLabel(sourceKind, t) {
  if (sourceKind === 'image') return t('review.action.prepareImage', 'Prepare image evidence');
  if (sourceKind === 'document_text') return t('review.action.prepareDocument', 'Prepare review proposal');
  if (sourceKind === 'playwright_result') return t('review.action.prepareTest', 'Organize test result');
  return t('review.action.start', 'Prepare review');
}

function AiConnectionEditor({ aiConnections, value, onChange, t, compact = false, disabled: disabledByAction = false }) {
  const connections = Array.isArray(aiConnections?.connections) ? aiConnections.connections : [];
  const selected = describeAiSelection(aiConnections, value) ?? describeAiSelection(aiConnections, readAiSelection(aiConnections));
  const connection = selected?.connection ?? connections.find((item) => item.status === 'available') ?? connections[0];
  const model = selected?.model ?? connection?.models?.find((item) => item.option_id === connection.default_model_option_id) ?? connection?.models?.[0];
  const effort = selected?.effort ?? model?.efforts?.find((item) => item.option_id === model.default_effort_option_id) ?? model?.efforts?.[0];
  const disabled = disabledByAction || aiConnections?.status !== 'available';
  function chooseConnection(optionId) {
    const nextConnection = connections.find((item) => item.option_id === optionId);
    const nextModel = nextConnection?.models?.find((item) => item.option_id === nextConnection.default_model_option_id) ?? nextConnection?.models?.[0];
    const nextEffort = nextModel?.efforts?.find((item) => item.option_id === nextModel.default_effort_option_id) ?? nextModel?.efforts?.[0];
    if (nextConnection && nextModel && nextEffort) onChange(aiSelectionValue(nextConnection, nextModel, nextEffort));
  }
  function chooseModel(optionId) {
    const nextModel = connection?.models?.find((item) => item.option_id === optionId);
    const nextEffort = nextModel?.efforts?.find((item) => item.option_id === nextModel.default_effort_option_id) ?? nextModel?.efforts?.[0];
    if (connection && nextModel && nextEffort) onChange(aiSelectionValue(connection, nextModel, nextEffort));
  }
  function chooseEffort(optionId) {
    const nextEffort = model?.efforts?.find((item) => item.option_id === optionId);
    if (connection && model && nextEffort) onChange(aiSelectionValue(connection, model, nextEffort));
  }
  if (!connection || !model || !effort) return <p className="muted">{t('settings.aiNoService', 'No AI service is ready yet.')}</p>;
  const choiceCount = connections.filter((item) => item.status === 'available').length + model.efforts.length + connection.models.length;
  return (
    <div className={`ai-connection-editor${compact ? ' compact' : ''}`}>
      {connections.filter((item) => item.status === 'available').length > 1 ? <label><span>{t('settings.aiService', 'AI service')}</span><select disabled={disabled} value={connection.option_id} onChange={(event) => chooseConnection(event.target.value)}>{connections.map((item) => <option key={item.option_id} value={item.option_id} disabled={item.status !== 'available'}>{item.name}</option>)}</select></label> : null}
      {connection.models.length > 1 ? <label><span>{t('settings.aiModel', 'AI model')}</span><select disabled={disabled} value={model.option_id} onChange={(event) => chooseModel(event.target.value)}>{connection.models.map((item) => <option key={item.option_id} value={item.option_id}>{item.name}</option>)}</select></label> : null}
      {model.efforts.length > 1 ? <details className="ai-details"><summary>{t('settings.aiDetails', 'AI details')}</summary><label><span>{t('settings.aiProcessingLevel', 'AI processing level')}</span><select disabled={disabled} value={effort.option_id} onChange={(event) => chooseEffort(event.target.value)}>{model.efforts.map((item) => <option key={item.option_id} value={item.option_id}>{item.name}{item.recommended ? ` · ${t('common.recommended', 'Recommended')}` : ''}</option>)}</select><small>{t('settings.aiProcessingHint', 'This is separate from TraceCue’s review method.')}</small></label></details> : null}
      {choiceCount <= 3 ? <p className="muted compact-copy">{model.name}</p> : null}
    </div>
  );
}

function aiConnectionStatusLabel(value, t) {
  if (value?.status === 'available') return t('settings.aiAvailable', 'Available');
  if (value?.status === 'stale') return t('settings.aiStale', 'Update needed');
  if (value?.status === 'setup_required') return t('settings.aiSetupRequired', 'Setup needed');
  if (value?.status === 'error') return t('settings.aiUnavailable', 'Unavailable');
  return t('settings.aiNotChecked', 'Not checked');
}

function aiConnectionDescription(value, t) {
  if (value?.status === 'available') return t('settings.aiAvailableHint', 'Suggestions are ready to use.');
  if (value?.status === 'stale') return t('settings.aiStaleHint', 'Update availability before starting a new AI review.');
  if (value?.status === 'setup_required') return t('settings.aiSetupHint', 'Finish the private connection setup, or continue without AI.');
  if (value?.status === 'error') return t('settings.aiUnavailableHint', 'Local reviews remain available without AI.');
  return t('settings.aiNotCheckedHint', 'Check the AI services available on this computer.');
}

function aiSetupGuidance(value, t) {
  return aiConnectionDescription(value, t);
}

function readAiSelection(aiConnections) {
  const selection = aiConnections?.selection;
  return selection ? {
    connection_option_id: selection.connection_option_id,
    model_option_id: selection.model_option_id,
    effort_option_id: selection.effort_option_id
  } : null;
}

function describeAiSelection(aiConnections, value) {
  if (!value) return null;
  const connection = aiConnections?.connections?.find((item) => item.option_id === value.connection_option_id);
  const model = connection?.models?.find((item) => item.option_id === value.model_option_id);
  const effort = model?.efforts?.find((item) => item.option_id === value.effort_option_id);
  return connection && model && effort ? { connection, model, effort } : null;
}

function aiSelectionValue(connection, model, effort) {
  return {
    connection_option_id: connection.option_id,
    model_option_id: model.option_id,
    effort_option_id: effort.option_id
  };
}

function firstAvailableAiSelection(aiConnections) {
  const connection = aiConnections?.connections?.find((item) => item.status === 'available');
  const model = connection?.models?.find((item) => item.option_id === connection.default_model_option_id) ?? connection?.models?.[0];
  const effort = model?.efforts?.find((item) => item.option_id === model.default_effort_option_id) ?? model?.efforts?.[0];
  return connection && model && effort ? aiSelectionValue(connection, model, effort) : null;
}

function hasAlternativeAiSelection(aiConnections, value) {
  const selected = describeAiSelection(aiConnections, value) ?? describeAiSelection(aiConnections, readAiSelection(aiConnections));
  const availableConnections = aiConnections?.connections?.filter((item) => item.status === 'available') ?? [];
  return availableConnections.length > 1
    || (selected?.connection?.models?.length ?? 0) > 1
    || (selected?.model?.efforts?.length ?? 0) > 1;
}

function sameAiSelection(left, right) {
  return Boolean(left && right)
    && left.connection_option_id === right.connection_option_id
    && left.model_option_id === right.model_option_id
    && left.effort_option_id === right.effort_option_id;
}

function aiProjectionVersion(value) {
  return `${value?.capability_token ?? ''}:${value?.settings_revision ?? value?.storage_revision ?? 0}`;
}

function SendConfirmationDialog({ open, confirmation, busy, returnFocusRef, onCancel, onConfirm, t }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  async function close() {
    await onCancel();
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  }
  const disclosure = readDisclosure(confirmation, t);
  return (
    <dialog ref={dialogRef} className="send-dialog" aria-labelledby="send-dialog-title" onCancel={(event) => { event.preventDefault(); close(); }} onClose={() => returnFocusRef.current?.focus()}>
      <div className="dialog-heading">
        <div><p className="eyebrow">{t('send.eyebrow', 'Before sending')}</p><h2 id="send-dialog-title">{t('send.title', 'Start this review?')}</h2></div>
        <button className="icon-action" type="button" onClick={close} disabled={busy} aria-label={t('common.close', 'Close')}>×</button>
      </div>
      <p>{t('send.description', 'TraceCue will send the following information to the configured AI service.')}</p>
      <dl className="send-summary">
        <div><dt>{t('send.content', 'Information sent')}</dt><dd>{disclosure.items.join(', ') || t('send.contentFallback', 'The page and your review goal')}</dd></div>
        <div><dt>{t('send.destination', 'Sent to')}</dt><dd>{disclosure.destination || t('send.destinationFallback', 'Your configured AI service')}</dd></div>
        {disclosure.reviewMethod ? <div><dt>{t('send.reviewMethod', 'Review method')}</dt><dd>{reviewMethodCopy(t, disclosure.reviewMethod).label}</dd></div> : null}
        <div><dt>{t('send.storage', 'Saved for')}</dt><dd>{disclosure.storage || t('send.storageFallback', 'This review')}</dd></div>
      </dl>
      {disclosure.model || disclosure.processingLevel ? <details className="send-ai-details"><summary>{t('send.aiSettings', 'AI settings')}</summary><p>{[disclosure.model, disclosure.processingLevel].filter(Boolean).join(' · ')}</p></details> : null}
      <div className="dialog-actions">
        <button className="secondary-action" type="button" onClick={close} disabled={busy}>{t('review.action.cancel', 'Cancel')}</button>
        <button className="primary-action" type="button" disabled={busy} onClick={onConfirm}>{busy ? t('send.starting', 'Starting...') : t('review.action.startExecuting', 'Start review')}</button>
      </div>
    </dialog>
  );
}

function AiSetupDialog({ open, aiSetup, aiConnections, returnFocusRef, fallbackFocusRef, onClose, onComplete, t }) {
  const dialogRef = useRef(null);
  const headingRef = useRef(null);
  const keyInputRef = useRef(null);
  const finishingRef = useRef(false);
  const previousLoginStatusRef = useRef(aiSetup?.subscription_login?.status ?? null);
  const loginRequestGenerationRef = useRef(0);
  const loginActionPendingRef = useRef(false);
  const [view, setView] = useState('choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [login, setLogin] = useState(aiSetup?.subscription_login ?? null);
  const [loginPollRevision, setLoginPollRevision] = useState(0);
  const [revision, setRevision] = useState(aiConnections?.storage_revision ?? 0);
  const services = Array.isArray(aiSetup?.services) ? aiSetup.services : [];
  const subscription = services.find((service) => service.kind === 'subscription');
  const api = services.find((service) => service.kind === 'api');
  const loginActive = ['starting', 'waiting', 'checking'].includes(login?.status);
  const canCancelLogin = loginActive && login?.can_cancel === true;
  const selectedConnection = selectedAiConnection(aiConnections);
  const managedSessionConnection = aiSetup?.connection?.session_managed === true ? aiSetup.connection : null;
  const currentConnection = managedSessionConnection ?? selectedConnection;
  const canDisconnectCurrent = Boolean(managedSessionConnection?.can_disconnect);
  const canReplaceCurrentApi = managedSessionConnection?.kind === 'api' && managedSessionConnection?.can_replace === true;
  const currentIsSubscription = currentConnection?.kind === 'subscription';

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && !dialog.open) {
      loginRequestGenerationRef.current += 1;
      loginActionPendingRef.current = false;
      setView(subscriptionViewForLogin(aiSetup?.subscription_login));
      setBusy(false);
      setError(null);
      setApiKey('');
      setLogin(aiSetup?.subscription_login ?? null);
      setRevision(aiConnections?.storage_revision ?? 0);
      finishingRef.current = false;
      previousLoginStatusRef.current = aiSetup?.subscription_login?.status ?? null;
      dialog.showModal();
      window.requestAnimationFrame(() => headingRef.current?.focus());
    }
    if (!open && dialog.open) {
      loginRequestGenerationRef.current += 1;
      loginActionPendingRef.current = false;
      dialog.close();
    }
  }, [open, aiSetup?.subscription_login?.status, aiConnections?.storage_revision]);

  useEffect(() => {
    if (!open || !subscription || loginActionPendingRef.current) return undefined;
    let active = true;
    const generation = ++loginRequestGenerationRef.current;
    fetchCodexSubscriptionStatus()
      .then((next) => {
        if (!active || generation !== loginRequestGenerationRef.current) return;
        setLogin(next);
        if (['starting', 'waiting', 'checking', 'connected'].includes(next?.status)) changeView('subscription');
      })
      .catch(() => {});
    return () => { active = false; };
  }, [open, subscription?.option_id]);

  useEffect(() => {
    if (!open || !loginActive) return undefined;
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      if (loginActionPendingRef.current) {
        timer = window.setTimeout(poll, 150);
        return;
      }
      const generation = ++loginRequestGenerationRef.current;
      try {
        const next = await fetchCodexSubscriptionStatus();
        if (cancelled || generation !== loginRequestGenerationRef.current) return;
        setError(null);
        setLogin(next);
        if (['starting', 'waiting', 'checking'].includes(next?.status)) {
          timer = window.setTimeout(poll, 750);
        }
      } catch (caught) {
        if (!cancelled && generation === loginRequestGenerationRef.current) {
          setError(aiSetupErrorMessage(caught, t));
          timer = window.setTimeout(poll, 1_500);
        }
      }
    };
    timer = window.setTimeout(poll, 750);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, loginActive, loginPollRevision, t]);

  useEffect(() => {
    const previous = previousLoginStatusRef.current;
    const current = login?.status ?? null;
    previousLoginStatusRef.current = current;
    if (!open || !previous || previous === current) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (dialog?.open && !dialog.contains(document.activeElement)) headingRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, login?.status]);

  useEffect(() => {
    if (!open || !finishingRef.current || !currentIsSubscription) return;
    setLogin((current) => ({ ...current, status: 'complete' }));
    onClose();
  }, [open, currentIsSubscription, onClose]);

  useEffect(() => {
    if (!open || login?.status !== 'connected' || finishingRef.current) return;
    finishingRef.current = true;
    loginActionPendingRef.current = true;
    const generation = ++loginRequestGenerationRef.current;
    setBusy(true);
    finishCodexSubscription(revision)
      .then(async () => {
        await onComplete();
        if (generation !== loginRequestGenerationRef.current) return;
        setLogin((current) => ({ ...current, status: 'complete' }));
        onClose();
      })
      .catch(async (caught) => {
        const errorCode = apiErrorCode(caught);
        const latest = (!caught?.envelope
          || isAiRevisionConflict(caught)
          || errorCode === 'CONTROL_CENTER_CODEX_LOGIN_NOT_READY')
          ? await onComplete().catch(() => null)
          : null;
        if (generation !== loginRequestGenerationRef.current) return;
        if (Number.isSafeInteger(latest?.ai_connections?.storage_revision)) {
          setRevision(latest.ai_connections.storage_revision);
        }
        if ((hasAdvancedAiRevision(latest?.ai_connections, revision)
            || errorCode === 'CONTROL_CENTER_CODEX_LOGIN_NOT_READY')
          && isSelectedConnectionKind(latest?.ai_connections, 'subscription')) {
          setLogin((current) => ({ ...current, status: 'complete' }));
          onClose();
          return;
        }
        finishingRef.current = false;
        setError(aiSetupErrorMessage(caught, t));
      })
      .finally(() => {
        if (generation === loginRequestGenerationRef.current) {
          loginActionPendingRef.current = false;
          setBusy(false);
        }
      });
  }, [open, login?.status, revision, onComplete, onClose, t]);

  function close() {
    if (busy) return;
    loginRequestGenerationRef.current += 1;
    loginActionPendingRef.current = false;
    setApiKey('');
    onClose();
  }

  async function connectSubscription() {
    if (!subscription) return;
    loginActionPendingRef.current = true;
    const generation = ++loginRequestGenerationRef.current;
    setBusy(true);
    setError(null);
    let actionRevision = revision;
    try {
      const checked = await refreshAiConnections({
        confirm: 'refresh-ai-availability',
        expected_revision: revision
      });
      const nextRevision = checked?.storage_revision ?? revision;
      actionRevision = nextRevision;
      setRevision(nextRevision);
      const ready = checked?.connections?.find((connection) => connection.kind === 'subscription' && connection.status === 'available');
      if (ready) {
        const selection = defaultAiSelectionForConnection(checked, ready);
        if (selection) {
          await saveAiConnectionSelection({
            ...selection,
            capability_revision: checked.revision,
            capability_token: checked.capability_token,
            expected_revision: checked.storage_revision,
            confirm: 'save-ai-selection'
          });
        }
        await onComplete();
        onClose();
        return;
      }
      const next = await startCodexSubscription({
        service_option_id: subscription.option_id,
        expected_revision: nextRevision
      });
      if (generation !== loginRequestGenerationRef.current) return;
      setLogin(next);
      changeView('subscription');
    } catch (caught) {
      if (apiErrorCode(caught) === 'CONTROL_CENTER_CODEX_LOGIN_BUSY') {
        try {
          const next = await fetchCodexSubscriptionStatus();
          if (generation === loginRequestGenerationRef.current
            && ['starting', 'waiting', 'checking', 'connected'].includes(next?.status)) {
            setLogin(next);
            changeView('subscription');
            return;
          }
        } catch {}
      }
      if (!caught?.envelope || isAiRevisionConflict(caught)) {
        const latest = await onComplete().catch(() => null);
        if (generation !== loginRequestGenerationRef.current) return;
        if (Number.isSafeInteger(latest?.ai_connections?.storage_revision)) {
          setRevision(latest.ai_connections.storage_revision);
        }
        const latestLogin = latest?.ai_setup?.subscription_login;
        if (['starting', 'waiting', 'checking', 'connected'].includes(latestLogin?.status)) {
          setLogin(latestLogin);
          setLoginPollRevision((value) => value + 1);
          changeView('subscription');
          return;
        }
        if (hasAdvancedAiRevision(latest?.ai_connections, actionRevision)
          && isSelectedConnectionKind(latest?.ai_connections, 'subscription')) {
          onClose();
          return;
        }
      }
      if (generation === loginRequestGenerationRef.current) setError(aiSetupErrorMessage(caught, t));
    } finally {
      if (generation === loginRequestGenerationRef.current) {
        loginActionPendingRef.current = false;
        setBusy(false);
      }
    }
  }

  async function cancelSubscription() {
    loginActionPendingRef.current = true;
    const generation = ++loginRequestGenerationRef.current;
    setBusy(true);
    setError(null);
    try {
      const next = await cancelCodexSubscription();
      if (generation === loginRequestGenerationRef.current) setLogin(next);
    } catch (caught) {
      let latest = null;
      try { latest = await fetchCodexSubscriptionStatus(); } catch {}
      if (generation !== loginRequestGenerationRef.current) return;
      if (latest) setLogin(latest);
      if (['starting', 'waiting', 'checking'].includes(latest?.status)) {
        setLoginPollRevision((value) => value + 1);
      }
      if (!['idle', 'cancelled'].includes(latest?.status)) {
        setError(aiSetupErrorMessage(caught, t));
      }
    } finally {
      if (generation === loginRequestGenerationRef.current) {
        loginActionPendingRef.current = false;
        setBusy(false);
      }
    }
  }

  async function connectApi(event) {
    event.preventDefault();
    if (!api || !apiKey) return;
    setBusy(true);
    setError(null);
    const key = apiKey;
    const previousRevision = revision;
    setApiKey('');
    if (keyInputRef.current) keyInputRef.current.value = '';
    try {
      const intent = await createAiSetupIntent({
        service_option_id: api.option_id,
        expected_revision: revision
      });
      await submitAiApiKey(intent.submission_id, key);
      await onComplete();
      onClose();
    } catch (caught) {
      const transportLost = !caught?.envelope;
      const revisionConflict = isAiRevisionConflict(caught);
      const latest = (transportLost || revisionConflict)
        ? await onComplete().catch(() => null)
        : null;
      if (Number.isSafeInteger(latest?.ai_connections?.storage_revision)) {
        setRevision(latest.ai_connections.storage_revision);
      }
      if (hasAdvancedAiRevision(latest?.ai_connections, previousRevision)
        && latest?.ai_setup?.status === 'connected'
        && latest.ai_setup.connection?.kind === 'api') {
        changeView('choose');
        setError(revisionConflict
          ? t('aiSetup.errorChanged', 'The AI choice changed in another screen. Close this window and open it again.')
          : null);
        return;
      }
      setError(aiSetupErrorMessage(caught, t));
    } finally {
      setBusy(false);
    }
  }

  async function disconnectApi() {
    setBusy(true);
    setError(null);
    try {
      await disconnectAiService({ expected_revision: revision });
      await onComplete();
      onClose();
    } catch (caught) {
      const latest = (!caught?.envelope || isAiRevisionConflict(caught))
        ? await onComplete().catch(() => null)
        : null;
      if (Number.isSafeInteger(latest?.ai_connections?.storage_revision)) {
        setRevision(latest.ai_connections.storage_revision);
      }
      if (latest && hasAdvancedAiRevision(latest.ai_connections, revision)
        && (latest.ai_setup?.status !== 'connected' || latest.ai_setup?.connection?.kind !== 'api')) {
        onClose();
        return;
      }
      setError(aiSetupErrorMessage(caught, t));
    } finally {
      setBusy(false);
    }
  }

  function changeView(next) {
    setView(next);
    window.requestAnimationFrame(() => headingRef.current?.focus());
  }

  const signInUrl = safeCodexSignInUrl(login?.verification_url);
  return (
    <dialog
      ref={dialogRef}
      className="send-dialog ai-setup-dialog"
      aria-labelledby="ai-setup-title"
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClose={() => (returnFocusRef.current ?? fallbackFocusRef?.current)?.focus()}
    >
      <div className="dialog-heading">
        <div>
          <p className="eyebrow">{t('aiSetup.eyebrow', 'AI suggestions')}</p>
          <h2 ref={headingRef} tabIndex="-1" id="ai-setup-title">{t('aiSetup.title', 'Set up AI')}</h2>
        </div>
        <button className="icon-action" type="button" onClick={close} disabled={busy} aria-label={t('common.close', 'Close')}>×</button>
      </div>

      {view === 'choose' ? <>
        <p className="ai-setup-intro">{t('aiSetup.intro', 'Choose the service you already use.')}</p>
        {currentConnection ? <div className="ai-setup-current">
          <span aria-hidden="true">✓</span>
          <div><strong>{t('aiSetup.connected', 'Connected')}</strong><p>{currentConnection.name}</p></div>
          {canReplaceCurrentApi || canDisconnectCurrent ? <div className="ai-setup-current-actions">
            {canReplaceCurrentApi ? <button className="link-action" type="button" disabled={busy} onClick={() => { changeView('api'); setError(null); }}>{t('aiSetup.replaceApiKey', 'Change API key')}</button> : null}
            {canDisconnectCurrent ? <button className="link-action" type="button" disabled={busy} onClick={disconnectApi}>{t('aiSetup.disconnect', 'Disconnect')}</button> : null}
          </div> : null}
        </div> : null}
        {subscription ? (!currentIsSubscription ? <button className="ai-service-choice recommended" type="button" disabled={busy} onClick={connectSubscription}>
          <span className="ai-service-mark" aria-hidden="true">C</span>
          <span><strong>{subscription.name}</strong><small>{t('aiSetup.subscriptionText', 'Use your subscription')}</small></span>
          <span className="recommended">{t('common.recommended', 'Recommended')}</span>
          <DirectionalSymbol symbol="›" />
        </button> : null) : <InlineNotice tone="warning" title={t('aiSetup.unavailable', 'AI setup is not available right now')} />}
        {api && !canReplaceCurrentApi ? <details className="ai-setup-alternative">
          <summary>{t('aiSetup.anotherMethod', 'Use another method')}</summary>
          <button type="button" className="ai-service-choice" onClick={() => { changeView('api'); setError(null); }}>
            <span className="ai-service-mark" aria-hidden="true">A</span>
            <span><strong>{api.name}</strong><small>{t('aiSetup.apiText', 'Connect with an API key')}</small></span>
            <DirectionalSymbol symbol="›" />
          </button>
        </details> : null}
      </> : null}

      {view === 'subscription' ? <div className="ai-setup-step" aria-live="polite">
        {login?.status === 'waiting' && signInUrl ? <>
          <p>{t('aiSetup.codeInstruction', 'Open the sign-in page, then enter this code.')}</p>
          <output className="device-code" aria-label={t('aiSetup.codeLabel', 'One-time code')}>{login.user_code}</output>
          <a className="primary-action" href={signInUrl} target="_blank" rel="noreferrer">{t('aiSetup.openSignIn', 'Open sign-in page')}<DirectionalSymbol symbol="↗" /></a>
          <p className="field-hint">{t('aiSetup.waiting', 'This screen will continue automatically after sign-in.')}</p>
        </> : null}
        {['starting', 'checking'].includes(login?.status) ? <div className="ai-setup-progress"><span aria-hidden="true" /><strong>{login?.status === 'checking' ? t('aiSetup.checking', 'Checking sign-in...') : t('aiSetup.starting', 'Preparing sign-in...')}</strong></div> : null}
        {login?.status === 'cancelled' ? <InlineNotice title={t('aiSetup.cancelled', 'Sign-in was cancelled')} /> : null}
        {login?.status === 'error' ? <InlineNotice tone="warning" title={t('aiSetup.signInFailed', 'Sign-in could not be completed')} text={t('aiSetup.tryAgainText', 'Try again when you are ready.')} /> : null}
        <div className="dialog-actions">
          {canCancelLogin ? <button className="secondary-action" type="button" disabled={busy} onClick={cancelSubscription}>{t('aiSetup.stop', 'Stop sign-in')}</button> : !loginActive ? <button className="secondary-action" type="button" onClick={() => changeView('choose')}>{t('common.back', 'Back')}</button> : null}
          {['cancelled', 'error'].includes(login?.status) ? <button className="primary-action" type="button" disabled={busy} onClick={connectSubscription}>{t('common.retry', 'Try again')}</button> : null}
        </div>
      </div> : null}

      {view === 'api' ? <form className="ai-setup-step" onSubmit={connectApi}>
        <p>{t('aiSetup.apiIntro', 'Enter the API key from your AI service.')}</p>
        <label className="field-label" htmlFor="ai-api-key">{t('aiSetup.apiKey', 'API key')}</label>
        <input
          ref={keyInputRef}
          id="ai-api-key"
          className="text-input"
          type="password"
          required
          minLength="8"
          maxLength="4096"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck="false"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <p className="field-hint">{t('aiSetup.sessionOnly', 'Used only while this Control Center is open. It is not saved in the browser or project.')}</p>
        <div className="dialog-actions">
          <button className="secondary-action" type="button" disabled={busy} onClick={() => { setApiKey(''); changeView('choose'); }}>{t('common.back', 'Back')}</button>
          <button className="primary-action" type="submit" disabled={busy || !apiKey}>{busy ? t('aiSetup.connecting', 'Connecting...') : t('aiSetup.connect', 'Connect')}</button>
        </div>
      </form> : null}

      {error ? <InlineNotice tone="danger" title={t('aiSetup.failed', 'AI could not be set up')} text={error} /> : null}
    </dialog>
  );
}

function safeCodexSignInUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'auth.openai.com' && url.pathname === '/codex/device'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function subscriptionViewForLogin(login) {
  return ['starting', 'waiting', 'checking', 'connected'].includes(login?.status) ? 'subscription' : 'choose';
}

function selectedAiConnection(aiConnections) {
  const optionId = aiConnections?.selection?.connection_option_id;
  return aiConnections?.connections?.find((connection) => (
    connection.option_id === optionId && connection.status === 'available'
  )) ?? null;
}

function isSelectedConnectionKind(aiConnections, kind) {
  return selectedAiConnection(aiConnections)?.kind === kind;
}

function hasAdvancedAiRevision(aiConnections, expectedRevision) {
  return Number.isSafeInteger(aiConnections?.storage_revision)
    && aiConnections.storage_revision > Number(expectedRevision ?? -1);
}

function isAiRevisionConflict(error) {
  return ['CONTROL_CENTER_AI_CONNECTION_REVISION_CONFLICT', 'CONTROL_CENTER_AI_SETUP_CHANGED']
    .includes(apiErrorCode(error));
}

function defaultAiSelectionForConnection(aiConnections, connection) {
  const model = connection?.models?.find((item) => item.option_id === connection.default_model_option_id)
    ?? connection?.models?.[0];
  const effort = model?.efforts?.find((item) => item.option_id === model.default_effort_option_id)
    ?? model?.efforts?.[0];
  return model && effort ? {
    connection_option_id: connection.option_id,
    model_option_id: model.option_id,
    effort_option_id: effort.option_id
  } : null;
}

function aiSetupErrorMessage(error, t) {
  const code = apiErrorCode(error);
  if (code === 'CONTROL_CENTER_AI_KEY_REJECTED') {
    return t('aiSetup.errorKey', 'The API key was not accepted. Check it and try again.');
  }
  if (code === 'CONTROL_CENTER_AI_MODEL_LIST_EMPTY') {
    return t('aiSetup.errorModel', 'This account does not currently include a supported AI model.');
  }
  if (code === 'CONTROL_CENTER_AI_CONNECTION_REVISION_CONFLICT'
    || code === 'CONTROL_CENTER_AI_SETUP_CHANGED'
    || code === 'CONTROL_CENTER_AI_BINDING_CHANGED') {
    return t('aiSetup.errorChanged', 'The AI choice changed in another screen. Close this window and open it again.');
  }
  if (code === 'CONTROL_CENTER_CODEX_LOGIN_CONTRACT_UNAVAILABLE'
    || code === 'CONTROL_CENTER_CODEX_NOT_FOUND'
    || code === 'CONTROL_CENTER_CODEX_PLATFORM_UNSUPPORTED') {
    return t('aiSetup.errorCodex', 'Codex on this computer cannot be connected from this screen yet.');
  }
  if (code === 'CONTROL_CENTER_CODEX_LOGIN_RESTART_REQUIRED') {
    return t('aiSetup.errorRestart', 'Sign-in stopped unexpectedly. Restart this computer, then try again.');
  }
  if (code === 'CONTROL_CENTER_PAIRING_REQUIRED'
    || code === 'CONTROL_CENTER_SESSION_REJECTED'
    || code === 'CONTROL_CENTER_SESSION_REQUIRED') {
    return t('aiSetup.errorReopen', 'Open the Control Center again in the usual way, then continue.');
  }
  if (code === 'CONTROL_CENTER_AI_CONNECTION_UNREACHABLE'
    || code === 'CONTROL_CENTER_AI_CONNECTION_UNAVAILABLE') {
    return t('aiSetup.errorNetwork', 'The AI service could not be reached. Check your connection and try again.');
  }
  return t('aiSetup.failedText', 'Nothing was changed. Check the service and try again.');
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

function ReviewWorkspace({ reviewId, dashboard, navigate, reload, t }) {
  const [operation, setOperation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState(false);
  const [findingIndex, setFindingIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [decisions, setDecisions] = useState({});
  const [confirmation, setConfirmation] = useState(null);
  const [needsAiRefresh, setNeedsAiRefresh] = useState(false);
  const startButtonRef = useRef(null);
  const reviewIdRef = useRef(reviewId);
  const statusRequestGeneration = useRef(0);
  const pendingRepeatRef = useRef(null);
  const actionPendingRef = useRef(false);
  const actionGenerationRef = useRef(0);
  const actionAbortRef = useRef(null);
  reviewIdRef.current = reviewId;

  async function refresh({ quiet = false } = {}) {
    const requestedReviewId = reviewId;
    const generation = ++statusRequestGeneration.current;
    if (!quiet) setLoading(true);
    try {
      const next = await fetchAgenticReviewStatus(requestedReviewId);
      if (generation !== statusRequestGeneration.current || reviewIdRef.current !== requestedReviewId) return false;
      setOperation(next);
      setStatusError(false);
      return true;
    } catch {
      if (generation !== statusRequestGeneration.current || reviewIdRef.current !== requestedReviewId) return false;
      setStatusError(true);
      return false;
    } finally {
      if (!quiet && generation === statusRequestGeneration.current && reviewIdRef.current === requestedReviewId) setLoading(false);
    }
  }
  useEffect(() => {
    actionGenerationRef.current += 1;
    actionAbortRef.current?.abort();
    statusRequestGeneration.current += 1;
    setOperation(null);
    setLoading(true);
    setStatusError(false);
    setFindingIndex(0);
    setDecisions({});
    setConfirmation(null);
    setNeedsAiRefresh(false);
    setSaving(false);
    pendingRepeatRef.current = null;
    actionPendingRef.current = false;
    refresh();
    return () => {
      statusRequestGeneration.current += 1;
      actionGenerationRef.current += 1;
      actionAbortRef.current?.abort();
    };
  }, [reviewId]);
  useEffect(() => {
    if (!operation || !isActive(readState(operation))) return undefined;
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      if (actionPendingRef.current) {
        timer = window.setTimeout(poll, 150);
        return;
      }
      await refresh({ quiet: true });
      if (!cancelled) timer = window.setTimeout(poll, 2000);
    };
    timer = window.setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
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
    const requestedReviewId = reviewId;
    const findingId = currentFinding.id;
    actionPendingRef.current = true;
    setSaving(true);
    setStatusError(false);
    try {
      await saveAgenticReviewDecision({ review_id: requestedReviewId, finding_id: findingId, decision });
      if (reviewIdRef.current !== requestedReviewId) return;
      setDecisions((current) => ({ ...current, [findingId]: decision }));
      if (findingIndex < findings.length - 1) setFindingIndex(findingIndex + 1);
      else await refresh({ quiet: true });
    } catch {
      if (reviewIdRef.current === requestedReviewId) setStatusError(true);
    } finally {
      if (reviewIdRef.current === requestedReviewId) {
        actionPendingRef.current = false;
        setSaving(false);
      }
    }
  }
  async function repeat(kind) {
    const requestedReviewId = reviewId;
    const action = beginPageAction(actionGenerationRef, actionAbortRef);
    actionPendingRef.current = true;
    setSaving(true);
    setStatusError(false);
    setNeedsAiRefresh(false);
    let pending = pendingRepeatRef.current;
    try {
      if (pending?.reviewId !== requestedReviewId || pending.kind !== kind) {
        const latestDashboard = await reload({ quiet: true });
        if (!isCurrentReviewAction(actionGenerationRef, reviewIdRef, requestedReviewId, action)) return;
        const aiConnections = latestDashboard?.ai_connections ?? dashboard?.ai_connections;
        const currentSelection = readAiSelection(aiConnections);
        pending = {
          reviewId: requestedReviewId,
          kind,
          baselineReviewIds: dashboardReviewIds(latestDashboard),
          payload: {
            review_id: requestedReviewId,
            repeat_kind: kind,
            idempotency_key: createRepeatIdempotencyKey(),
            ...(operation?.ai_suggestions && currentSelection ? {
              ...currentSelection,
              capability_revision: aiConnections.revision,
              capability_token: aiConnections.capability_token
            } : {})
          }
        };
        pendingRepeatRef.current = pending;
      }
      let next;
      try {
        next = await repeatAgenticReview(pending.payload, { signal: action.signal });
      } catch (caught) {
        if (!isCurrentReviewAction(actionGenerationRef, reviewIdRef, requestedReviewId, action)) return;
        if (caught?.envelope) {
          if (pendingRepeatRef.current === pending) pendingRepeatRef.current = null;
          throw caught;
        }
        const reconciledDashboard = await reload({ quiet: true });
        if (!isCurrentReviewAction(actionGenerationRef, reviewIdRef, requestedReviewId, action)) return;
        next = findNewRepeatedReview(reconciledDashboard, pending);
        if (!next) {
          try {
            next = await repeatAgenticReview(pending.payload, { signal: action.signal });
          } catch (reconciliationError) {
            if (reconciliationError?.envelope && pendingRepeatRef.current === pending) {
              pendingRepeatRef.current = null;
            }
            throw reconciliationError;
          }
        }
      }
      const nextId = readReviewId(next);
      if (!nextId) {
        throw new Error('Missing review');
      }
      if (!isCurrentReviewAction(actionGenerationRef, reviewIdRef, requestedReviewId, action)) return;
      if (pendingRepeatRef.current === pending) pendingRepeatRef.current = null;
      await reload({ quiet: true });
      if (!isCurrentReviewAction(actionGenerationRef, reviewIdRef, requestedReviewId, action)) return;
      navigate({ page: 'confirm', view: 'work', itemId: nextId });
    } catch (caught) {
      if (isCurrentReviewAction(actionGenerationRef, reviewIdRef, requestedReviewId, action)) {
        if (requiresAiProjectionRefresh(apiErrorCode(caught))) setNeedsAiRefresh(true);
        setStatusError(true);
      }
    } finally {
      if (isCurrentReviewAction(actionGenerationRef, reviewIdRef, requestedReviewId, action)) {
        actionPendingRef.current = false;
        setSaving(false);
      }
    }
  }
  async function requestStartConfirmation() {
    const requestedReviewId = reviewId;
    actionPendingRef.current = true;
    setSaving(true);
    setStatusError(false);
    try {
      const next = await fetchAgenticReviewConfirmation(requestedReviewId);
      if (reviewIdRef.current === requestedReviewId) setConfirmation(next);
    } catch {
      if (reviewIdRef.current === requestedReviewId) setStatusError(true);
    } finally {
      if (reviewIdRef.current === requestedReviewId) {
        actionPendingRef.current = false;
        setSaving(false);
      }
    }
  }
  async function resumeStart() {
    const requestedReviewId = reviewId;
    actionPendingRef.current = true;
    setSaving(true);
    setStatusError(false);
    try {
      const consent = readConsent(confirmation);
      await startAgenticReview({
        review_id: requestedReviewId,
        consent_token: consent.token,
        consent_revision: consent.revision,
        nonce: consent.token,
        revision: consent.revision,
        execute_confirmed: true
      });
      if (reviewIdRef.current !== requestedReviewId) return;
      setConfirmation(null);
      await refresh({ quiet: true });
      await reload({ quiet: true });
    } catch (caught) {
      if (reviewIdRef.current !== requestedReviewId) return;
      setConfirmation(null);
      if (apiErrorCode(caught) === 'CONTROL_CENTER_AGENTIC_REVIEW_DESTINATION_CHANGED') {
        setNeedsAiRefresh(true);
        await refresh({ quiet: true });
        await reload({ quiet: true });
        setStatusError(false);
      } else if (!caught?.envelope) {
        const statusReconciled = await refresh({ quiet: true });
        await reload({ quiet: true });
        if (reviewIdRef.current === requestedReviewId) setStatusError(!statusReconciled);
      } else {
        setStatusError(true);
      }
    } finally {
      if (reviewIdRef.current === requestedReviewId) {
        actionPendingRef.current = false;
        setSaving(false);
      }
    }
  }
  async function resumePreparation() {
    const requestedReviewId = reviewId;
    actionPendingRef.current = true;
    setSaving(true);
    setStatusError(false);
    try {
      await resumeAgenticReview(requestedReviewId);
      if (reviewIdRef.current !== requestedReviewId) return;
      await refresh({ quiet: true });
      await reload({ quiet: true });
    } catch {
      if (reviewIdRef.current === requestedReviewId) setStatusError(true);
    } finally {
      if (reviewIdRef.current === requestedReviewId) {
        actionPendingRef.current = false;
        setSaving(false);
      }
    }
  }
  async function cancelBeforeSend() {
    const requestedReviewId = reviewId;
    actionPendingRef.current = true;
    setSaving(true);
    setStatusError(false);
    try {
      await cancelAgenticReview(requestedReviewId);
      if (reviewIdRef.current !== requestedReviewId) return;
      setConfirmation(null);
      await refresh({ quiet: true });
      await reload({ quiet: true });
    } catch {
      if (reviewIdRef.current !== requestedReviewId) return;
      setConfirmation(null);
      const statusReconciled = await refresh({ quiet: true });
      await reload({ quiet: true });
      if (reviewIdRef.current === requestedReviewId && !statusReconciled) setStatusError(true);
    } finally {
      if (reviewIdRef.current === requestedReviewId) {
        actionPendingRef.current = false;
        setSaving(false);
      }
    }
  }
  async function checkRecoveryStatus() {
    const requestedReviewId = reviewId;
    actionPendingRef.current = true;
    setSaving(true);
    setStatusError(false);
    try {
      const next = await recoverAgenticReview(requestedReviewId);
      if (reviewIdRef.current !== requestedReviewId) return;
      statusRequestGeneration.current += 1;
      setOperation(next);
      await reload({ quiet: true });
    } catch {
      if (reviewIdRef.current === requestedReviewId) setStatusError(true);
    } finally {
      if (reviewIdRef.current === requestedReviewId) {
        actionPendingRef.current = false;
        setSaving(false);
      }
    }
  }

  if (loading && !operation) return <div className="screen"><StatePanel title={t('review.state.loadingTitle', 'Loading review')} text={t('review.state.loadingText', 'Reading the latest status.')} /></div>;
  if (!operation) return <div className="screen"><BackButton onClick={() => navigate({ page: 'confirm', view: 'list' })} t={t} /><StatePanel tone="danger" title={t('review.state.failedTitle', 'The review could not be loaded')} text={t('review.state.failedText', 'Try again in a moment.')} action={<button className="primary-action" type="button" onClick={() => refresh()}>{t('common.retry', 'Try again')}</button>} /></div>;

  return (
    <div className="screen" data-testid="tc-cc-review-workspace">
      <BackButton onClick={() => navigate({ page: 'confirm', view: 'list' })} t={t} />
      <PageHeading eyebrow={t('work.eyebrow', 'Review')} title={reviewTitle(operation)} />
      <WorkflowSteps state={state} hasFindings={findings.length > 0} allDecided={allDecided} t={t} />
      {statusError ? <InlineNotice tone="warning" title={needsAiRefresh ? t('review.ai.choiceChangedTitle', 'The AI choice changed') : t('status.updateFailed', 'The latest status could not be read')} text={needsAiRefresh ? t('review.ai.repeatNeedsCurrent', 'Nothing was sent. Update AI availability, then try again with the current choice.') : t('status.updateFailedText', 'The information already shown is still available. Try refreshing.')} action={needsAiRefresh ? <button className="link-action" type="button" onClick={() => navigate({ page: 'settings', view: 'settings' })}>{t('review.ai.openSettings', 'Open AI settings')}</button> : <button className="link-action" type="button" onClick={() => refresh({ quiet: true })}>{t('app.refresh', 'Refresh')}</button>} /> : null}
      {state === 'confirmation_required' ? <StatePanel title={t('confirmationReady.title', 'The review is ready to start')} text={t('confirmationReady.text', 'Check what will be sent before starting the review.')} action={<div className="button-row"><button className="secondary-action" type="button" disabled={saving} onClick={cancelBeforeSend}>{t('review.action.cancelBeforeSend', 'Do not continue')}</button><button ref={startButtonRef} className="primary-action" type="button" disabled={saving} onClick={requestStartConfirmation}>{t('confirmationReady.action', 'Review and start')}</button></div>} /> : null}
      {state === 'preparing' && operation.recovery?.available ? <StatePanel tone="warning" title={t('recovery.preparingTitle', 'Preparation was interrupted')} text={t('recovery.preparingText', 'Your review details are saved. Resume the local preparation when you are ready.')} action={<button className="primary-action" type="button" disabled={saving} onClick={resumePreparation}>{t('recovery.resume', 'Resume preparation')}</button>} /> : null}
      {state === 'dispatch_unknown' ? <UnknownDispatch onRefresh={checkRecoveryStatus} t={t} /> : null}
      {state === 'needs_attention' ? <StatePanel tone="warning" title={t('review.ai.choiceChangedTitle', 'The AI choice changed')} text={t('review.ai.choiceChangedText', 'Nothing was sent. Update AI availability, then prepare this review again.')} action={<div className="button-row"><button className="secondary-action" type="button" onClick={() => navigate({ page: 'settings', view: 'settings' })}>{t('review.ai.openSettings', 'Open AI settings')}</button><button className="primary-action" type="button" disabled={saving} onClick={() => repeat('recheck')}>{t('review.ai.prepareAgain', 'Prepare again')}</button></div>} /> : null}
      {state === 'cancelled' ? <StatePanel title={t('recovery.cancelledTitle', 'This review was not sent')} text={t('recovery.cancelledText', 'Nothing was sent to the AI service. You can start a new review at any time.')} /> : null}
      {isFailed(state) ? <FailedReview onRepeat={() => repeat('recheck')} busy={saving} t={t} /> : null}
      {isActive(state) && !(state === 'preparing' && operation.recovery?.available) ? <ProgressView operation={operation} onCheckStatus={checkRecoveryStatus} checking={saving} t={t} /> : null}
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
      <SendConfirmationDialog open={Boolean(confirmation)} confirmation={confirmation} busy={saving} returnFocusRef={startButtonRef} onCancel={cancelBeforeSend} onConfirm={resumeStart} t={t} />
    </div>
  );
}

function ProgressView({ operation, onCheckStatus = null, checking = false, t }) {
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
        {steps.length ? <ol className="operation-steps">{steps.map((step) => <li className={step.done ? 'done' : step.current ? 'current' : ''} key={step.id} aria-current={step.current ? 'step' : undefined}><span aria-hidden="true">{step.done ? '✓' : '•'}</span>{step.label}</li>)}</ol> : null}
        {onCheckStatus ? <button className="secondary-action progress-status-action" type="button" disabled={checking} onClick={onCheckStatus}>{t('dispatchUnknown.action', 'Check status')}</button> : null}
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
            {decisions[item.id] ? <span className="decision-check" aria-label={t('results.decided', 'Decided')}>✓</span> : <DirectionalSymbol symbol="›" />}
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
          <button className={decision === 'fix' ? 'selected' : ''} type="button" aria-pressed={decision === 'fix'} onClick={() => onDecide('fix')}><span aria-hidden="true">✓</span><span><strong>{t('decision.fix', 'Fix this')}</strong><small>{t('decision.fixHint', 'Keep it in the next work list')}</small></span></button>
          <button className={decision === 'later' ? 'selected' : ''} type="button" aria-pressed={decision === 'later'} onClick={() => onDecide('later')}><span aria-hidden="true">◷</span><span><strong>{t('decision.later', 'Decide later')}</strong><small>{t('decision.laterHint', 'Keep it without committing yet')}</small></span></button>
          <button className={decision === 'ask' ? 'selected' : ''} type="button" aria-pressed={decision === 'ask'} onClick={() => onDecide('ask')}><span aria-hidden="true">?</span><span><strong>{t('decision.ask', 'Ask someone')}</strong><small>{t('decision.askHint', 'Mark it for a conversation')}</small></span></button>
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
  const initialAiConnections = dashboard?.ai_connections ?? { status: 'not_checked', connections: [], selection: null, storage_revision: 0 };
  const [form, setForm] = useState(() => ({ locale, ...defaults }));
  const [aiConnections, setAiConnections] = useState(initialAiConnections);
  const [aiDraft, setAiDraft] = useState(() => readAiSelection(initialAiConnections));
  const [aiEditorOpen, setAiEditorOpen] = useState(false);
  const [aiSetupOpen, setAiSetupOpen] = useState(false);
  const [aiActionState, setAiActionState] = useState('idle');
  const [aiErrorMessage, setAiErrorMessage] = useState(null);
  const [state, setState] = useState('idle');
  const [settingsErrorMessage, setSettingsErrorMessage] = useState(null);
  const aiRequestGeneration = useRef(0);
  const aiSetupButtonRef = useRef(null);
  const saveButtonRef = useRef(null);
  const aiDraftDirty = Boolean(aiDraft) && !sameAiSelection(aiDraft, aiConnections.selection);
  const aiDraftDirtyRef = useRef(aiDraftDirty);
  aiDraftDirtyRef.current = aiDraftDirty;
  const aiVersionRef = useRef(aiProjectionVersion(initialAiConnections));
  const aiBusy = aiActionState === 'refreshing' || aiActionState === 'saving' || aiActionState === 'loading';
  const selectedAi = describeAiSelection(aiConnections, aiDraft);
  const showAiEditor = aiConnections.status === 'available'
    && Boolean(aiConnections.connections?.length)
    && (aiEditorOpen || !selectedAi);
  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setState('idle');
    setSettingsErrorMessage(null);
  }
  useEffect(() => {
    const next = dashboard?.ai_connections ?? initialAiConnections;
    const versionChanged = aiVersionRef.current !== aiProjectionVersion(next);
    if (!aiDraftDirtyRef.current) {
      setAiConnections(next);
      setAiDraft(readAiSelection(next));
      aiVersionRef.current = aiProjectionVersion(next);
    } else if (versionChanged) {
      setAiActionState('conflict');
      setAiErrorMessage(t('settings.aiChangedWhileEditing', 'AI availability changed while you were choosing. Load the latest choices before applying.'));
    }
  }, [dashboard?.ai_connections?.capability_token, dashboard?.ai_connections?.settings_revision, dashboard?.ai_connections?.storage_revision, t]);
  function changeAiDraft(value) {
    setAiDraft(value);
    if (aiActionState !== 'conflict') {
      setAiActionState('idle');
      setAiErrorMessage(null);
    }
  }
  async function refreshAvailability() {
    const generation = ++aiRequestGeneration.current;
    const previousRevision = aiConnections.storage_revision ?? 0;
    const previousCapabilityRevision = aiConnections.revision ?? 0;
    const previousCapabilityToken = aiConnections.capability_token ?? null;
    setAiActionState('refreshing');
    setAiErrorMessage(null);
    try {
      const next = await refreshAiConnections({
        confirm: 'refresh-ai-availability',
        expected_revision: aiConnections.storage_revision ?? 0
      });
      if (generation !== aiRequestGeneration.current) return;
      setAiConnections(next);
      setAiDraft(readAiSelection(next));
      aiVersionRef.current = aiProjectionVersion(next);
      setAiEditorOpen(next.selection === null);
      setAiActionState('ready');
      await reload({ quiet: true });
    } catch (caught) {
      if (generation !== aiRequestGeneration.current) return;
      if (!caught?.envelope) {
        const latestDashboard = await reload({ quiet: true }).catch(() => null);
        if (generation !== aiRequestGeneration.current) return;
        const latest = latestDashboard?.ai_connections;
        if (Number.isSafeInteger(latest?.storage_revision)
          && latest.storage_revision > previousRevision
          && Number.isSafeInteger(latest.revision)
          && latest.revision > previousCapabilityRevision
          && latest.capability_token !== previousCapabilityToken) {
          setAiConnections(latest);
          setAiDraft(readAiSelection(latest));
          aiVersionRef.current = aiProjectionVersion(latest);
          setAiEditorOpen(latest.selection === null);
          setAiActionState('ready');
          return;
        }
      }
      setAiActionState(apiErrorCode(caught) === 'CONTROL_CENTER_AI_CONNECTION_REVISION_CONFLICT' ? 'conflict' : 'error');
      setAiErrorMessage(uiErrorMessage(caught, t));
    }
  }
  async function applyAiSelection(selection = aiDraft) {
    if (!selection || !describeAiSelection(aiConnections, selection)) return;
    const generation = ++aiRequestGeneration.current;
    const previousRevision = aiConnections.storage_revision ?? 0;
    setAiActionState('saving');
    setAiErrorMessage(null);
    try {
      const next = await saveAiConnectionSelection({
        ...selection,
        capability_revision: aiConnections.revision,
        capability_token: aiConnections.capability_token,
        expected_revision: aiConnections.storage_revision,
        confirm: 'save-ai-selection'
      });
      if (generation !== aiRequestGeneration.current) return;
      setAiConnections(next);
      setAiDraft(readAiSelection(next));
      aiVersionRef.current = aiProjectionVersion(next);
      setAiActionState('saved');
      await reload({ quiet: true });
    } catch (caught) {
      if (generation !== aiRequestGeneration.current) return;
      if (!caught?.envelope) {
        const latestDashboard = await reload({ quiet: true }).catch(() => null);
        if (generation !== aiRequestGeneration.current) return;
        const latest = latestDashboard?.ai_connections;
        if (Number.isSafeInteger(latest?.storage_revision)
          && latest.storage_revision > previousRevision
          && sameAiSelection(latest.selection, selection)) {
          setAiConnections(latest);
          setAiDraft(readAiSelection(latest));
          aiVersionRef.current = aiProjectionVersion(latest);
          setAiActionState('saved');
          return;
        }
      }
      setAiActionState(apiErrorCode(caught) === 'CONTROL_CENTER_AI_CONNECTION_REVISION_CONFLICT' ? 'conflict' : 'error');
      setAiErrorMessage(uiErrorMessage(caught, t));
    }
  }
  async function loadLatestAiSettings() {
    const generation = ++aiRequestGeneration.current;
    setAiActionState('loading');
    try {
      const nextDashboard = await reload({ quiet: true });
      if (generation !== aiRequestGeneration.current) return;
      const next = nextDashboard?.ai_connections;
      if (!next) throw new Error('AI settings unavailable');
      setAiConnections(next);
      setAiDraft(readAiSelection(next));
      aiVersionRef.current = aiProjectionVersion(next);
      setAiErrorMessage(null);
      setAiActionState('idle');
    } catch (caught) {
      if (generation !== aiRequestGeneration.current) return;
      setAiActionState('error');
      setAiErrorMessage(uiErrorMessage(caught, t));
    }
  }
  async function save(event) {
    event.preventDefault();
    setState('saving');
    setSettingsErrorMessage(null);
    try {
      await setControlCenterPreferences({
        locale: form.locale,
        playwright_mode: form.playwrightMode,
        default_viewport: form.defaultViewport,
        ai_suggestions_enabled: form.aiSuggestions,
        confirm: 'save-control-center-settings'
      });
      await reload({ quiet: true });
      setLocale(form.locale);
      setState('saved');
    } catch (caught) {
      if (!caught?.envelope) {
        const latest = await reload({ quiet: true }).catch(() => null);
        const latestPreferences = readPreferences(latest);
        if (latest?.settings?.display_language?.current_locale === form.locale
          && latestPreferences.defaultViewport === form.defaultViewport
          && latestPreferences.playwrightMode === form.playwrightMode
          && latestPreferences.aiSuggestions === form.aiSuggestions) {
          setLocale(form.locale);
          setState('saved');
          return;
        }
      }
      setSettingsErrorMessage(uiErrorMessage(caught, t));
      setState('error');
    }
  }
  return (
    <div className="screen narrow-screen" data-testid="tc-cc-settings">
      <PageHeading title={t('settings.title', 'Settings')} />
      <form className="settings-form" onSubmit={save}>
        <section className="settings-group" aria-labelledby="everyday-settings-title">
          <h2 id="everyday-settings-title">{t('settings.everydayTitle', 'Everyday use')}</h2>
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
        </section>
        <section className="settings-group" aria-labelledby="ai-settings-title">
          <h2 id="ai-settings-title">{t('settings.aiPrivacyTitle', 'AI and privacy')}</h2>
          <SettingRow title={t('settings.aiSuggestions', 'AI suggestions')} text={t('settings.aiSuggestionsHint', 'Organize improvements in clear language when an AI service is ready.')}>
            <Toggle checked={form.aiSuggestions} onChange={(checked) => update('aiSuggestions', checked)} label={t('settings.aiSuggestions', 'AI suggestions')} />
          </SettingRow>
          <SettingRow title={t('settings.aiService', 'AI service')} text={aiSetupGuidance(aiConnections, t)} topAligned>
            <div className="ai-connection-setting" aria-busy={aiBusy}>
              <div className="ai-connection-summary">
                <span className={`ai-status ${aiConnections.status}`} aria-live="polite">{aiConnectionStatusLabel(aiConnections, t)}</span>
                {selectedAi ? <span className="ai-connection-name"><strong>{selectedAi.connection.name}</strong><small>{selectedAi.model.name}</small></span> : null}
              </div>
              <div className="compact-actions">
                {selectedAi && hasAlternativeAiSelection(aiConnections, aiDraft) ? <button className="link-action" type="button" onClick={() => setAiEditorOpen((value) => !value)} aria-expanded={aiEditorOpen}>{t('common.change', 'Change')}</button> : null}
                <button ref={aiSetupButtonRef} className={selectedAi ? 'secondary-action compact' : 'primary-action compact'} type="button" onClick={() => setAiSetupOpen(true)} disabled={aiBusy}>{selectedAi ? t('aiSetup.change', 'Change connection') : t('aiSetup.open', 'Set up AI')}</button>
                <button className="secondary-action compact" type="button" onClick={refreshAvailability} disabled={aiBusy || aiDraftDirty}>{aiActionState === 'refreshing' ? t('settings.aiRefreshing', 'Updating...') : t('settings.aiRefresh', 'Update availability')}</button>
              </div>
              {showAiEditor ? <AiConnectionEditor aiConnections={aiConnections} value={aiDraft} onChange={changeAiDraft} t={t} disabled={aiBusy} /> : null}
              {showAiEditor && !selectedAi && firstAvailableAiSelection(aiConnections) ? <button className="primary-action compact" type="button" disabled={aiBusy} onClick={() => applyAiSelection(firstAvailableAiSelection(aiConnections))}>{aiActionState === 'saving' ? t('settings.aiSaving', 'Applying...') : t('settings.aiApply', 'Use this AI')}</button> : null}
              {aiDraftDirty ? <button className="primary-action compact" type="button" disabled={aiBusy || aiActionState === 'conflict' || !describeAiSelection(aiConnections, aiDraft)} onClick={() => applyAiSelection()}>{aiActionState === 'saving' ? t('settings.aiSaving', 'Applying...') : t('settings.aiApply', 'Use this AI')}</button> : null}
              {aiActionState === 'saved' ? <p className="ai-action-status" role="status">{t('settings.aiSaved', 'AI choice updated.')}</p> : null}
              {aiErrorMessage ? <InlineNotice tone="warning" title={t('settings.aiUpdateFailed', 'AI settings could not be updated')} text={aiErrorMessage} action={aiActionState === 'conflict' || aiActionState === 'loading' ? <button className="link-action" type="button" onClick={loadLatestAiSettings} disabled={aiBusy}>{t('settings.aiLoadLatest', 'Load latest choices')}</button> : <button className="link-action" type="button" onClick={refreshAvailability} disabled={aiBusy || aiDraftDirty}>{t('common.retry', 'Try again')}</button>} /> : null}
            </div>
          </SettingRow>
          <SettingRow title={t('settings.sendConfirmation', 'Confirm before sending')} text={t('settings.sendConfirmationHint', 'Always show what will be sent before a review starts.')}>
            <span className="locked-note"><span aria-hidden="true">✓</span>{t('settings.alwaysConfirm', 'Always confirm')}</span>
          </SettingRow>
        </section>
        {state === 'saved' ? <InlineNotice tone="success" title={t('settings.saved', 'Settings saved')} /> : null}
        {state === 'error' ? <InlineNotice tone="danger" title={t('settings.saveFailed', 'Settings could not be saved')} text={settingsErrorMessage} /> : null}
        <div className="form-actions"><button ref={saveButtonRef} className="primary-action" type="submit" disabled={state === 'saving'}>{state === 'saving' ? t('settings.saving', 'Saving...') : t('settings.saveAll', 'Save settings')}</button></div>
      </form>
      <AiSetupDialog
        open={aiSetupOpen}
        aiSetup={dashboard?.ai_setup}
        aiConnections={aiConnections}
        returnFocusRef={aiSetupButtonRef}
        fallbackFocusRef={saveButtonRef}
        onClose={() => setAiSetupOpen(false)}
        onComplete={async () => {
          const nextDashboard = await reload({ quiet: true });
          const next = nextDashboard?.ai_connections;
          if (next) {
            setAiConnections(next);
            setAiDraft(readAiSelection(next));
            aiVersionRef.current = aiProjectionVersion(next);
          }
          return nextDashboard;
        }}
        t={t}
      />
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
  return <button className="back-action" type="button" onClick={onClick}><DirectionalSymbol symbol="←" />{t('common.back', 'Back')}</button>;
}

function DirectionalSymbol({ symbol }) {
  return <span className="directional-symbol" aria-hidden="true">{symbol}</span>;
}

function Metric({ label, value }) {
  return <div className="metric"><strong>{value}</strong><span>{label}</span></div>;
}

function ReviewList({ items, onOpen, t }) {
  return <ul className="review-list">{items.map((item) => <li key={item.id}><button type="button" onClick={() => onOpen(item.id)}><span className={`status-dot ${stateTone(item.state)}`} aria-hidden="true" /><span className="review-list-copy"><strong>{item.title}</strong><small>{item.description}</small></span><StatusBadge state={item.state} t={t} /><DirectionalSymbol symbol="›" /></button></li>)}</ul>;
}

function StatusBadge({ state, t }) {
  const label = state === 'dispatch_unknown'
    ? t('status.checking', 'Checking status')
    : state === 'cancelled'
      ? t('status.notSent', 'Not sent')
    : isActive(state)
      ? t('running.title', 'In progress')
      : isComplete(state)
        ? t('review.state.completeTitle', 'Complete')
        : state === 'evidence_missing'
          ? t('status.noEvidence', 'No result')
          : ATTENTION_STATES.has(state) || isFailed(state)
            ? t('status.needsHelp', 'Needs attention')
            : PREPARED_STATES.has(state)
              ? t('status.prepared', 'Prepared')
              : t('status.ready', 'Ready');
  return <span className={`status-badge ${stateTone(state)}`}>{label}</span>;
}

function WorkflowSteps({ state, hasFindings, allDecided, t }) {
  let current = 0;
  if (isActive(state) || state === 'dispatch_unknown') current = 1;
  if (isComplete(state) && hasFindings) current = allDecided ? 3 : 2;
  if (isComplete(state) && !hasFindings) current = 4;
  return <ol className="workflow-steps" aria-label={t('aria.workflowProgress', 'Review progress')}>{WORKFLOW_STAGES.map((stage, index) => <li className={index < current ? 'done' : index === current ? 'current' : ''} key={stage.id} aria-current={index === current ? 'step' : undefined}><span>{index < current ? '✓' : index + 1}</span><small>{t(stage.labelKey, stage.fallback)}</small></li>)}</ol>;
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

function SettingRow({ title, text, children, topAligned = false }) {
  return <div className={`setting-row${topAligned ? ' top-aligned' : ''}`}><div><h2>{title}</h2><p>{text}</p></div><div className="setting-control">{children}</div></div>;
}

function Toggle({ checked, disabled = false, onChange = () => {}, label }) {
  return <label className={`toggle${disabled ? ' locked' : ''}`}><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span aria-hidden="true" /><span className="sr-only">{label}</span></label>;
}

function dashboardReviewIds(dashboard) {
  return dashboardReviewItems(dashboard)
    .map((item) => readReviewId(item))
    .filter(Boolean);
}

function findNewRepeatedReview(dashboard, pending) {
  const baseline = new Set(Array.isArray(pending?.baselineReviewIds) ? pending.baselineReviewIds : []);
  const matches = dashboardReviewItems(dashboard).filter((item) => {
    const id = readReviewId(item);
    return Boolean(id)
      && !baseline.has(id)
      && item.parent_review?.id === pending?.reviewId
      && item.parent_review?.repeat_mode === pending?.kind;
  });
  return matches.length === 1 ? matches[0] : null;
}

function dashboardReviewItems(dashboard) {
  return Array.isArray(dashboard?.agentic_review?.items) ? dashboard.agentic_review.items : [];
}

function normalizeItems(value, t) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const state = readState(item);
    const findings = normalizeFindings(item);
    const remaining = findings.filter((finding) => !finding.decision).length;
    return {
      ...item,
      id: readReviewId(item) ?? `review-${index}`,
      state,
      title: reviewTitle(item, t),
      description: item.purpose ?? item.summary ?? stateDescription(state, t),
      remaining
    };
  });
}

function normalizeIntakeItems(value, t) {
  if (!Array.isArray(value)) return [];
  return value.map((result) => ({
    id: result.id,
    state: intakeResultState(result),
    title: intakeKindLabel(result.source_kind, t),
    description: result.review_goal ?? intakeOutcomeLabel(result.outcome, t),
    remaining: 0,
    intake_result: true,
    completed_at: result.completed_at
  }));
}

function normalizeMediaReviewItems(value, t) {
  if (!Array.isArray(value)) return [];
  return value.map((operation) => {
    const state = readState(operation);
    return {
      ...operation,
      id: `media-${operation.operation_id}`,
      state,
      title: t('media.result.title', 'Video review'),
      description: activeMediaDescription(operation, t),
      remaining: 0,
      media_review: true,
      operation_id: operation.operation_id,
      created_at: operation.created_at,
      updated_at: operation.updated_at
    };
  });
}

function createMediaOperationId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function activeMediaDescription(operation, t) {
  if (operation?.result_available) return t('media.list.resultReady', 'Time-coded video findings are ready.');
  if (isActive(readState(operation))) return mediaProgressLabel(operation?.progress?.phase, t);
  if (readState(operation) === 'cancelled') return t('media.result.cancelled', 'The video review was stopped');
  if (isFailed(readState(operation))) return t('media.result.failed', 'The video review did not finish');
  return stateDescription(readState(operation), t);
}

function mediaCapabilityLabel(value, t) {
  if (value === 'playback_inspection') return t('media.capability.playback', 'Official-player playback inspection');
  if (value === 'full_media_analysis') return t('media.capability.full', 'Full local media analysis');
  if (value === 'metadata_only') return t('media.capability.metadata', 'Source information only');
  return t('media.capability.unsupported', 'Unsupported');
}

function mediaProgressLabel(value, t) {
  const labels = {
    queued: t('media.progress.queued', 'Waiting to start'),
    preparing: t('media.progress.preparing', 'Preparing private workspace'),
    staging: t('media.progress.staging', 'Preparing the local video'),
    analyzing: t('media.progress.analyzing', 'Analyzing video and speech'),
    integrating: t('media.progress.integrating', 'Matching evidence by timecode'),
    cancelling: t('media.progress.cancelling', 'Stopping safely')
  };
  return labels[value] ?? t('media.progress.running', 'Reviewing the video');
}

function mediaReadinessNotice(readiness, t) {
  if (readiness?.status === 'uninspected') {
    return {
      title: t('media.check.title', 'Check local video review setup'),
      text: t('media.check.text', 'Run a private readiness check before choosing a video. Nothing will be installed or downloaded.')
    };
  }
  if (readiness?.status === 'unsupported') {
    return {
      title: t('media.unsupported.title', 'The configured transcription method is not supported'),
      text: t('media.unsupported.text', 'Choose a supported local transcription configuration, then check again. TraceCue will not install, download, or use a fallback automatically.')
    };
  }
  return {
    title: t('media.unavailable.title', 'Full video review is not ready'),
    text: t('media.unavailable.text', 'Check local transcription and FFmpeg readiness. TraceCue will not install or download anything automatically.')
  };
}

function mediaSeverityTone(value) {
  if (['critical', 'high'].includes(value)) return 'danger';
  if (value === 'medium') return 'warning';
  return 'success';
}

function humanizeMediaToken(value) {
  const normalized = String(value ?? '').replaceAll('_', ' ').trim();
  return normalized ? `${normalized[0].toUpperCase()}${normalized.slice(1)}` : '—';
}

function formatConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(Math.max(0, Math.min(1, number)) * 100)}%` : '—';
}

function intakeResultState(result) {
  if (result?.source_kind !== 'playwright_result') return 'prepared';
  const summary = result?.summary ?? {};
  const status = String(summary.status ?? '').toLowerCase();
  if (safeCount(summary.failed) > 0 || safeCount(summary.timed_out) > 0 || ['failed', 'blocked', 'stale', 'error'].includes(status)) {
    return 'needs_attention';
  }
  if (safeCount(summary.total) === 0
    || safeCount(summary.passed) + safeCount(summary.failed) + safeCount(summary.timed_out) === 0
    || ['empty', 'evidence_missing'].includes(status)) return 'evidence_missing';
  return 'evidence_ready';
}

function sortItemsByRecency(items) {
  return items.sort((left, right) => itemTimestamp(right) - itemTimestamp(left));
}

function itemTimestamp(item) {
  for (const value of [item?.updated_at, item?.completed_at, item?.created_at, item?.started_at]) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
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
    storage: source.storage_label ?? source.retention_label ?? '',
    model: source.model_name ?? '',
    processingLevel: source.processing_level_name ?? '',
    reviewMethod: source.review_method ?? ''
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

function createRepeatIdempotencyKey() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
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

function intakeKindLabel(kind, t) {
  if (kind === 'image') return t('review.source.image', 'Image');
  if (kind === 'document_text') return t('review.source.document', 'Document');
  if (kind === 'playwright_result') return t('review.source.testResult', 'Test result');
  return t('intake.result.savedTitle', 'Confirmation result');
}

function intakeOutcomeLabel(outcome, t) {
  if (outcome === 'image_evidence_ready') return t('intake.result.imageTitle', 'Image evidence is ready');
  if (outcome === 'review_proposal_ready') return t('intake.result.documentTitle', 'The review proposal is ready');
  if (outcome === 'test_evidence_ready') return t('intake.result.testTitle', 'The test result is organized');
  return t('intake.ready', 'Review preparation is ready');
}

function formatCompletedAt(value, locale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }
}

function formatNumber(value, locale) {
  const number = safeCount(value);
  try { return new Intl.NumberFormat(locale).format(number); }
  catch { return String(number); }
}

function safeCount(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function formatCopy(template, values) {
  return Object.entries(values).reduce(
    (copy, [key, value]) => copy.split(`{${key}}`).join(String(value)),
    template
  );
}

function uiErrorMessage(error, t) {
  const message = typeof error?.message === 'string'
    ? error.message.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
    : '';
  if (message && message.length <= 240 && !/^(?:Missing\b|AI choice required|Review preparation)/u.test(message)) {
    return message;
  }
  return t('action.genericError', 'Check the information and try again.');
}

function apiErrorCode(error) {
  return error?.envelope?.errors?.[0]?.code
    ?? error?.envelope?.error?.code
    ?? null;
}

function controlCenterLoadError(error) {
  if (error?.controlCenterReopenRequired === true) return 'session';
  return [
    'CONTROL_CENTER_PAIRING_REQUIRED',
    'CONTROL_CENTER_PAIRING_REJECTED',
    'CONTROL_CENTER_PAIRING_DISABLED',
    'CONTROL_CENTER_PAIRING_TOKEN_EXPIRED',
    'CONTROL_CENTER_PAIRING_TOKEN_REJECTED',
    'CONTROL_CENTER_SESSION_CAPACITY_REACHED',
    'CONTROL_CENTER_SESSION_REQUIRED',
    'CONTROL_CENTER_SESSION_REJECTED'
  ].includes(apiErrorCode(error)) ? 'session' : 'load';
}

function requiresAiProjectionRefresh(code) {
  return new Set([
    'CONTROL_CENTER_AI_CONNECTION_NOT_CHECKED',
    'CONTROL_CENTER_AI_CONNECTION_STALE',
    'CONTROL_CENTER_AI_SELECTION_INCOMPLETE',
    'CONTROL_CENTER_AI_CONNECTION_REVISION_CHANGED',
    'CONTROL_CENTER_AI_CONNECTION_UNAVAILABLE',
    'CONTROL_CENTER_AI_MODEL_UNAVAILABLE',
    'CONTROL_CENTER_AI_EFFORT_UNAVAILABLE'
  ]).has(code);
}

function sameIntakeRetryAvailable(error) {
  if (!error?.envelope) return true;
  return error.envelope?.errors?.[0]?.details?.same_intake_retry_available === true;
}

function readLocale(dashboard) { return dashboard?.settings?.display_language?.current_locale ?? dashboard?.settings?.control_center?.locale ?? 'en'; }
function readReviewId(value) { return value?.review_id ?? value?.id ?? value?.operation?.review_id ?? value?.operation?.id ?? null; }
function readState(value) { return String(value?.state ?? value?.status ?? value?.operation?.state ?? 'ready').toLowerCase(); }
function readPercent(value) { const number = Number(value?.progress?.percent ?? value?.progress_percent); return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null; }
function readCurrentStep(value) { return value?.progress?.current_label ?? value?.progress?.current_step_label ?? value?.current_step_label ?? ''; }
function isActive(state) { return ACTIVE_STATES.has(state); }
function isComplete(state) { return COMPLETE_STATES.has(state); }
function isFailed(state) { return FAILED_STATES.has(state); }
function stateTone(state) {
  if (state === 'dispatch_unknown' || state === 'evidence_missing') return 'warning';
  if (isActive(state)) return 'active';
  if (isComplete(state) || PREPARED_STATES.has(state)) return 'success';
  if (isFailed(state) || state === 'needs_attention') return 'danger';
  return 'neutral';
}
function stateDescription(state, t) {
  if (isActive(state)) return t('running.title', 'In progress');
  if (isComplete(state)) return t('review.state.completeTitle', 'Review complete');
  if (state === 'cancelled') return t('status.notSent', 'Not sent');
  if (state === 'evidence_missing') return t('status.noEvidence', 'No result');
  if (isFailed(state) || state === 'needs_attention') return t('status.needsHelp', 'Needs attention');
  if (PREPARED_STATES.has(state)) return t('status.prepared', 'Prepared');
  if (state === 'dispatch_unknown') return t('status.checking', 'Checking status');
  return t('status.ready', 'Ready');
}
function nextActionTitle(item, t) {
  if (isActive(item.state) || item.state === 'dispatch_unknown') return t('next.running', 'Check the current review');
  if (item.remaining > 0) return t('next.decide', 'Decide what to do with the improvements');
  if (ATTENTION_STATES.has(item.state)) return t('next.attention', 'Check the result that needs attention');
  if (PREPARED_STATES.has(item.state)) return t('next.prepared', 'Open the prepared result');
  return t('next.review', 'View the latest result');
}

function reviewTitle(value, t) {
  if (value?.title || value?.target_label || value?.target) return value.title ?? value.target_label ?? value.target;
  const url = value?.url ?? value?.target_url ?? value?.operation?.target;
  if (url) {
    try { return new URL(url).hostname; } catch { return t('review.source.website', 'Website'); }
  }
  return t('review.source.website', 'Website');
}

function normalizeDecision(value) {
  const decision = typeof value === 'string' ? value : value?.decision;
  return ['fix', 'later', 'ask'].includes(decision) ? decision : null;
}

function decisionForFinding(decisions, findingId) {
  if (!Array.isArray(decisions)) return decisions?.[findingId];
  return decisions.find((decision) => decision?.finding_id === findingId)?.value;
}

async function waitUntilPrepared(reviewId, { signal } = {}) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    throwIfAborted(signal);
    const operation = await fetchAgenticReviewStatus(reviewId, { signal });
    const state = readState(operation);
    if (state === 'confirmation_required' || isComplete(state)) return operation;
    if (isFailed(state) || state === 'dispatch_unknown') throw new Error('Review preparation stopped');
    await abortableDelay(500, signal);
  }
  throw new Error('Review preparation timed out');
}

function beginPageAction(generationRef, abortRef) {
  abortRef.current?.abort();
  const controller = new AbortController();
  abortRef.current = controller;
  return { generation: ++generationRef.current, signal: controller.signal };
}

function isCurrentPageAction(generationRef, action) {
  return generationRef.current === action.generation && !action.signal.aborted;
}

function isCurrentReviewAction(generationRef, reviewIdRef, reviewId, action) {
  return reviewIdRef.current === reviewId && isCurrentPageAction(generationRef, action);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('The page action was cancelled.', 'AbortError');
}

function abortableDelay(delayMs, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(finish, delayMs);
    signal?.addEventListener('abort', cancel, { once: true });
    function finish() {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel() {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(signal.reason ?? new DOMException('The page action was cancelled.', 'AbortError'));
    }
  });
}
