data "aws_caller_identity" "current" {}

# Trust any ref (branch/tag/PR) in the repo, not just `main`: PR-triggered
# workflows need to assume this role too (e.g. a future `terraform plan` on
# PR). `apply`/`deploy` being main-only is enforced at the workflow level
# (`if: github.ref == 'refs/heads/main'` in deploy.yml), not by this trust
# condition — the IAM boundary here is the permission set below, not the ref.
data "aws_iam_policy_document" "github_actions_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github_actions.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:*"]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name               = "${var.project_name}-github-actions"
  assume_role_policy = data.aws_iam_policy_document.github_actions_assume.json
}

# ---- CD app-deploy permissions (the 30009 scope): ECR push + register/run/update ECS ----

data "aws_iam_policy_document" "cd_deploy" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # this action does not support resource-level scoping
  }

  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:PutImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
    ]
    resources = ["arn:aws:ecr:${var.aws_region}:${data.aws_caller_identity.current.account_id}:repository/${var.project_name}-api"]
  }

  statement {
    sid       = "EcsRegisterAndDescribe"
    actions   = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"]
    resources = ["*"] # RegisterTaskDefinition does not support resource-level scoping
  }

  statement {
    sid     = "EcsRunAndUpdate"
    actions = ["ecs:RunTask", "ecs:UpdateService", "ecs:DescribeServices", "ecs:DescribeTasks"]
    resources = [
      "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:cluster/${var.project_name}-cluster",
      "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${var.project_name}-cluster/${var.project_name}-api",
      "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${var.project_name}-cluster/*",
      "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.project_name}-api:*",
    ]
  }

  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.project_name}-ecs-task*"]
  }
}

resource "aws_iam_role_policy" "cd_deploy" {
  name   = "${var.project_name}-cd-deploy"
  role   = aws_iam_role.github_actions.id
  policy = data.aws_iam_policy_document.cd_deploy.json
}

# ---- Terraform-apply permissions for infra/terraform (same scope as the
# terraform-deployer IAM user's policy, minus IAM OIDC-provider management,
# which stays out of automation's reach — see README.md) ----

data "aws_iam_policy_document" "terraform_infra" {
  statement {
    sid = "Ec2Networking"
    actions = [
      "ec2:DescribeAvailabilityZones",
      "ec2:DescribeAccountAttributes",
      "ec2:CreateVpc", "ec2:DeleteVpc", "ec2:DescribeVpcs", "ec2:DescribeVpcAttribute", "ec2:ModifyVpcAttribute",
      "ec2:CreateSubnet", "ec2:DeleteSubnet", "ec2:DescribeSubnets", "ec2:ModifySubnetAttribute",
      "ec2:CreateInternetGateway", "ec2:DeleteInternetGateway", "ec2:AttachInternetGateway",
      "ec2:DetachInternetGateway", "ec2:DescribeInternetGateways",
      "ec2:CreateRouteTable", "ec2:DeleteRouteTable", "ec2:DescribeRouteTables",
      "ec2:CreateRoute", "ec2:DeleteRoute", "ec2:AssociateRouteTable", "ec2:DisassociateRouteTable",
      "ec2:CreateSecurityGroup", "ec2:DeleteSecurityGroup", "ec2:DescribeSecurityGroups",
      "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress",
      "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress",
      "ec2:DescribeNetworkInterfaces",
      "ec2:CreateTags", "ec2:DeleteTags", "ec2:DescribeTags",
    ]
    resources = ["*"]
  }

  statement {
    sid = "Rds"
    actions = [
      "rds:CreateDBInstance", "rds:DeleteDBInstance", "rds:ModifyDBInstance", "rds:DescribeDBInstances",
      "rds:DescribeDBEngineVersions",
      "rds:CreateDBSubnetGroup", "rds:DeleteDBSubnetGroup", "rds:DescribeDBSubnetGroups",
      "rds:AddTagsToResource", "rds:RemoveTagsFromResource", "rds:ListTagsForResource",
    ]
    resources = ["*"]
  }

  statement {
    sid = "Ecr"
    actions = [
      "ecr:CreateRepository", "ecr:DeleteRepository", "ecr:DescribeRepositories",
      "ecr:PutLifecyclePolicy", "ecr:GetLifecyclePolicy", "ecr:DeleteLifecyclePolicy",
      "ecr:PutImageScanningConfiguration", "ecr:TagResource", "ecr:ListTagsForResource",
    ]
    resources = ["*"]
  }

  statement {
    sid = "EcsAdmin"
    actions = [
      "ecs:CreateCluster", "ecs:DeleteCluster", "ecs:DescribeClusters",
      "ecs:DeregisterTaskDefinition",
      "ecs:CreateService", "ecs:DeleteService",
      "ecs:TagResource", "ecs:ListTagsForResource",
    ]
    resources = ["*"]
  }

  statement {
    sid = "IamRoleManagement"
    actions = [
      "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole", "iam:TagRole",
      "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy", "iam:ListRolePolicies",
      "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:ListAttachedRolePolicies",
    ]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.project_name}-*"]
  }

  # First RDS/ECS resource in an account/region auto-creates its service-linked role.
  statement {
    sid       = "RdsServiceLinkedRole"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["arn:aws:iam::*:role/aws-service-role/rds.amazonaws.com/AWSServiceRoleForRDS*"]
    condition {
      test     = "StringLike"
      variable = "iam:AWSServiceName"
      values   = ["rds.amazonaws.com"]
    }
  }

  statement {
    sid       = "EcsServiceLinkedRole"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["arn:aws:iam::*:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS*"]
    condition {
      test     = "StringLike"
      variable = "iam:AWSServiceName"
      values   = ["ecs.amazonaws.com"]
    }
  }

  statement {
    sid = "Logs"
    actions = [
      "logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:DescribeLogGroups",
      "logs:PutRetentionPolicy", "logs:TagLogGroup", "logs:ListTagsForResource",
    ]
    resources = ["*"]
  }

  statement {
    sid = "SsmParameters"
    actions = [
      "ssm:PutParameter", "ssm:GetParameter", "ssm:GetParameters", "ssm:DeleteParameter",
      "ssm:AddTagsToResource", "ssm:ListTagsForResource",
    ]
    resources = ["arn:aws:ssm:*:*:parameter/${var.project_name}/*"]
  }

  # DescribeParameters doesn't support resource-level scoping (it's a
  # search/paginate API, not a per-parameter one).
  statement {
    sid       = "SsmDescribeParameters"
    actions   = ["ssm:DescribeParameters"]
    resources = ["*"]
  }

  statement {
    sid       = "KmsForSsmSecureString"
    actions   = ["kms:DescribeKey", "kms:ListAliases"]
    resources = ["*"]
  }

  statement {
    sid       = "CallerIdentity"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "terraform_infra" {
  name   = "${var.project_name}-terraform-infra"
  role   = aws_iam_role.github_actions.id
  policy = data.aws_iam_policy_document.terraform_infra.json
}
