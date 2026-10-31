#!/bin/sh
# Points a fixed address at a deployment: scripts/vercel-alias.sh <deploy url> <alias>.
# Calls Vercel's API directly: `vercel alias set` first looks up the token's
# user, which fails (404) for a token limited to the team. Needs VERCEL_TOKEN
# and VERCEL_ORG_ID (the team id) in the environment.
set -eu
host=${1#https://}
api=https://api.vercel.com
id=$(curl --fail-with-body -sS -H "Authorization: Bearer $VERCEL_TOKEN" \
  "$api/v13/deployments/$host?teamId=$VERCEL_ORG_ID" | sed -n 's/.*"id":"\(dpl_[A-Za-z0-9]*\)".*/\1/p' | head -n 1)
[ -n "$id" ] || { echo "Deployment $host not found"; exit 1; }
curl --fail-with-body -sS -X POST -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" -d "{\"alias\":\"$2\"}" \
  "$api/v2/deployments/$id/aliases?teamId=$VERCEL_ORG_ID"
echo
echo "Aliased $2 to $host"
