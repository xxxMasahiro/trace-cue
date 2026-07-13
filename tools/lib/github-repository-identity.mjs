import { spawnSync } from 'node:child_process';

const HOST_PATTERN = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u;
const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/u;

function normalizeHosts(allowedHosts) {
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0 || allowedHosts.length > 16) {
    throw new Error('CI proof repository host policy is invalid.');
  }
  const hosts = allowedHosts.map((host) => String(host).toLowerCase());
  if (new Set(hosts).size !== hosts.length || hosts.some((host) => !HOST_PATTERN.test(host))) {
    throw new Error('CI proof repository host policy is invalid.');
  }
  return new Set(hosts);
}

function parseRemote(remoteUrl) {
  const value = String(remoteUrl ?? '').trim();
  if (!value || /[\0\r\n]/u.test(value)) throw new Error('CI proof repository remote URL is invalid.');
  const scp = /^git@([^:]+):(.+)$/u.exec(value);
  if (scp) return { hostname: scp[1].toLowerCase(), pathname: scp[2] };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('CI proof repository remote URL is invalid.');
  }
  if (!['https:', 'ssh:'].includes(parsed.protocol) || parsed.port || parsed.search || parsed.hash
    || (parsed.protocol === 'https:' && (parsed.username || parsed.password))
    || (parsed.protocol === 'ssh:' && (parsed.username !== 'git' || parsed.password))) {
    throw new Error('CI proof repository remote URL is invalid.');
  }
  return { hostname: parsed.hostname.toLowerCase(), pathname: parsed.pathname };
}

export function parseGithubRepositoryIdentity(remoteUrl, allowedHosts) {
  const allowed = normalizeHosts(allowedHosts);
  const parsed = parseRemote(remoteUrl);
  if (!allowed.has(parsed.hostname)) throw new Error('CI proof repository host is not allowed by policy.');
  if (parsed.pathname.includes('%')) throw new Error('CI proof repository path is invalid.');
  const repository = parsed.pathname.replace(/^\/+|\.git$/gu, '');
  const segments = repository.split('/');
  if (segments.length !== 2 || segments.some((segment) => !REPOSITORY_SEGMENT_PATTERN.test(segment)
    || segment === '.' || segment === '..')) {
    throw new Error('CI proof repository path is invalid.');
  }
  return Object.freeze({ hostname: parsed.hostname, repository });
}

export function githubRepositoryIdentity(root, remoteName, allowedHosts) {
  if (typeof root !== 'string' || !root || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(remoteName ?? '')) {
    throw new Error('CI proof repository remote configuration is invalid.');
  }
  const result = spawnSync('git', ['-C', root, 'config', '--get', `remote.${remoteName}.url`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) throw new Error('CI proof repository remote is not configured.');
  return parseGithubRepositoryIdentity(result.stdout, allowedHosts);
}
