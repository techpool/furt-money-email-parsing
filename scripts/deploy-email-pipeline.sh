#!/usr/bin/env bash
set -euo pipefail

STACK_NAME=${STACK_NAME:-furt-money-email-ingestion}
RULE_SET_NAME=${RULE_SET_NAME:-inbox-furt-money-rule-set}
RECIPIENT_DOMAIN=${RECIPIENT_DOMAIN:-inbox.furt.money}
TEMPLATE_PATH=${TEMPLATE_PATH:-infra/ses-lambda-pipeline.yaml}

on_error() {
  status=$?
  echo "CloudFormation deploy failed (exit code $status). Latest stack events:" >&2
  if command -v aws >/dev/null 2>&1; then
    if ! aws cloudformation describe-stack-events --stack-name "$STACK_NAME" --max-items 20 >&2; then
      echo "Unable to fetch stack events" >&2
    fi
  else
    echo "aws CLI unavailable, cannot fetch stack events" >&2
  fi
  exit $status
}

trap on_error ERR

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required on the runner" >&2
  exit 1
fi

cat <<INFO
Deploying SES -> S3 -> Lambda pipeline
  Stack Name      : $STACK_NAME
  Template Path   : $TEMPLATE_PATH
  Rule Set Name   : $RULE_SET_NAME
  Recipient Domain: $RECIPIENT_DOMAIN
INFO

set -x
aws cloudformation deploy \
  --stack-name "$STACK_NAME" \
  --template-file "$TEMPLATE_PATH" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      RuleSetName="$RULE_SET_NAME" \
      RecipientDomain="$RECIPIENT_DOMAIN"
set +x

echo "Deployment finished." 
