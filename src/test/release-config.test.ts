import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const workspaceRoot = process.cwd();
const rendererPath = path.join(workspaceRoot, 'scripts', 'render-cloudrun.mjs');
const manifestPath = path.join(workspaceRoot, 'cloudrun.service.yaml');

const renderEnv = {
  GCP_REGION: 'europe-west2',
  IMAGE_URI: `europe-west2-docker.pkg.dev/billing-system-prod/containers/billing-system-api@sha256:${'a'.repeat(64)}`,
  CLOUD_SQL_CONNECTION_NAME: 'billing-system-prod:europe-west2:billing-postgres',
  CLOUD_RUN_SERVICE_ACCOUNT: 'billing-api@billing-system-prod.iam.gserviceaccount.com',
  DATABASE_URL_SECRET_NAME: 'billing-prod-database-url',
  JWT_SECRET_SECRET_NAME: 'billing-prod-jwt-secret',
};

describe('Cloud Run release configuration rendering', () => {
  it('renders the production manifest with a digest-pinned image and confirmed infrastructure inputs', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-release-config-'));
    const outputPath = path.join(tempDir, 'service.yaml');

    try {
      execFileSync(process.execPath, [rendererPath, manifestPath, outputPath], {
        env: { ...process.env, ...renderEnv },
        stdio: 'pipe',
      });
      const rendered = fs.readFileSync(outputPath, 'utf8');
      assert.ok(rendered.includes(renderEnv.IMAGE_URI));
      assert.ok(rendered.includes(renderEnv.CLOUD_SQL_CONNECTION_NAME));
      assert.ok(rendered.includes(renderEnv.CLOUD_RUN_SERVICE_ACCOUNT));
      assert.ok(rendered.includes(renderEnv.DATABASE_URL_SECRET_NAME));
      assert.ok(rendered.includes(renderEnv.JWT_SECRET_SECRET_NAME));
      assert.ok(rendered.includes('run.googleapis.com/ingress: internal-and-cloud-load-balancing'));
      assert.ok(!/__([A-Z0-9_]+)__/.test(rendered));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects mutable image tags and missing required configuration without creating output', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-release-config-'));
    const outputPath = path.join(tempDir, 'service.yaml');

    try {
      assert.throws(() =>
        execFileSync(process.execPath, [rendererPath, manifestPath, outputPath], {
          env: {
            ...process.env,
            ...renderEnv,
            IMAGE_URI: 'europe-west2-docker.pkg.dev/billing-system-prod/containers/billing-system-api:1.0.0',
          },
          stdio: 'pipe',
        })
      );
      assert.throws(() =>
        execFileSync(process.execPath, [rendererPath, manifestPath, outputPath], {
          env: { ...process.env, ...renderEnv, JWT_SECRET_SECRET_NAME: '' },
          stdio: 'pipe',
        })
      );
      assert.equal(fs.existsSync(outputPath), false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('requires explicit approval before attempting a GitHub source release', () => {
    const scriptPath = path.join(workspaceRoot, 'scripts', 'deploy-release.sh');
    assert.throws(
      () =>
        execFileSync('bash', [scriptPath, '--source-release'], {
          env: { ...process.env, CONFIRM_SOURCE_RELEASE: '' },
          stdio: 'pipe',
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const stderr = 'stderr' in error ? String(error.stderr) : error.message;
        assert.match(stderr, /CONFIRM_SOURCE_RELEASE=YES/);
        return true;
      }
    );
  });
});
