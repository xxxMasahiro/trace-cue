import tokens from '../../docs/design-system/tokens.json';
import components from '../../docs/design-system/components.json';

export function designSystemStyle() {
  const color = tokens.tokens?.color ?? {};
  const space = tokens.tokens?.space ?? {};
  const radius = tokens.tokens?.radius ?? {};
  const font = tokens.tokens?.font ?? {};
  const layout = tokens.tokens?.layout ?? {};
  return {
    '--tc-color-background': color.background ?? '#ffffff',
    '--tc-color-surface': color.surface ?? color.background ?? '#ffffff',
    '--tc-color-panel': color.panel ?? '#f7f9fb',
    '--tc-color-foreground': color.foreground ?? '#1f2933',
    '--tc-color-muted': color.muted ?? '#5b6876',
    '--tc-color-line': color.line ?? '#d8dee6',
    '--tc-color-accent': color.accent ?? '#1f7a8c',
    '--tc-color-accent-strong': color.accent_strong ?? color.accent ?? '#1f7a8c',
    '--tc-color-accent-soft': color.accent_soft ?? '#eef6f7',
    '--tc-color-navigation': color.navigation ?? '#111b25',
    '--tc-color-navigation-muted': color.navigation_muted ?? '#9cabb9',
    '--tc-color-navigation-text': color.navigation_text ?? color.navigation_muted ?? '#9cabb9',
    '--tc-color-navigation-note': color.navigation_note ?? color.navigation_muted ?? '#9cabb9',
    '--tc-color-navigation-mark': color.navigation_mark ?? color.navigation_muted ?? '#9cabb9',
    '--tc-color-navigation-mark-text': color.navigation_mark_text ?? color.navigation_muted ?? '#9cabb9',
    '--tc-color-navigation-hover': color.navigation_hover ?? color.navigation ?? '#111b25',
    '--tc-color-success': color.success ?? '#287d3c',
    '--tc-color-success-soft': color.success_soft ?? '#eaf7ee',
    '--tc-color-warning': color.warning ?? '#a16207',
    '--tc-color-warning-soft': color.warning_soft ?? '#fff8e8',
    '--tc-color-danger': color.danger ?? '#b42318',
    '--tc-space-xs': space.xs ?? '4px',
    '--tc-space-sm': space.sm ?? '8px',
    '--tc-space-md': space.md ?? '16px',
    '--tc-space-lg': space.lg ?? '24px',
    '--tc-radius-sm': radius.sm ?? '4px',
    '--tc-radius-md': radius.md ?? '8px',
    '--tc-font-ui': font.ui ?? '-apple-system, BlinkMacSystemFont, Segoe UI, Noto Sans JP, sans-serif',
    '--tc-font-mono': font.mono ?? 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    '--tc-font-body': font.body ?? '16px',
    '--tc-font-page-title': font.page_title ?? '30px',
    '--tc-font-section-title': font.section_title ?? '19px',
    '--tc-font-supporting': font.supporting ?? '14px',
    '--tc-layout-sidebar-width': layout.sidebar_width ?? '232px',
    '--tc-layout-content-width': layout.content_width ?? '1120px',
    '--tc-layout-narrow-content-width': layout.narrow_content_width ?? '760px'
  };
}

export function designSystemMetadata() {
  return {
    token_schema_version: tokens.schema_version,
    component_schema_version: components.schema_version,
    component_ids: Array.isArray(components.components) ? components.components.map((component) => component.id) : []
  };
}
