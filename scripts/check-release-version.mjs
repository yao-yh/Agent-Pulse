#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const releaseTag = normalizeTag(process.argv[2] || process.env.GITHUB_REF_NAME || '');
const rootPackage = readPackageJson('package.json');
const cliPackage = readPackageJson(join('apps', 'cli', 'package.json'));
const expectedTag = `v${cliPackage.version}`;
const errors = [];

// The CLI package is the single public npm artifact, so release tags must match its package version.
if (rootPackage.version !== cliPackage.version) {
  errors.push(`Root package version ${rootPackage.version} does not match CLI package version ${cliPackage.version}.`);
}

if (!releaseTag) {
  errors.push('Missing release tag. Pass a tag such as v0.0.3.');
} else if (releaseTag !== expectedTag) {
  errors.push(`Release tag ${releaseTag} does not match CLI package version ${cliPackage.version}; expected ${expectedTag}.`);
}

if (releaseTag && !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(releaseTag)) {
  errors.push(`Release tag ${releaseTag} is not a valid vMAJOR.MINOR.PATCH tag.`);
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`Release version check passed for ${releaseTag}.`);

function readPackageJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function normalizeTag(value) {
  return value.replace(/^refs\/tags\//, '').trim();
}
