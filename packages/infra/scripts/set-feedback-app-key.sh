#!/usr/bin/env bash
#
# set-feedback-app-key.sh — provision (or rotate) the Argus feedback app-key.
#
# CloudFormation/CDK cannot create SSM SecureString parameters, so the secret
# value is owned by this script rather than the FeedbackStack. The script is the
# single source of truth: it writes the key to
#   1. SSM SecureString  /Argus/feedback/app-key   (read by the intake Lambda)
#   2. GitHub Actions secret ARGUS_FEEDBACK_APP_KEY (baked into release builds)
# Local dev builds read the same value via .envrc (which pulls it from SSM).
#
# The key only authorizes "write one feedback item" — low blast radius — so it
# lives as a plain app-key, and is safe to rotate at any time with --rotate.
#
# Usage:
#   ./set-feedback-app-key.sh            # create if absent, else reuse + resync
#   ./set-feedback-app-key.sh --rotate   # force-generate a new key
#
# Env overrides: AWS_PROFILE (default Argus), AWS_REGION (default us-east-1),
#                FEEDBACK_REPO (default gsulloa/argus).
set -euo pipefail

PROFILE="${AWS_PROFILE:-Argus}"
REGION="${AWS_REGION:-us-east-1}"
REPO="${FEEDBACK_REPO:-gsulloa/argus}"
PARAM="/Argus/feedback/app-key"
SECRET_NAME="ARGUS_FEEDBACK_APP_KEY"

rotate=false
[ "${1:-}" = "--rotate" ] && rotate=true

aws_ssm() { aws ssm "$@" --profile "$PROFILE" --region "$REGION"; }

# Resolve the key: reuse the existing SecureString unless --rotate, else mint one.
existing=""
if ! $rotate; then
  existing="$(aws_ssm get-parameter --name "$PARAM" --with-decryption \
    --query 'Parameter.Value' --output text 2>/dev/null || true)"
fi

if [ -n "$existing" ]; then
  KEY="$existing"
  echo "→ Reusing existing SSM key at $PARAM"
else
  KEY="$(openssl rand -hex 32)"
  echo "→ Generated a new app-key"
fi

# 1. SSM SecureString (source of truth for the Lambda + local .envrc).
aws_ssm put-parameter \
  --name "$PARAM" \
  --type SecureString \
  --value "$KEY" \
  --overwrite \
  --description "Argus feedback intake app-key (X-Argus-Feedback-Key header)" \
  >/dev/null
echo "✓ Wrote SecureString $PARAM ($REGION)"

# 2. GitHub Actions secret (baked into release builds via release.yml).
printf '%s' "$KEY" | gh secret set "$SECRET_NAME" --repo "$REPO"
echo "✓ Set GitHub secret $SECRET_NAME on $REPO"

echo ""
echo "Done. Local shells pick up ARGUS_FEEDBACK_APP_KEY from SSM on the next"
echo "direnv reload (the value is never written to .envrc in plaintext)."
