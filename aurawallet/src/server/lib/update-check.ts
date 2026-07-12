export interface VersionInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

function parse(v: string): number[] {
  return v
    .replace(/^v/i, '')
    .split('.')
    .map((p) => Number.parseInt(p.replace(/[^0-9].*$/, ''), 10) || 0)
    .slice(0, 3);
}

export function isNewerVersion(current: string, latest: string): boolean {
  const c = parse(current);
  const l = parse(latest);
  for (let i = 0; i < 3; i += 1) {
    if ((l[i] || 0) > (c[i] || 0)) return true;
    if ((l[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

export function buildVersionInfo(current: string, latest: string): VersionInfo {
  return {
    current,
    latest,
    updateAvailable: isNewerVersion(current, latest),
  };
}

export function buildUpdateCommand(packageName = 'auramaxx'): string {
  return `npm uninstall -g ${packageName} && npm install -g ${packageName} --foreground-scripts`;
}

export function buildUpdateForceCommand(packageName = 'auramaxx'): string {
  return `npm uninstall -g ${packageName} && npm install -g ${packageName} --foreground-scripts --force`;
}

export function buildNpxLatestCommand(packageName = 'auramaxx', args: string[] = []): string {
  const suffix = args.length > 0 ? ` ${args.join(' ')}` : '';
  return `npx --yes ${packageName}@latest${suffix}`;
}

export function buildUpdateFallbackCommand(packageName = 'auramaxx'): string {
  return buildNpxLatestCommand(packageName, ['start']);
}
