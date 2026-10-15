#!/usr/bin/env bash
set -euo pipefail

# Firebase/GCP deploy helper for Chore-app
# Usage:
#   PROJECT_ID=your-project-id APP_HOST=https://your-app.web.app APP_SECRET=... EMAIL_FROM=noreply@yourdomain.com bash scripts/deploy-firebase.sh
# Optional values:
#   REGION=us-central1
#   GENERATIVE_API_KEY=...
#   SENDGRID_API_KEY=...
#   SKIP_SECRET_SETUP=1
#   SKIP_FIREBASE_INIT=1

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
APP_HOST="${APP_HOST:-}"
APP_SECRET="${APP_SECRET:-}"
EMAIL_FROM="${EMAIL_FROM:-noreply@yourdomain.com}"
GENERATIVE_API_KEY="${GENERATIVE_API_KEY:-}"
SENDGRID_API_KEY="${SENDGRID_API_KEY:-}"
SKIP_SECRET_SETUP="${SKIP_SECRET_SETUP:-0}"
SKIP_FIREBASE_INIT="${SKIP_FIREBASE_INIT:-0}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "PROJECT_ID is required. Example: PROJECT_ID=my-project bash scripts/deploy-firebase.sh"
  exit 1
fi

if [[ -z "$APP_HOST" ]]; then
  echo "APP_HOST is required. Example: APP_HOST=https://my-site.web.app bash scripts/deploy-firebase.sh"
  exit 1
fi

if [[ -z "$APP_SECRET" ]]; then
  echo "APP_SECRET is required. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is not installed or not on PATH. Install Google Cloud SDK first."
  exit 1
fi

if ! command -v firebase >/dev/null 2>&1; then
  echo "firebase CLI is not installed or not on PATH. Run: npm install -g firebase-tools"
  exit 1
fi

function ensure_secret() {
  local secret_name="$1"
  local secret_value="$2"

  if [[ -z "$secret_value" ]]; then
    echo "Skipping secret setup for $secret_name because no value was provided."
    return 0
  fi

  if ! gcloud secrets describe "$secret_name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "Creating secret: $secret_name"
    gcloud secrets create "$secret_name" --replication-policy="automatic" --project="$PROJECT_ID"
  fi

  echo "Adding secret version for: $secret_name"
  printf '%s' "$secret_value" | gcloud secrets versions add "$secret_name" --data-file=- --project="$PROJECT_ID"
}

function ensure_secret_access() {
  local secret_name="$1"
  local service_account="$2"

  gcloud secrets add-iam-policy-binding "$secret_name" \
    --member="serviceAccount:${service_account}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT_ID" \
    >/dev/null
}

SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-$PROJECT_ID@appspot.gserviceaccount.com}"

if [[ "$SKIP_SECRET_SETUP" != "1" ]]; then
  ensure_secret "generative-api-key" "$GENERATIVE_API_KEY"
  ensure_secret "sendgrid-api-key" "$SENDGRID_API_KEY"

  ensure_secret_access "generative-api-key" "$SERVICE_ACCOUNT"
  ensure_secret_access "sendgrid-api-key" "$SERVICE_ACCOUNT"
fi

gcloud services enable \
  cloudfunctions.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  cloudbuild.googleapis.com \
  iam.googleapis.com \
  runtimeconfig.googleapis.com \
  --project="$PROJECT_ID"

cd functions
npm install
cd ..

if [[ "$SKIP_FIREBASE_INIT" != "1" ]]; then
  firebase use "$PROJECT_ID" --project "$PROJECT_ID" || firebase use --add "$PROJECT_ID"
fi

# Deploy functions with a secret-backed configuration.
# If you prefer to use firebase functions config, set the values before this and remove the env variable flags below.
GEN_SECRET="projects/${PROJECT_ID}/secrets/generative-api-key/versions/latest"
SENDGRID_SECRET="projects/${PROJECT_ID}/secrets/sendgrid-api-key/versions/latest"

gcloud functions deploy api \
  --entry-point=api \
  --runtime=nodejs18 \
  --trigger-http \
  --region="$REGION" \
  --allow-unauthenticated \
  --set-env-vars="GENERATIVE_SECRET_NAME=${GEN_SECRET},SENDGRID_SECRET_NAME=${SENDGRID_SECRET},APP_HOST=${APP_HOST},EMAIL_FROM=${EMAIL_FROM},APP_SECRET=${APP_SECRET}" \
  --project="$PROJECT_ID"

firebase deploy --only firestore:rules --project="$PROJECT_ID"
firebase deploy --only hosting --project="$PROJECT_ID"

echo ""
echo "Deployment finished."
echo "Verify the following endpoints after deployment:"
echo "  - ${APP_HOST}/approve.html"
echo "  - https://${REGION}-${PROJECT_ID}.cloudfunctions.net/api/generate-chores"
echo "  - https://${REGION}-${PROJECT_ID}.cloudfunctions.net/api/create-approval-token"
echo "  - https://${REGION}-${PROJECT_ID}.cloudfunctions.net/api/approve-chore"
echo ""
echo "You still need to verify your SendGrid sender domain before production email can reliably reach inboxes."
