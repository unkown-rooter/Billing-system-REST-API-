#!/usr/bin/env bash
#
# Gated v1.0.0 release path:
# GitHub source release -> Artifact Registry image -> Cloud Run migration job -> service.
# This script never loads a local .env file. Production secrets stay in Secret Manager.

set -euo pipefail

MODE="preview"
case "${1:-}" in
  "")
    ;;
  --preview)
    MODE="preview"
    ;;
  --execute)
    MODE="execute"
    ;;
  *)
    echo "Usage: $0 [--preview|--execute]" >&2
    exit 2
    ;;
esac

if [ "$#" -gt 1 ]; then
  echo "Usage: $0 [--preview|--execute]" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[RELEASE ERROR] Node.js is required." >&2
  exit 1
fi

PACKAGE_VERSION="$(node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version)")"
RELEASE_VERSION="${RELEASE_VERSION:-$PACKAGE_VERSION}"
RELEASE_TAG="v${RELEASE_VERSION}"
SERVICE_NAME="billing-system-api"
MIGRATION_JOB_NAME="${MIGRATION_JOB_NAME:-billing-system-api-migrate}"
IMAGE_NAME="${IMAGE_NAME:-billing-system-api}"

required_inputs=(
  GCP_PROJECT_ID
  GCP_REGION
  ARTIFACT_REGISTRY_REPOSITORY
  CLOUD_SQL_CONNECTION_NAME
  CLOUD_RUN_SERVICE_ACCOUNT
  DATABASE_URL_SECRET_NAME
  JWT_SECRET_SECRET_NAME
  PUBLIC_API_URL
)
missing_inputs=()
for input_name in "${required_inputs[@]}"; do
  if [ -z "${!input_name:-}" ]; then
    missing_inputs+=("$input_name")
  fi
done

if [ "${RELEASE_VERSION}" != "$PACKAGE_VERSION" ]; then
  echo "[RELEASE ERROR] RELEASE_VERSION (${RELEASE_VERSION}) must match package.json (${PACKAGE_VERSION})." >&2
  exit 1
fi

if [ -n "${GCP_PROJECT_ID:-}" ] && [[ ! "$GCP_PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  echo "[RELEASE ERROR] GCP_PROJECT_ID is not a valid project ID." >&2
  exit 1
fi
if [ -n "${GCP_REGION:-}" ] && [[ ! "$GCP_REGION" =~ ^[a-z]+-[a-z0-9]+[0-9]$ ]]; then
  echo "[RELEASE ERROR] GCP_REGION must be a region such as europe-west2." >&2
  exit 1
fi
if [ -n "${ARTIFACT_REGISTRY_REPOSITORY:-}" ] && [[ ! "$ARTIFACT_REGISTRY_REPOSITORY" =~ ^[a-z][a-z0-9-]{0,62}$ ]]; then
  echo "[RELEASE ERROR] ARTIFACT_REGISTRY_REPOSITORY contains invalid characters." >&2
  exit 1
fi
if [[ ! "$IMAGE_NAME" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "[RELEASE ERROR] IMAGE_NAME contains invalid characters." >&2
  exit 1
fi
if [ -n "${CLOUD_SQL_CONNECTION_NAME:-}" ] && [[ ! "$CLOUD_SQL_CONNECTION_NAME" =~ ^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$ ]]; then
  echo "[RELEASE ERROR] CLOUD_SQL_CONNECTION_NAME must use project:region:instance form." >&2
  exit 1
fi
for secret_name in "${DATABASE_URL_SECRET_NAME:-}" "${JWT_SECRET_SECRET_NAME:-}"; do
  if [ -n "$secret_name" ] && [[ ! "$secret_name" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "[RELEASE ERROR] Secret Manager secret IDs may contain only letters, digits, underscores, and hyphens." >&2
    exit 1
  fi
done
if [ -n "${CLOUD_RUN_SERVICE_ACCOUNT:-}" ] && [[ ! "$CLOUD_RUN_SERVICE_ACCOUNT" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$ ]]; then
  echo "[RELEASE ERROR] CLOUD_RUN_SERVICE_ACCOUNT must be a service-account email." >&2
  exit 1
fi
if [ -n "${PUBLIC_API_URL:-}" ] && [[ ! "$PUBLIC_API_URL" =~ ^https://[^/]+/?$ ]]; then
  echo "[RELEASE ERROR] PUBLIC_API_URL must be the HTTPS origin of the load-balanced API." >&2
  exit 1
fi

if [ "$MODE" = "preview" ]; then
  echo "[RELEASE] Preview only; no release, image push, migration, or deployment will be performed."
  if [ "${#missing_inputs[@]}" -gt 0 ]; then
    printf '[RELEASE] Missing configuration: %s\n' "${missing_inputs[*]}"
  fi
  cat <<EOF
[RELEASE] Proposed actions after inputs and approvals are ready:
  1. Run npm ci, npm run lint, and npm test.
  2. Create GitHub source release ${RELEASE_TAG} from the clean current commit.
  3. Build and push ${GCP_REGION:-<GCP_REGION>}-docker.pkg.dev/${GCP_PROJECT_ID:-<GCP_PROJECT_ID>}/${ARTIFACT_REGISTRY_REPOSITORY:-<AR_REPOSITORY>}/${IMAGE_NAME}:${RELEASE_VERSION}.
  4. Run ${MIGRATION_JOB_NAME} with the production DATABASE_URL secret and Cloud SQL attachment.
  5. Deploy ${SERVICE_NAME} with the immutable image digest and smoke-test ${PUBLIC_API_URL:-<PUBLIC_API_URL>}.
EOF
  exit 0
fi

if [ "${#missing_inputs[@]}" -gt 0 ]; then
  printf '[RELEASE ERROR] Required inputs are missing: %s\n' "${missing_inputs[*]}" >&2
  exit 1
fi
if [ "${CONFIRM_PRODUCTION_RELEASE:-}" != "YES" ]; then
  echo "[RELEASE ERROR] Set CONFIRM_PRODUCTION_RELEASE=YES to authorize external release and deployment actions." >&2
  exit 1
fi
if [ "${CLOUD_ARMOR_READY:-}" != "true" ]; then
  echo "[RELEASE ERROR] Set CLOUD_ARMOR_READY=true only after the external load balancer and Cloud Armor policy are configured. The service manifest restricts direct Cloud Run ingress." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "[RELEASE ERROR] Release source must be a clean, committed worktree." >&2
  exit 1
fi

RELEASE_COMMIT="${RELEASE_COMMIT:-$(git rev-parse HEAD)}"
if [ "$(git rev-parse HEAD)" != "$RELEASE_COMMIT" ]; then
  echo "[RELEASE ERROR] HEAD must equal the approved RELEASE_COMMIT." >&2
  exit 1
fi
if git show-ref --verify --quiet "refs/tags/${RELEASE_TAG}"; then
  echo "[RELEASE ERROR] Local tag ${RELEASE_TAG} already exists." >&2
  exit 1
fi

for tool in npm gh gcloud docker curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[RELEASE ERROR] Required command not found: $tool" >&2
    exit 1
  fi
done
gh auth status
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q .

IMAGE_TAG_URI="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${ARTIFACT_REGISTRY_REPOSITORY}/${IMAGE_NAME}:${RELEASE_VERSION}"

echo "[RELEASE] Installing locked dependencies and running pre-release verification..."
npm ci
npm run lint
npm test
docker build --pull --target runtime --tag "$IMAGE_TAG_URI" .

gcloud config set project "$GCP_PROJECT_ID" >/dev/null
gcloud auth configure-docker "${GCP_REGION}-docker.pkg.dev" --quiet
gcloud artifacts repositories describe "$ARTIFACT_REGISTRY_REPOSITORY" \
  --project "$GCP_PROJECT_ID" \
  --location "$GCP_REGION" >/dev/null

if gh release view "$RELEASE_TAG" >/dev/null 2>&1; then
  echo "[RELEASE ERROR] GitHub release ${RELEASE_TAG} already exists." >&2
  exit 1
fi
if [ -n "$(git ls-remote --tags origin "refs/tags/${RELEASE_TAG}")" ]; then
  echo "[RELEASE ERROR] Remote tag ${RELEASE_TAG} already exists." >&2
  exit 1
fi

echo "[RELEASE] Publishing GitHub source release ${RELEASE_TAG}..."
gh release create "$RELEASE_TAG" --target "$RELEASE_COMMIT" --title "$RELEASE_TAG" --generate-notes

echo "[RELEASE] Pushing the versioned image to Artifact Registry..."
docker push "$IMAGE_TAG_URI"
IMAGE_DIGEST="$(gcloud artifacts docker images describe "$IMAGE_TAG_URI" --project "$GCP_PROJECT_ID" --format='value(image_summary.digest)')"
if [[ ! "$IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "[RELEASE ERROR] Could not resolve an immutable image digest from Artifact Registry." >&2
  exit 1
fi
IMMUTABLE_IMAGE_URI="${IMAGE_TAG_URI%:*}@${IMAGE_DIGEST}"

echo "[RELEASE] Running the production migration job..."
gcloud run jobs deploy "$MIGRATION_JOB_NAME" \
  --project "$GCP_PROJECT_ID" \
  --region "$GCP_REGION" \
  --image "$IMMUTABLE_IMAGE_URI" \
  --command node \
  --args dist-server/src/api/db/migrate.js \
  --service-account "$CLOUD_RUN_SERVICE_ACCOUNT" \
  --set-env-vars NODE_ENV=production \
  --set-secrets "DATABASE_URL=${DATABASE_URL_SECRET_NAME}:latest" \
  --set-cloudsql-instances "$CLOUD_SQL_CONNECTION_NAME" \
  --tasks 1 \
  --max-retries 0 \
  --task-timeout 600
gcloud run jobs execute "$MIGRATION_JOB_NAME" --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --wait

rendered_service="$(mktemp)"
trap 'rm -f "$rendered_service"' EXIT
IMAGE_URI="$IMMUTABLE_IMAGE_URI" node scripts/render-cloudrun.mjs cloudrun.service.yaml "$rendered_service"

echo "[RELEASE] Deploying the Cloud Run service..."
gcloud run services replace "$rendered_service" --project "$GCP_PROJECT_ID" --region "$GCP_REGION"

echo "[RELEASE] Checking the public load-balanced readiness endpoint..."
curl --fail --silent --show-error "${PUBLIC_API_URL%/}/api/v1/health/ready"
printf '\n[RELEASE] v%s deployed as %s\n' "$RELEASE_VERSION" "$IMMUTABLE_IMAGE_URI"
echo "[RELEASE] Rollback: gcloud run services update-traffic ${SERVICE_NAME} --project ${GCP_PROJECT_ID} --region ${GCP_REGION} --to-revisions=<PREVIOUS_KNOWN_GOOD_REVISION>=100"
