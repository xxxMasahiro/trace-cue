import tokens from '../../docs/design-system/tokens.json';
import components from '../../docs/design-system/components.json';

export function designSystemStyle() {
  const color = tokens.tokens?.color ?? {};
  const space = tokens.tokens?.space ?? {};
  const radius = tokens.tokens?.radius ?? {};
  const font = tokens.tokens?.font ?? {};
  return {
    '--tc-color-background': color.background ?? '#ffffff',
    '--tc-color-surface': color.surface ?? color.background ?? '#ffffff',
    '--tc-color-panel': color.panel ?? '#f7f9fb',
    '--tc-color-foreground': color.foreground ?? '#1f2933',
    '--tc-color-muted': color.muted ?? '#5b6876',
    '--tc-color-line': color.line ?? '#d8dee6',
    '--tc-color-accent': color.accent ?? '#1f7a8c',
    '--tc-color-success': color.success ?? '#287d3c',
    '--tc-color-warning': color.warning ?? '#a16207',
    '--tc-color-danger': color.danger ?? '#b42318',
    '--tc-space-xs': space.xs ?? '4px',
    '--tc-space-sm': space.sm ?? '8px',
    '--tc-space-md': space.md ?? '16px',
    '--tc-space-lg': space.lg ?? '24px',
    '--tc-radius-sm': radius.sm ?? '4px',
    '--tc-radius-md': radius.md ?? '8px',
    '--tc-font-ui': font.ui ?? 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    '--tc-font-mono': font.mono ?? 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  };
}

export function designSystemMetadata() {
  return {
    token_schema_version: tokens.schema_version,
    component_schema_version: components.schema_version,
    component_ids: Array.isArray(components.components) ? components.components.map((component) => component.id) : []
  };
}
