# Bootstrap Terraform — Workload Identity Federation for CI

Creates the **Workload Identity Federation** trust that GitHub Actions uses to authenticate to
Google Cloud without any long-lived service-account key:

- a **workload identity pool** + **provider** for GitHub's OIDC issuer
  (`https://token.actions.githubusercontent.com`), attribute-mapped and condition-scoped to this
  repo;
- a **deployer service account** (`invoicing-github-actions`) that CD impersonates;
- an IAM binding letting the repo's OIDC principal impersonate that SA
  (`roles/iam.workloadIdentityUser`).

The deployer SA is granted only what a release needs:

- **`roles/artifactregistry.writer`** — push the container image.
- **`roles/run.admin`** — deploy the Cloud Run service and update/execute the migration job.
- **`roles/iam.serviceAccountUser`** — act as the runtime service account when deploying.
- **`roles/firebasehosting.admin`** — publish the web bundle.

Nothing here can touch Terraform state or provision new infrastructure — same tight blast radius as
the app-deploy identity on the previous cloud.

## Why this is applied by hand, not by the identity it creates

Creating a workload identity pool/provider and a service account, and granting project-level IAM,
are themselves project-admin actions outside the deployer SA's scoped roles. Bootstrapping trust
has to start from an identity that is already trusted — i.e. a **project owner** running this once.
Everything downstream (CD, and any future `terraform apply` workflow) uses the identity this
creates instead.

```
cd infra/bootstrap
terraform init
terraform plan  -var project_id=<id> -var project_number=<number>   # run as a project owner
terraform apply -var project_id=<id> -var project_number=<number>
terraform output
```

`project_number` is required in addition to `project_id` because the workload-identity principal
set is addressed by project number. Find it with
`gcloud projects describe <project_id> --format='value(projectNumber)'`.

## What this does *not* replace

GitHub's OIDC token is only mintable inside a GitHub Actions job — there's no equivalent for a human
running `terraform apply` from a laptop. Local/manual applies against `infra/terraform` still use
your own `gcloud` application-default credentials, independent of this stack.

## Wiring into CI

Set these repo **variables** (used by `deploy.yml`) from this stack's outputs:

| Terraform output | GitHub Actions var |
|---|---|
| `workload_identity_provider` | `WIF_PROVIDER` |
| `deployer_service_account_email` | `DEPLOYER_SA` |

`deploy.yml` authenticates with `google-github-actions/auth` using
`workload_identity_provider: ${{ vars.WIF_PROVIDER }}` and
`service_account: ${{ vars.DEPLOYER_SA }}` — this stack is what makes that provider + SA valid.
