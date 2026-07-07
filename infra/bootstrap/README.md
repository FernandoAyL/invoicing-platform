# Bootstrap Terraform (`30011`)

Creates the GitHub OIDC identity provider and a single IAM role
(`invoicing-github-actions`) that GitHub Actions assumes via
`aws-actions/configure-aws-credentials` — no long-lived AWS access keys stored
in the repo's secrets/variables. The role carries two policies:

- **`invoicing-cd-deploy`** — ECR push + `ecs:RegisterTaskDefinition` /
  `RunTask` / `UpdateService`, scoped to this project's repo/cluster/service
  (the `30009` scope: what `.github/workflows/deploy.yml` needs).
- **`invoicing-terraform-infra`** — the same permission set as the
  `terraform-deployer` IAM user (see `../terraform/README.md`), for a future
  workflow that runs `terraform plan`/`apply` against `infra/terraform`.

## Why this is applied by hand, not by the role it creates

Creating an IAM OIDC provider and an IAM role is itself an IAM-management
action outside the `terraform-deployer` user's scoped policy (`ec2`/`rds`/
`ecr`/`ecs`/`iam:*Role*` limited to `invoicing-*` roles it already knows
about — not "create arbitrary new roles/providers"). Bootstrapping trust has
to start from an identity that's already trusted, i.e. an AWS account
admin — that's why the plan you gave calls for authenticating as an
administrator (or the account root) for this one apply. Everything
downstream — CD, and eventually a terraform-apply workflow — uses the role
this creates instead.

```
cd infra/bootstrap
terraform init
terraform plan    # run as an AWS admin / root session
terraform apply
terraform output github_actions_role_arn
```

## What this does *not* replace

GitHub's OIDC token is only mintable inside a GitHub Actions job — there's no
equivalent for a human (or an assistant) running `terraform apply` from a
laptop. Local/manual applies against `infra/terraform` still go through the
separate `terraform-deployer` IAM user and its access key
(`../terraform/README.md`), independent of this stack.

## Wiring into CI

Set the repo variable used by `deploy.yml` (`CD_ROLE_ARN`) to the
`github_actions_role_arn` output. `deploy.yml` already assumes a role via
OIDC (`role-to-assume: ${{ vars.CD_ROLE_ARN }}`) — this stack is what makes
that ARN valid instead of a 404.
