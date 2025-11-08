#!/usr/bin/env bash
set -euo pipefail

STACK_NAME=${STACK_NAME:-furt-money-email-ingestion}
RULE_SET_NAME=${RULE_SET_NAME:-inbox-furt-money-rule-set}
RECIPIENT_DOMAIN=${RECIPIENT_DOMAIN:-inbox.furt.money}
TEMPLATE_PATH=${TEMPLATE_PATH:-infra/ses-lambda-pipeline.yaml}

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required on the runner" >&2
  exit 1
fi

aws cloudformation deploy \
  --stack-name "$STACK_NAME" \
  --template-file "$TEMPLATE_PATH" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      RuleSetName="$RULE_SET_NAME" \
      RecipientDomain="$RECIPIENT_DOMAIN"
