import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function requireValue(env, key, pattern, description) {
  const value = env[key];
  if (!value || !pattern.test(value)) {
    throw new Error(`${key} is required and must be ${description}.`);
  }
  return value;
}

export function renderCloudRunService(template, env = process.env) {
  const values = {
    __GCP_REGION__: requireValue(env, 'GCP_REGION', /^[a-z]+-[a-z0-9]+[0-9]$/, 'a valid region'),
    __IMAGE_URI__: requireValue(
      env,
      'IMAGE_URI',
      /^[a-z0-9-]+-docker\.pkg\.dev\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z0-9._-]+@sha256:[a-f0-9]{64}$/,
      'an Artifact Registry image URI pinned by sha256 digest'
    ),
    __CLOUD_SQL_CONNECTION_NAME__: requireValue(
      env,
      'CLOUD_SQL_CONNECTION_NAME',
      /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/,
      'a project:region:instance connection name'
    ),
    __CLOUD_RUN_SERVICE_ACCOUNT__: requireValue(
      env,
      'CLOUD_RUN_SERVICE_ACCOUNT',
      /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/,
      'a service-account email'
    ),
    __DATABASE_URL_SECRET_NAME__: requireValue(
      env,
      'DATABASE_URL_SECRET_NAME',
      /^[A-Za-z0-9_-]+$/,
      'a Secret Manager secret ID'
    ),
    __JWT_SECRET_SECRET_NAME__: requireValue(
      env,
      'JWT_SECRET_SECRET_NAME',
      /^[A-Za-z0-9_-]+$/,
      'a Secret Manager secret ID'
    ),
  };

  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(key, value);
  }
  if (/__[A-Z0-9_]+__/.test(rendered)) {
    throw new Error('Cloud Run template contains unresolved placeholders.');
  }
  return rendered;
}

function main() {
  const [templatePath, outputPath, ...extraArgs] = process.argv.slice(2);
  if (!templatePath || !outputPath || extraArgs.length > 0) {
    throw new Error('Usage: node scripts/render-cloudrun.mjs <template.yaml> <output.yaml>');
  }
  const template = fs.readFileSync(path.resolve(templatePath), 'utf8');
  const rendered = renderCloudRunService(template);
  fs.writeFileSync(path.resolve(outputPath), rendered, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[RELEASE ERROR] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
