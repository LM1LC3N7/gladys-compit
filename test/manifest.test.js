// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ACTIONS, DHW, POLL_INTERVAL, SETPOINT } from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));

test('the store basics; version 0.1.0 everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.gladys_version, /^>=5\.1\.0$/);
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, 'gladys-compit');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-compit:${manifest.version}`);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/LM1LC3N7/gladys-compit/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.deepEqual(manifest.categories, ['climate']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with|sans\s+lien\s+avec/i);
    assert.match(
      docs,
      /never\s+tested\s+with\s+a\s+real|jamais\s+testé\s+avec\s+un\s+vrai/i,
      'say it was never tested',
    );
    assert.match(docs, /24\s*°C/, 'document the room ceiling');
    assert.match(docs, /55\s*°C/, 'document the hot water ceiling');
    assert.match(docs, /60\s*°C/, 'document the hot water hard maximum');
    assert.match(docs, /compit-inext-api/, 'credit the reference');
  }
  assert.match(manifest.config_schema[0].description.fr, /Jamais testé avec un vrai régulateur/);
  assert.match(manifest.config_schema[0].description.en, /Never tested with a real controller/);
  assert.match(read('README.md'), /never tested with a real/i);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
  for (const field of manifest.config_schema.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', `${field.key}: placeholder`);
  }
});

test('no capture, no sub-container, no widget nor scene', () => {
  assert.equal(manifest.network_discovery, undefined);
  assert.equal(manifest.network_wake, undefined);
  assert.equal(manifest.containers, undefined);
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.widgets, undefined);
});

test('the configuration matches the code; the commands are off; the ceiling bounded', () => {
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  for (const field of manifest.config_schema.filter((f) => f.default !== undefined)) {
    assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
  }
  for (const key of ['allow_setpoints', 'allow_dhw', 'allow_seasons']) {
    assert.equal(fields[key].type, 'boolean');
    assert.equal(fields[key].default, false);
  }
  assert.deepEqual(
    [fields.max_setpoint.default, fields.max_setpoint.min, fields.max_setpoint.max],
    [SETPOINT.ceilingDefault, SETPOINT.ceilingMin, SETPOINT.max],
  );
  assert.equal(SETPOINT.max, 30);
  assert.deepEqual(
    [fields.max_dhw.default, fields.max_dhw.min, fields.max_dhw.max],
    [DHW.ceilingDefault, DHW.ceilingMin, DHW.max],
  );
  assert.equal(DHW.ceilingDefault, 55, 'hot water 55 °C by default');
  assert.equal(DHW.max, 60, 'hot water never above 60 °C');
  assert.deepEqual(
    [fields.poll_interval.min, fields.poll_interval.max],
    [POLL_INTERVAL.min, POLL_INTERVAL.max],
  );
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(
      section.required ?? section.default ?? section.placeholder,
      undefined,
      section.key,
    );
    assert.ok(!(section.key in DEFAULT_CONFIG), section.key);
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('the password is a secret, never said to be encrypted', () => {
  assert.equal(fields.password.type, 'secret');
  for (const field of manifest.config_schema.filter((f) => f.type === 'secret')) {
    assert.equal(field.default, undefined, `${field.key}: no default on a secret (store)`);
  }
  assert.equal(fields.password.default, undefined);
  assert.match(fields.password.description.fr, /dans sa base, jamais réaffiché/);
  assert.match(fields.password.description.en, /in its database, never shown again/);
  for (const path of [
    'gladys-assistant-integration.json',
    'docs/en.md',
    'docs/fr.md',
    'README.md',
    'TODO.md',
    'CHANGELOG.md',
    'CLAUDE.md',
    'src/i18n.js',
  ]) {
    // "chiffres" (digits) is fine; "chiffré", "chiffrement" (encrypted) are not.
    assert.doesNotMatch(
      read(path),
      /chiffré|chiffrement|crypté|encrypt/i,
      `${path}: a secret is not encrypted`,
    );
  }
});

test('the actions are the ones the code handles', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  assert.ok(manifest.actions.every((a) => a.timeout_seconds === 30));
});
