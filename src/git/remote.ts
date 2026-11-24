export interface RemoteRepo {
  host: string;
  /** Repository path without leading slash and `.git`, e.g. `owner/repo`. */
  path: string;
}

/** Parses a git remote URL (https, ssh or scp-like) into host and repository path. */
export function parseRemoteUrl(url: string): RemoteRepo | undefined {
  const trimmed = url.trim();
  let host: string;
  let path: string;

  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    host = scp[1];
    path = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (!parsed.hostname) {
      return undefined;
    }
    host = parsed.hostname;
    path = parsed.pathname;
  }

  path = path
    .replace(/^\/+/, '')
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '');
  if (host === 'ssh.dev.azure.com') {
    // v3/org/project/repo -> org/project/_git/repo
    const m = /^v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    if (m) {
      return { host: 'dev.azure.com', path: `${m[1]}/${m[2]}/_git/${m[3]}` };
    }
  }
  if (!path) {
    return undefined;
  }
  return { host, path };
}

/** Builds the web URL of a commit for common git hosts. */
export function commitWebUrl(remoteUrl: string, sha: string): string | undefined {
  const repo = parseRemoteUrl(remoteUrl);
  if (!repo) {
    return undefined;
  }
  const base = `https://${repo.host}/${repo.path}`;
  if (repo.host.includes('bitbucket')) {
    return `${base}/commits/${sha}`;
  }
  if (repo.host.includes('dev.azure.com') || repo.host.includes('visualstudio.com')) {
    return `${base}/commit/${sha}`;
  }
  if (repo.host.includes('gitlab')) {
    return `${base}/-/commit/${sha}`;
  }
  return `${base}/commit/${sha}`;
}
