// release.test.js — packaging smoke checks for the unpacked extension.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('manifest is valid and all local references exist', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.homepage_url, 'https://github.com/sobakaio/phdownloader');
  for (const file of [manifest.background?.service_worker, manifest.action?.default_popup,
    ...(manifest.icons ? Object.values(manifest.icons) : []),
    ...(manifest.content_scripts || []).flatMap((entry) => entry.js || [])]) {
    assert.ok(file && fs.existsSync(path.join(root, file)), `missing manifest file: ${file}`);
  }
  assert.deepEqual(manifest.host_permissions, [
    'https://*.pornhub.com/*',
    'https://*.pornhubpremium.com/*',
    'https://*.phncdn.com/*',
    'https://*.phprcdn.com/*',
    'https://*.phcdn.com/*',
  ]);
});

test('release metadata stays aligned', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const bg = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.equal(pkg.version, manifest.version);
  assert.match(bg, new RegExp(`const VERSION = ['"]${manifest.version.replaceAll('.', '\\.' )}['"]`));
});
