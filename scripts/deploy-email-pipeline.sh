#!/usr/bin/env bash
set -euo pipefail

STACK_NAME=${STACK_NAME:-furt-money-email-ingestion}
RULE_SET_NAME=${RULE_SET_NAME:-inbox-furt-money-rule-set}
RECIPIENT_DOMAIN=${RECIPIENT_DOMAIN:-inbox.furt.money}
TEMPLATE_PATH=${TEMPLATE_PATH:-infra/ses-lambda-pipeline.yaml}
HOSTED_ZONE_ID=${HOSTED_ZONE_ID:-}

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

empty_inbound_bucket() {
  local bucket_name
  bucket_name=$(aws cloudformation list-stack-resources --stack-name "$STACK_NAME" \
    --query "StackResourceSummaries[?LogicalResourceId=='InboundEmailBucket'].PhysicalResourceId" \
    --output text 2>/dev/null || true)

  if [[ -n "$bucket_name" && "$bucket_name" != "None" ]]; then
    echo "Emptying S3 bucket s3://$bucket_name before stack deletion..." >&2
    aws s3 rm "s3://$bucket_name" --recursive >/dev/null 2>&1 || true
  fi
}

existing_status=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)

if [[ "$existing_status" == "ROLLBACK_COMPLETE" || "$existing_status" == "ROLLBACK_FAILED" || "$existing_status" == "DELETE_FAILED" ]]; then
  echo "Stack $STACK_NAME is stuck in status $existing_status. Cleaning up before redeploy..." >&2
  empty_inbound_bucket
  aws cloudformation delete-stack --stack-name "$STACK_NAME"
  aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
fi

cat <<INFO
Deploying SES -> S3 -> Lambda pipeline
  Stack Name      : $STACK_NAME
  Template Path   : $TEMPLATE_PATH
  Rule Set Name   : $RULE_SET_NAME
  Recipient Domain: $RECIPIENT_DOMAIN
  Hosted Zone ID  : ${HOSTED_ZONE_ID:-<none>}
INFO

set -x
deploy_args=(
  --stack-name "$STACK_NAME"
  --template-file "$TEMPLATE_PATH"
  --capabilities CAPABILITY_NAMED_IAM
  --parameter-overrides
    RuleSetName="$RULE_SET_NAME"
    RecipientDomain="$RECIPIENT_DOMAIN"
)

if [[ -n "$HOSTED_ZONE_ID" ]]; then
  deploy_args+=(HostedZoneId="$HOSTED_ZONE_ID")
fi

aws cloudformation deploy "${deploy_args[@]}"
set +x

echo "Deployment finished." 
