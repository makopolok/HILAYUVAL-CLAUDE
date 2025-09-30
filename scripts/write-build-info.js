#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const shortHash = (value) => {
  if (!value || typeof value !== 'string') return null;
  return value.trim().substring(0, 7);
};

const resolveFromEnv = () => {
  const fullCommit = process.env.HEROKU_BUILD_COMMIT || process.env.SOURCE_VERSION || process.env.HEROKU_SLUG_COMMIT || null;
  const branch = process.env.HEROKU_GIT_BRANCH || process.env.GIT_BRANCH || null;
  const release = process.env.HEROKU_RELEASE_VERSION || null;
  const createdAt = process.env.HEROKU_RELEASE_CREATED_AT || null;

  return {
    commit: shortHash(fullCommit) || null,
    fullCommit,
    branch,
    release,
    releaseCreatedAt: createdAt
  };
};

const resolveFromGit = () => {
  try {
    const { execSync } = require('child_process');
    const fullCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    return {
      commit: shortHash(fullCommit),
      fullCommit,
      branch,
      release: null,
      releaseCreatedAt: null
    };
  } catch (error) {
    return null;
  }
};

const envInfo = resolveFromEnv();
const gitInfo = envInfo.commit ? null : resolveFromGit();

const payload = {
  commit: envInfo.commit || (gitInfo && gitInfo.commit) || 'unknown',
  fullCommit: envInfo.fullCommit || (gitInfo && gitInfo.fullCommit) || null,
  branch: envInfo.branch || (gitInfo && gitInfo.branch) || null,
  release: envInfo.release || (gitInfo && gitInfo.release) || null,
  releaseCreatedAt: envInfo.releaseCreatedAt || (gitInfo && gitInfo.releaseCreatedAt) || null,
  generatedAt: new Date().toISOString()
};

const outputPath = path.join(__dirname, '..', 'build-info.json');
try {
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
  console.log('[build-info] Wrote metadata to', outputPath);
  console.log('[build-info] Payload:', payload);
  process.exit(0);
} catch (error) {
  console.error('[build-info] Failed to write metadata file:', error);
  process.exit(1);
}
