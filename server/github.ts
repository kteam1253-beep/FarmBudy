// GitHub Integration - Connected via Replit connector
import { Octokit } from '@octokit/rest';

let connectionSettings: any;

async function getAccessToken() {
  if (connectionSettings && connectionSettings.settings.expires_at && new Date(connectionSettings.settings.expires_at).getTime() > Date.now()) {
    return connectionSettings.settings.access_token;
  }
  
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=github',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  const accessToken = connectionSettings?.settings?.access_token || connectionSettings.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error('GitHub not connected');
  }
  return accessToken;
}

// WARNING: Never cache this client.
// Access tokens expire, so a new client must be created each time.
export async function getGitHubClient() {
  const accessToken = await getAccessToken();
  return new Octokit({ auth: accessToken });
}

// Get authenticated user info
export async function getGitHubUser() {
  const octokit = await getGitHubClient();
  const { data } = await octokit.users.getAuthenticated();
  return data;
}

// List repositories
export async function listRepositories() {
  const octokit = await getGitHubClient();
  const { data } = await octokit.repos.listForAuthenticatedUser({
    sort: 'updated',
    per_page: 100
  });
  return data;
}

// Get repository info
export async function getRepository(owner: string, repo: string) {
  const octokit = await getGitHubClient();
  const { data } = await octokit.repos.get({ owner, repo });
  return data;
}

// Create or update file in repository
export async function pushFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch: string = 'main'
) {
  const octokit = await getGitHubClient();
  
  // Try to get existing file to get its SHA
  let sha: string | undefined;
  try {
    const { data: existingFile } = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref: branch
    });
    if ('sha' in existingFile) {
      sha = existingFile.sha;
    }
  } catch (e) {
    // File doesn't exist, that's okay
  }

  const { data } = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message,
    content: Buffer.from(content).toString('base64'),
    branch,
    sha
  });

  return data;
}

// Push multiple files at once using Git Data API
export async function pushMultipleFiles(
  owner: string,
  repo: string,
  files: Array<{ path: string; content: string }>,
  message: string,
  branch: string = 'main',
  cleanPush: boolean = false
) {
  const octokit = await getGitHubClient();

  // Get the current commit SHA for the branch
  const { data: refData } = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`
  });
  const currentCommitSha = refData.object.sha;

  // Get the current tree
  const { data: commitData } = await octokit.git.getCommit({
    owner,
    repo,
    commit_sha: currentCommitSha
  });
  const baseTreeSha = commitData.tree.sha;

  // Create blobs for each file
  const blobs = await Promise.all(
    files.map(async (file) => {
      const { data: blobData } = await octokit.git.createBlob({
        owner,
        repo,
        content: Buffer.from(file.content).toString('base64'),
        encoding: 'base64'
      });
      return {
        path: file.path,
        mode: '100644' as const,
        type: 'blob' as const,
        sha: blobData.sha
      };
    })
  );

  // Create a new tree - without base_tree if cleanPush to remove old files
  const treeOptions: any = {
    owner,
    repo,
    tree: blobs
  };
  
  if (!cleanPush) {
    treeOptions.base_tree = baseTreeSha;
  }
  
  const { data: newTree } = await octokit.git.createTree(treeOptions);

  // Create a new commit
  const { data: newCommit } = await octokit.git.createCommit({
    owner,
    repo,
    message,
    tree: newTree.sha,
    parents: [currentCommitSha]
  });

  // Update the branch reference
  await octokit.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: newCommit.sha
  });

  return newCommit;
}

// Create a new release/tag
export async function createRelease(
  owner: string,
  repo: string,
  tagName: string,
  name: string,
  body: string,
  draft: boolean = false,
  prerelease: boolean = false
) {
  const octokit = await getGitHubClient();
  const { data } = await octokit.repos.createRelease({
    owner,
    repo,
    tag_name: tagName,
    name,
    body,
    draft,
    prerelease
  });
  return data;
}

// Upload asset to a release
export async function uploadReleaseAsset(
  owner: string,
  repo: string,
  releaseId: number,
  fileName: string,
  fileContent: Buffer,
  contentType: string = 'application/zip'
) {
  const octokit = await getGitHubClient();
  const { data } = await octokit.repos.uploadReleaseAsset({
    owner,
    repo,
    release_id: releaseId,
    name: fileName,
    data: fileContent as any,
    headers: {
      'content-type': contentType,
      'content-length': fileContent.length
    }
  });
  return data;
}

// List repository contents
export async function listRepoContents(owner: string, repo: string, path: string = '') {
  const octokit = await getGitHubClient();
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path
    });
    return Array.isArray(data) ? data : [data];
  } catch (e) {
    return [];
  }
}

// Delete file from repository
export async function deleteFile(
  owner: string,
  repo: string,
  path: string,
  message: string,
  branch: string = 'main'
) {
  const octokit = await getGitHubClient();
  
  // Get the file SHA
  const { data: fileData } = await octokit.repos.getContent({
    owner,
    repo,
    path,
    ref: branch
  });
  
  if (!('sha' in fileData)) {
    throw new Error('Cannot delete directory');
  }
  
  const { data } = await octokit.repos.deleteFile({
    owner,
    repo,
    path,
    message,
    sha: fileData.sha,
    branch
  });
  
  return data;
}

// Create release with mod assets
export async function createModRelease(
  owner: string,
  repo: string,
  tagName: string,
  modFiles: Array<{ name: string; content: Buffer }>
) {
  const octokit = await getGitHubClient();
  
  // Create the release
  const { data: release } = await octokit.repos.createRelease({
    owner,
    repo,
    tag_name: tagName,
    name: `SR Mods ${tagName}`,
    body: `Slavonska Ravnica FS25 Modovi\n\n- FS25_SR_Companion.zip\n- FS25_SR_FarmBuddy_Manager.zip`,
    draft: false,
    prerelease: false
  });

  // Upload each mod as release asset
  const uploadedAssets = [];
  for (const mod of modFiles) {
    const asset = await uploadReleaseAsset(
      owner,
      repo,
      release.id,
      mod.name,
      mod.content,
      'application/zip'
    );
    uploadedAssets.push(asset);
  }

  return { release, assets: uploadedAssets };
}
