# Terraform (`30001`)

Provisions the standing AWS infrastructure: VPC (2 public subnets, no NAT),
RDS Postgres, an ECR repo, an ECS cluster + Fargate service, and the two IAM
roles the task needs. CD (`.github/workflows/deploy.yml`) owns app deploys on
top of this — see `docs/design-decisions.md#deploy-and-iac-boundary` for the
ownership split and why there's no Terraform in the deploy path.

## Applying

State is local (`terraform.tfstate`, gitignored) — this is a single-operator,
single-environment stack applied deliberately by hand, not from CI.

```
cd infra/terraform
terraform init
terraform plan
terraform apply
```

Requires AWS credentials in the environment (`aws configure` / `AWS_PROFILE`)
with permission to manage VPC, RDS, ECR, ECS, IAM roles, SSM parameters, and
CloudWatch Logs — a scoped `terraform-deployer` IAM user, not an admin account.

## Related: `../bootstrap/`

A separate stack (its own state) sets up the GitHub OIDC provider + role CD
assumes instead of long-lived access keys — see `../bootstrap/README.md`.
Independent of this stack; apply in either order.

## Bootstrapping

The ECS service needs a task definition before any image has ever been pushed
to ECR, so the initial container image is a public placeholder
(`var.bootstrap_image`). The task definition's `container_definitions` and the
service's `task_definition`/`desired_count` are all in `lifecycle.ignore_changes`
— after the first `apply`, CD registers every new revision and this Terraform
config never fights it (see `30005`).

## Wiring into CD (`30005`)

Run `terraform output` and copy these into the repo's GitHub Actions variables:

| Terraform output | GitHub Actions var |
|---|---|
| `aws_region` | `AWS_REGION` |
| `ecr_repository_url` | `ECR_REPOSITORY` (repo name portion) |
| `ecs_cluster_name` | `ECS_CLUSTER` |
| `ecs_service_name` | `ECS_SERVICE` |
| `ecs_task_family` | `ECS_TASK_FAMILY` |
| `ecs_container_name` | `ECS_CONTAINER_NAME` |
| `ecs_subnet_ids` | `ECS_SUBNET_IDS` |
| `ecs_security_group_id` | `ECS_SECURITY_GROUP_IDS` |

**Heads up for `30005`:** this VPC has no NAT gateway or VPC endpoints — a
Fargate task only reaches the internet (ECR pull, CloudWatch Logs, RDS) if it
has a public IP. `deploy.yml`'s one-off migration task currently sets
`assignPublicIp=DISABLED` on these same public subnets, which will hang
pulling the image. Flip it to `ENABLED` when wiring `30005`, or add ECR/S3/logs
VPC endpoints if the migration task should stay unreachable — the latter costs
more and isn't needed for a single-operator demo.

## Secrets (`30004`)

`DATABASE_URL` is already published as a SecureString SSM parameter
(`/invoicing/database_url`) and wired into the task definition's `secrets`,
since the DB credentials only exist because this same `apply` generated them.
QBO's client secret and webhook verifier token are deferred to `30004` — add
them under the same `/invoicing/*` prefix and reference them the same way in
the container's `secrets` list; the execution role's IAM policy already
allows reading anything under that prefix, no IAM change needed.
