# CI/CD setup — GitHub Actions → Cloud Run

This repo deploys to Cloud Run via `.github/workflows/deploy.yml` on every push to `main` (or via manual `workflow_dispatch`). The workflow authenticates to GCP using **Workload Identity Federation** (WIF) — no JSON service-account keys live in the repo or in GitHub secrets.

You only run this setup once per GCP project. It takes ~5 minutes.

## What you get

- Push to `main` → Cloud Build builds all 7 service images → each Cloud Run service rolls forward → smoke-test on `gateway/health`
- Manual `workflow_dispatch` lets you redeploy a subset (`gateway,runner`) or skip the build phase entirely
- Auth via short-lived OIDC tokens; nothing long-lived stored anywhere

## One-time setup

Run these from your laptop with `gcloud` already authenticated as a project-owner-equivalent identity. Substitute `OWNER/REPO` with `sloweyyy/kally` (or your fork).

### 1. Set variables

```bash
export PROJECT_ID=kally-lab-a8e32b
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
export GH_OWNER=sloweyyy
export GH_REPO=kally

export POOL=gh-actions-pool
export PROVIDER=gh-actions
export DEPLOYER_SA="cd-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "$PROJECT_ID"
```

### 2. Enable the IAM Credentials API

```bash
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com
```

### 3. Create the deployer service account

This is the identity GitHub Actions will impersonate. It needs the minimum roles to build images and roll Cloud Run services forward.

```bash
gcloud iam service-accounts create cd-deployer \
  --display-name="GitHub Actions Cloud Run deployer"

# Roles needed:
#   roles/cloudbuild.builds.editor   — submit Cloud Build jobs
#   roles/run.admin                  — update + replace Cloud Run services
#   roles/artifactregistry.writer    — push to AR (Cloud Build does it via its own SA but
#                                      keeping this is harmless and lets `gcloud run` pull)
#   roles/iam.serviceAccountUser     — actAs the runtime SA the Cloud Run revisions use
#   roles/storage.admin              — Cloud Build needs to read/write its bucket; the deployer
#                                      uploads source via gcloud builds submit
for role in roles/cloudbuild.builds.editor roles/run.admin roles/artifactregistry.writer \
            roles/iam.serviceAccountUser roles/storage.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$DEPLOYER_SA" \
    --role="$role" --condition=None
done
```

### 4. Create the Workload Identity Pool + Provider

```bash
gcloud iam workload-identity-pools create "$POOL" \
  --location=global \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
  --location=global \
  --workload-identity-pool="$POOL" \
  --display-name="GitHub OIDC" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository_owner=='${GH_OWNER}'" \
  --issuer-uri="https://token.actions.githubusercontent.com"
```

### 5. Bind the deployer SA to the pool

This is what allows tokens minted by GitHub Actions for `${GH_OWNER}/${GH_REPO}` (and only that repo) to impersonate `cd-deployer`.

```bash
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_SA" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GH_OWNER}/${GH_REPO}"
```

### 6. Capture the values for GitHub

```bash
echo "GCP_WIF_PROVIDER:"
echo "  projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
echo
echo "GCP_DEPLOYER_SA:"
echo "  ${DEPLOYER_SA}"
```

### 7. Add the two values as GitHub repo secrets

Go to **Settings → Secrets and variables → Actions → Secrets** and add:

| Name | Value |
|---|---|
| `GCP_WIF_PROVIDER` | the provider path printed in step 6 |
| `GCP_DEPLOYER_SA` | `cd-deployer@kally-lab-a8e32b.iam.gserviceaccount.com` |

### 8. Verify

Trigger a manual run:

```bash
gh workflow run "Deploy to Cloud Run" --ref main
```

Or push a no-op commit on main and watch the auto-trigger.

## What the workflow does

1. Mints a GitHub OIDC token, exchanges it for short-lived GCP credentials via WIF
2. Runs `gcloud builds submit --config=cloudbuild.yaml` (7 service images) and `cloudbuild-opencode.yaml` (sidecar)
3. For each single-container service: `gcloud run services update <svc> --image=<repo>/<svc>:latest`
4. For runner (multi-container): describes the current spec, bumps the runner+opencode image tags via `scripts/deploy/render-runner-yaml.py`, applies via `gcloud run services replace`
5. Curls `gateway/health` until it returns 200, fails the job if it doesn't

## Manual triggers

```bash
# Deploy everything
gh workflow run "Deploy to Cloud Run" --ref main

# Deploy only gateway and runner
gh workflow run "Deploy to Cloud Run" --ref main -f services=gateway,runner

# Skip the build phase (use existing :latest tags — fast rollback or env-only change)
gh workflow run "Deploy to Cloud Run" --ref main -f skip_build=true
```

## Rollback

The workflow tags every image as `:latest`. To roll back:

```bash
# Find the previous image SHA
gcloud run revisions list --service=gateway --region=us-central1 --limit=5

# Pin the service to that revision
gcloud run services update-traffic gateway --region=us-central1 --to-revisions=gateway-00007-b9w=100
```

For full image rollback (rebuild the previous source), use `git revert <bad-sha>` and push to main — the workflow will rebuild from the reverted source.

## Troubleshooting

**`Permission 'iam.serviceAccounts.getAccessToken' denied`** — the WIF binding (step 5) is missing or has the wrong attribute. Re-run step 5 and verify with `gcloud iam service-accounts get-iam-policy $DEPLOYER_SA`.

**`Unauthenticated request`** in `actions/checkout` step — `permissions.id-token: write` missing from the workflow. Already present in `deploy.yml`; if you fork the workflow elsewhere, preserve it.

**Cloud Build fails with `permission denied on artifact registry`** — Cloud Build's default SA needs `roles/artifactregistry.writer`. Run:

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role=roles/artifactregistry.writer --condition=None
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role=roles/artifactregistry.writer --condition=None 2>/dev/null || true
```

**Runner deploy fails with `containers must be non-empty`** — the `gcloud run services describe runner --format=export` returned empty. Either the service was deleted, or the API is throttling. Re-run the workflow.
