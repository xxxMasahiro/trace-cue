import { useEffect, useMemo, useState } from 'react';
import {
  createSourceIntakeProposal,
  fetchDashboard,
  fetchPlaywrightTestCiArtifact,
  importPlaywrightTestResult,
  setDisplayLanguage,
  setPlaywrightTestMode
} from './apiClient.js';
import { designSystemMetadata, designSystemStyle } from './designSystem.js';
import { createTranslator } from './i18n.js';
import { PAGES } from './pageDefinitions.js';

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

export default function App() {
  const [dashboard, setDashboard] = useState(null);
  const [activePage, setActivePage] = useState('intake');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [locale, setLocale] = useState('en');
  const style = useMemo(() => designSystemStyle(), []);
  const translator = useMemo(() => createTranslator(locale), [locale]);
  const { t } = translator;

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

  return (
    <main className="app-shell" style={style} data-locale={locale}>
      <aside className="side-nav" aria-label="Primary">
        <div>
          <p className="eyebrow">{t('app.eyebrow', 'TraceCue')}</p>
          <h1>{t('app.title', 'Review center')}</h1>
        </div>
        <nav className="nav-list">
          {PAGES.map((page) => (
            <button
              key={page.id}
              type="button"
              className={activePage === page.id ? 'nav-item active' : 'nav-item'}
              onClick={() => setActivePage(page.id)}
            >
              {t(page.labelKey, page.fallback)}
            </button>
          ))}
        </nav>
        <TrustSafety dashboard={dashboard} t={t} />
      </aside>
      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="eyebrow">{t('app.statusEyebrow', 'Local status')}</p>
            <h2>{dashboard?.status_label ?? (loading ? t('app.loadingTitle', 'Loading local evidence') : t('app.unavailableTitle', 'Local evidence unavailable'))}</h2>
          </div>
          <button className="refresh-button" type="button" onClick={load} disabled={loading}>
            {t('app.refresh', 'Refresh')}
          </button>
        </header>
        {loading ? <StatePanel title="Loading" text="Reading local TraceCue status." /> : null}
        {error ? <StatePanel title="Cannot load status" text={error} tone="danger" /> : null}
        {!loading && !error && dashboard ? (
          <>
            {activePage === 'intake' ? <IntakePage dashboard={dashboard} t={t} /> : null}
            {activePage === 'review' ? <ReviewPage dashboard={dashboard} /> : null}
            {activePage === 'regression' ? <RegressionPage dashboard={dashboard} reload={load} t={t} /> : null}
            {activePage === 'evidence' ? <EvidencePage dashboard={dashboard} /> : null}
            {activePage === 'findings' ? <FindingsPage dashboard={dashboard} /> : null}
            {activePage === 'settings' ? <SettingsPage dashboard={dashboard} locale={locale} setLocale={setLocale} reload={load} t={t} /> : null}
            {activePage === 'advanced' ? <AdvancedPage dashboard={dashboard} /> : null}
          </>
        ) : null}
      </section>
    </main>
  );
}

function IntakePage({ dashboard, t }) {
  const intake = dashboard.source_intake ?? {};
  const [form, setForm] = useState(DEFAULT_INTAKE_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const efforts = intake.supported_efforts ?? ['standard', 'deep', 'xhigh'];
  const sourceTypes = intake.supported_source_types ?? ['video', 'web_page', 'pdf', 'meeting_notes', 'document', 'transcript', 'other'];

  async function submit(event) {
    event.preventDefault();
    setError(null);
    setResult(null);
    if (!form.local_write_confirmed) {
      setError('Confirm local proposal artifact creation before continuing.');
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
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  }

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="page-grid">
      <section className="panel">
        <div className="panel-header-inline">
          <div>
            <p className="eyebrow">Source Intake</p>
            <h3>{t('intake.title', 'Create proposal')}</h3>
          </div>
          <StatusBadge status={intake.status ?? 'available'} />
        </div>
        <p className="muted">{t('intake.caption', 'Start from a workspace source text file and create a local proposal. Planning and provider runs stay separate.')}</p>
        <form className="control-form" onSubmit={submit}>
          <label>
            {t('intake.sourceText', 'Source text file')}
            <input value={form.source_text_file} onChange={(event) => update('source_text_file', event.target.value)} placeholder="docs/source/transcript.txt" />
          </label>
          <div className="form-grid">
            <label>
              {t('intake.sourceType', 'Source type')}
              <select value={form.source_type} onChange={(event) => update('source_type', event.target.value)}>
                {sourceTypes.map((sourceType) => <option key={sourceType} value={sourceType}>{sourceType.replaceAll('_', ' ')}</option>)}
              </select>
            </label>
            <label>
              {t('intake.reviewEffort', 'Review depth')}
              <select value={form.review_effort} onChange={(event) => update('review_effort', event.target.value)}>
                {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </label>
          </div>
          <label>
            {t('intake.reviewBrief', 'Review goal')}
            <textarea value={form.review_brief} onChange={(event) => update('review_brief', event.target.value)} rows={4} />
          </label>
          <div className="form-grid">
            <label>
              {t('intake.targetAudience', 'Audience')} <span>{t('common.optional', 'optional')}</span>
              <input value={form.target_audience} onChange={(event) => update('target_audience', event.target.value)} />
            </label>
            <label>
              {t('intake.expectedImpression', 'Expected impression')} <span>{t('common.optional', 'optional')}</span>
              <input value={form.expected_impression} onChange={(event) => update('expected_impression', event.target.value)} />
            </label>
          </div>
          <div className="form-grid">
            <label>
              {t('intake.contentEvidence', 'Content evidence file')} <span>{t('common.optional', 'optional')}</span>
              <input value={form.content_evidence_file} onChange={(event) => update('content_evidence_file', event.target.value)} />
            </label>
            <label>
              {t('intake.reviewIndex', 'Review index file')} <span>{t('common.optional', 'optional')}</span>
              <input value={form.review_index_file} onChange={(event) => update('review_index_file', event.target.value)} />
            </label>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={form.local_write_confirmed} onChange={(event) => update('local_write_confirmed', event.target.checked)} />
            {t('intake.localWrite', 'Create a local proposal artifact')}
          </label>
          <button className="primary-action" type="submit" disabled={submitting}>
            {submitting ? 'Creating...' : t('intake.submit', 'Create proposal')}
          </button>
        </form>
        {error ? <StatePanel title="Cannot create proposal" text={error} tone="danger" /> : null}
      </section>
      {result ? <SourceIntakeResult result={result} t={t} /> : null}
    </div>
  );
}

function SourceIntakeResult({ result, t }) {
  return (
    <section className="panel primary-panel">
      <p className="eyebrow">Result</p>
      <h3>{t('intake.ready', 'Proposal ready')}</h3>
      <div className="metric-row">
        <Metric label="Characters" value={result.source_text?.char_count ?? 0} />
        <Metric label="Chunks" value={result.source_text?.chunk_count ?? 0} />
        <Metric label="Artifacts" value={result.artifact_summary?.artifact_count ?? 0} />
      </div>
      <dl className="definition-list">
        <div><dt>Source</dt><dd>{result.resolved_source_type ?? result.requested_source_type}</dd></div>
        <div><dt>Depth</dt><dd>{result.review_effort}</dd></div>
        <div><dt>{t('intake.next', 'Next safe step')}</dt><dd>{result.next_safe_action}</dd></div>
      </dl>
    </section>
  );
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
            <h3>{t('settings.languageTitle', 'Display language')}</h3>
          </div>
          <StatusBadge status={language.status ?? 'configured'} />
        </div>
        <p className="muted">{t('settings.languageCaption', 'This changes Control Center chrome only. It does not translate source evidence or generated review text.')}</p>
        <form className="control-form compact" onSubmit={submit}>
          <label>
            {t('settings.language', 'Control Center language')}
            <select value={selectedLocale} onChange={(event) => {
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
        <h3>Language state</h3>
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
          <h3>{t('settings.playwrightTitle', 'Playwright Test mode')}</h3>
        </div>
        <StatusBadge status={settings.status ?? 'configured'} />
      </div>
      <p className="muted">{t('settings.playwrightCaption', 'This only changes how Control Center may use Playwright Test evidence. Saving does not run a browser or contact CI.')}</p>
      <form className="control-form compact" onSubmit={submit}>
        <label>
          {t('settings.playwrightTitle', 'Playwright Test mode')}
          <select value={selectedMode} onChange={(event) => setSelectedMode(event.target.value)}>
            {modes.map((mode) => <option key={mode} value={mode}>{labels[mode] ?? mode}</option>)}
          </select>
        </label>
        <button className="primary-action" type="submit" disabled={saving}>
          {saving ? 'Saving...' : t('settings.playwrightSave', 'Save mode')}
        </button>
      </form>
      {status ? <StatePanel title="Mode saved" text={status} /> : null}
      {error ? <StatePanel title="Cannot save mode" text={error} tone="danger" /> : null}
    </section>
  );
}

function RegressionPage({ dashboard, reload, t }) {
  const regression = dashboard.regression?.playwright_test ?? {};
  const [importForm, setImportForm] = useState(DEFAULT_PLAYWRIGHT_IMPORT_FORM);
  const [ciForm, setCiForm] = useState(DEFAULT_PLAYWRIGHT_CI_FORM);
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  function updateImport(key, value) {
    setImportForm((current) => ({ ...current, [key]: value }));
  }

  function updateCi(key, value) {
    setCiForm((current) => ({ ...current, [key]: value }));
  }

  async function submitImport(event) {
    event.preventDefault();
    setError(null);
    setResult(null);
    if (!importForm.local_write_confirmed) {
      setError('Confirm local Playwright Test result import before continuing.');
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
      setError('Confirm CI artifact fetch before continuing.');
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

  return (
    <div className="page-grid">
      <section className="panel primary-panel">
        <p className="eyebrow">{t('regression.title', 'Regression checks')}</p>
        <h3>{regression.status_label ?? 'No Playwright Test result imported.'}</h3>
        <p>{t('regression.caption', 'Import existing Playwright Test results or fetch a finished CI artifact. Local test execution stays CLI-only.')}</p>
        <div className="metric-row">
          <Metric label="Mode" value={regression.labels?.[regression.selected_mode] ?? regression.selected_mode ?? 'disabled'} />
          <Metric label="Total" value={regression.last_result?.total_count ?? 0} />
          <Metric label="Failed" value={regression.last_result?.failed_count ?? 0} />
        </div>
      </section>
      <section className="panel">
        <div className="panel-header-inline">
          <div>
            <p className="eyebrow">Playwright Test</p>
            <h3>{t('regression.importTitle', 'Import result')}</h3>
          </div>
          <StatusBadge status={regression.selected_mode === 'disabled' ? 'disabled' : 'available'} />
        </div>
        <form className="control-form compact" onSubmit={submitImport}>
          <label>
            {t('regression.resultFile', 'Result file')}
            <input value={importForm.input} onChange={(event) => updateImport('input', event.target.value)} placeholder="test-results/results.json" />
          </label>
          <label className="check-row">
            <input type="checkbox" checked={importForm.local_write_confirmed} onChange={(event) => updateImport('local_write_confirmed', event.target.checked)} />
            Import this local result into TraceCue
          </label>
          <button className="primary-action" type="submit" disabled={busy === 'import'}>
            {busy === 'import' ? 'Importing...' : t('regression.importSubmit', 'Import result')}
          </button>
        </form>
      </section>
      <section className="panel">
        <div className="panel-header-inline">
          <div>
            <p className="eyebrow">GitHub Actions</p>
            <h3>{t('regression.ciTitle', 'Fetch CI artifact')}</h3>
          </div>
          <StatusBadge status={regression.selected_mode === 'external_ci' ? 'available' : 'optional'} />
        </div>
        <form className="control-form compact" onSubmit={submitCi}>
          <label>
            {t('regression.repo', 'Repository')}
            <input value={ciForm.repo} onChange={(event) => updateCi('repo', event.target.value)} placeholder="owner/repo" />
          </label>
          <div className="form-grid">
            <label>
              {t('regression.runId', 'Run ID')}
              <input value={ciForm.run_id} onChange={(event) => updateCi('run_id', event.target.value)} inputMode="numeric" />
            </label>
            <label>
              {t('regression.artifactName', 'Artifact name')}
              <input value={ciForm.artifact_name} onChange={(event) => updateCi('artifact_name', event.target.value)} />
            </label>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={ciForm.execute_confirmed} onChange={(event) => updateCi('execute_confirmed', event.target.checked)} />
            Fetch this finished CI artifact with read-only gh
          </label>
          <button className="primary-action" type="submit" disabled={busy === 'ci'}>
            {busy === 'ci' ? 'Fetching...' : t('regression.ciSubmit', 'Fetch artifact')}
          </button>
        </form>
      </section>
      {error ? <StatePanel title="Cannot update regression evidence" text={error} tone="danger" /> : null}
      {result ? <PlaywrightResultPanel result={result} /> : null}
    </div>
  );
}

function PlaywrightResultPanel({ result }) {
  const summary = result.summary ?? {};
  return (
    <section className="panel primary-panel">
      <p className="eyebrow">Result</p>
      <h3>{result.status_label ?? result.status ?? 'Updated'}</h3>
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
        <h3>{review.next_action}</h3>
        <p>{review.can_owner_review_proceed ? 'Owner review can proceed from the available local evidence.' : 'Use this as a status view until the required evidence is ready.'}</p>
      </section>
      <section className="panel">
        <h3>Top owner actions</h3>
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
        <h3>Owner evidence matrix</h3>
        {matrix ? <EvidenceMatrix matrix={matrix} /> : <StatePanel title="No owner evidence set" text="Launch status with an evidence set to show standard, deep, and xhigh readiness." />}
      </section>
      <section className="panel">
        <h3>Visual review results</h3>
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
        <h3>Latest findings</h3>
        <ResultList results={findings.visual_review.top_results} />
      </section>
      <section className="panel">
        <h3>Blockers</h3>
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
        <h3>Source status</h3>
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
        <h3>Safe commands</h3>
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
        <h3>Design system</h3>
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

function EvidenceMatrix({ matrix }) {
  const rows = Array.isArray(matrix.rows) ? matrix.rows : [];
  if (rows.length === 0) {
    return <StatePanel title="No matrix rows" text="The owner review pack did not include matrix rows." />;
  }
  return (
    <div className="matrix" role="table" aria-label="Evidence matrix">
      <div className="matrix-row header" role="row">
        <span role="columnheader">Case</span>
        <span role="columnheader">Standard</span>
        <span role="columnheader">Deep</span>
        <span role="columnheader">Xhigh</span>
      </div>
      {rows.map((row, index) => (
        <div className="matrix-row" role="row" key={row.case_id ?? index}>
          <span role="cell">{row.case_id ?? row.label ?? `Case ${index + 1}`}</span>
          <StatusBadge status={cellStatus(row, 'standard')} />
          <StatusBadge status={cellStatus(row, 'deep')} />
          <StatusBadge status={cellStatus(row, 'xhigh')} />
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
      <h3>{title}</h3>
      <p>{text}</p>
    </section>
  );
}

function StatusBadge({ status }) {
  const normalized = String(status ?? 'missing').replaceAll('_', ' ');
  return <span className={`status-badge ${toneForStatus(status)}`}>{normalized}</span>;
}

function cellStatus(row, effort) {
  const value = row[effort] ?? row.efforts?.[effort] ?? row.cells?.[effort];
  if (typeof value === 'string') {
    return value;
  }
  return value?.status ?? value?.state ?? 'missing';
}

function toneForStatus(status) {
  if (['ready', 'ok', 'available', 'configured', 'proposal_ready', 'ready_for_owner_review'].includes(status)) return 'ready';
  if (['blocked', 'error', 'failed'].includes(status)) return 'blocked';
  if (['needs_attention', 'incomplete', 'prepared', 'owner_review_recommended'].includes(status)) return 'attention';
  return 'missing';
}
