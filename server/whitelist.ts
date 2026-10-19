/**
 * Whitelist management via GitHub API.
 *
 * Manages whitelist.json in 7oncha/SRManager-Installer repo.
 * Format: [{ "discordId": "123", "discordName": "User" }, ...]
 *
 * Launcher reads this file to check if a player is allowed.
 * Bot updates it when players gain/lose the "Player" role.
 */

interface WhitelistEntry {
  discordId: string;
  discordName: string;
}

const REPO_OWNER = '7oncha';
const FILE_PATH = 'whitelist.json';

// Primary repo (branch: master) and backup repo (branch: main)
const REPOS = [
  { name: 'SRManager-Installer', branch: 'master' },
  { name: 'SlavonskaRavnica-apk', branch: 'main' },
] as const;

const PRIMARY = REPOS[0];

function getToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN env var is not set');
  return token;
}

async function githubApi(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  return fetch(url, {
    ...options,
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
}

interface FileInfo {
  content: WhitelistEntry[];
  sha: string;
}

async function getWhitelistFromRepo(repo: string, branch: string): Promise<FileInfo> {
  const res = await githubApi(
    `https://api.github.com/repos/${REPO_OWNER}/${repo}/contents/${FILE_PATH}?ref=${branch}`
  );

  if (!res.ok) {
    if (res.status === 404) {
      return { content: [], sha: '' };
    }
    throw new Error(`GitHub API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as { content: string; sha: string };
  const decoded = Buffer.from(data.content, 'base64').toString('utf-8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(decoded);
  // Support both { whitelisted: [...] } wrapper and plain array
  const content: WhitelistEntry[] = Array.isArray(parsed) ? parsed : (parsed.whitelisted ?? []);
  return { content, sha: data.sha };
}

async function putWhitelistToRepo(repo: string, branch: string, entries: WhitelistEntry[], sha: string, message: string): Promise<void> {
  const content = JSON.stringify({ whitelisted: entries }, null, 2) + '\n';
  const body: Record<string, string> = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;

  const res = await githubApi(
    `https://api.github.com/repos/${REPO_OWNER}/${repo}/contents/${FILE_PATH}`,
    {
      method: 'PUT',
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    throw new Error(`GitHub PUT error: ${res.status} ${await res.text()}`);
  }
}

/** Get the full whitelist */
export async function getWhitelist(): Promise<WhitelistEntry[]> {
  const { content } = await getWhitelistFromRepo(PRIMARY.name, PRIMARY.branch);
  return content;
}

/** Add a player to the whitelist. Returns true if added, false if already exists. */
export async function addToWhitelist(discordId: string, discordName: string): Promise<boolean> {
  // Update primary repo
  const { content, sha } = await getWhitelistFromRepo(PRIMARY.name, PRIMARY.branch);
  if (content.some(e => e.discordId === discordId)) return false;
  content.push({ discordId, discordName });
  await putWhitelistToRepo(PRIMARY.name, PRIMARY.branch, content, sha, `whitelist: add ${discordName} (${discordId})`);

  // Update all other repos
  for (const repo of REPOS.slice(1)) {
    try {
      const backup = await getWhitelistFromRepo(repo.name, repo.branch);
      if (!backup.content.some(e => e.discordId === discordId)) {
        backup.content.push({ discordId, discordName });
        await putWhitelistToRepo(repo.name, repo.branch, backup.content, backup.sha, `whitelist: add ${discordName} (${discordId})`);
      }
    } catch (e) {
      console.error(`[WHITELIST] Backup repo ${repo.name} update failed:`, e);
    }
  }

  console.log(`[WHITELIST] Added: ${discordName} (${discordId})`);
  return true;
}

/** Remove a player from the whitelist. Returns true if removed, false if not found. */
export async function removeFromWhitelist(discordId: string): Promise<boolean> {
  // Update primary repo
  const { content, sha } = await getWhitelistFromRepo(PRIMARY.name, PRIMARY.branch);
  const idx = content.findIndex(e => e.discordId === discordId);
  if (idx === -1) return false;
  const removed = content[idx];
  content.splice(idx, 1);
  await putWhitelistToRepo(PRIMARY.name, PRIMARY.branch, content, sha, `whitelist: remove ${removed.discordName} (${discordId})`);

  // Update all other repos
  for (const repo of REPOS.slice(1)) {
    try {
      const backup = await getWhitelistFromRepo(repo.name, repo.branch);
      const bIdx = backup.content.findIndex(e => e.discordId === discordId);
      if (bIdx !== -1) {
        backup.content.splice(bIdx, 1);
        await putWhitelistToRepo(repo.name, repo.branch, backup.content, backup.sha, `whitelist: remove ${removed.discordName} (${discordId})`);
      }
    } catch (e) {
      console.error(`[WHITELIST] Backup repo ${repo.name} update failed:`, e);
    }
  }

  console.log(`[WHITELIST] Removed: ${removed.discordName} (${discordId})`);
  return true;
}
