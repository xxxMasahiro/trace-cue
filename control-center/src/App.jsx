import { useEffect, useMemo, useState } from 'react';
import { fetchDashboard } from './apiClient.js';
import { designSystemMetadata, designSystemStyle } from './designSystem.js';

const PAGES = [
  { id: 'review', label: 'Review' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'findings', label: 'Findings' },
  { id: 'advanced', label: 'Advanced' }
];

export default function App() {
  const [dashboard, setDashboard] = useState(null);
  const [activePage, setActivePage] = useState('review');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const style = useMemo(() => designSystemStyle(), []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setDashboard(await fetchDashboard());
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <main className="app-shell" style={style}>
      <aside className="side-nav" aria-label="Primary">
        <div>
          <p className="eyebrow">TraceCue</p>
          <h1>Review center</h1>
        </div>
        <nav className="nav-list">
          {PAGES.map((page) => (
            <button
              key={page.id}
              type="button"
              className={activePage === page.id ? 'nav-item active' : 'nav-item'}
              onClick={() => setActivePage(page.id)}
            >
              {page.label}
            </button>
          ))}
        </nav>
        <TrustSafety dashboard={dashboard} />
      </aside>
      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="eyebrow">Read-only local status</p>
            <h2>{dashboard?.status_label ?? (loading ? 'Loading local evidence' : 'Local evidence unavailable')}</h2>
          </div>
          <button className="refresh-button" type="button" onClick={load} disabled={loading}>
            Refresh
          </button>
        </header>
        {loading ? <StatePanel title="Loading" text="Reading local TraceCue status." /> : null}
        {error ? <StatePanel title="Cannot load status" text={error} tone="danger" /> : null}
        {!loading && !error && dashboard ? (
          <>
            {activePage === 'review' ? <ReviewPage dashboard={dashboard} /> : null}
            {activePage === 'evidence' ? <EvidencePage dashboard={dashboard} /> : null}
            {activePage === 'findings' ? <FindingsPage dashboard={dashboard} /> : null}
            {activePage === 'advanced' ? <AdvancedPage dashboard={dashboard} /> : null}
          </>
        ) : null}
      </section>
    </main>
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

function TrustSafety({ dashboard }) {
  const safety = dashboard?.review?.trust_safety;
  return (
    <div className="safety-strip">
      <span>Read-only</span>
      <span>{safety?.local_only === false ? 'External' : 'Local'}</span>
      <span>{safety?.external_evidence_transfer ? 'Transfer on' : 'No upload'}</span>
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
  if (['ready', 'ok', 'ready_for_owner_review'].includes(status)) return 'ready';
  if (['blocked', 'error', 'failed'].includes(status)) return 'blocked';
  if (['needs_attention', 'incomplete', 'prepared', 'owner_review_recommended'].includes(status)) return 'attention';
  return 'missing';
}
