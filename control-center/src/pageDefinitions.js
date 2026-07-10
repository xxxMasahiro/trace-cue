export const PAGES = [
  { id: 'confirm', labelKey: 'nav.confirm', fallback: 'Reviews', icon: '✓' },
  { id: 'running', labelKey: 'nav.running', fallback: 'In progress', icon: '↻' },
  { id: 'settings', labelKey: 'nav.settings', fallback: 'Settings', icon: '⚙' }
];

export const WORKFLOW_STAGES = Object.freeze([
  { id: 'prepare', labelKey: 'workflow.stage.prepare', fallback: 'Prepare' },
  { id: 'review', labelKey: 'workflow.stage.review', fallback: 'Review' },
  { id: 'decide', labelKey: 'workflow.stage.decide', fallback: 'Decide' },
  { id: 'recheck', labelKey: 'workflow.stage.recheck', fallback: 'Recheck' },
  { id: 'complete', labelKey: 'workflow.stage.complete', fallback: 'Complete' }
]);

export const LEGACY_PAGE_ROUTES = Object.freeze({
  intake: Object.freeze({ page: 'confirm', view: 'new', itemId: null }),
  review: Object.freeze({ page: 'confirm', view: 'work', itemId: null }),
  regression: Object.freeze({ page: 'confirm', view: 'work', itemId: null }),
  evidence: Object.freeze({ page: 'confirm', view: 'work', itemId: null }),
  findings: Object.freeze({ page: 'confirm', view: 'work', itemId: null }),
  settings: Object.freeze({ page: 'settings', view: 'list', itemId: null }),
  advanced: Object.freeze({ page: 'settings', view: 'list', itemId: null })
});
