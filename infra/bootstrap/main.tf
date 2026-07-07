# Bootstrap stack: creates the GitHub OIDC provider and the role GitHub
# Actions assumes for both CD app-deploys and infra/terraform changes. Its own
# state, applied separately from (and before) infra/terraform — see README.md
# for why this can't be delegated to the scoped terraform-deployer IAM user.

variable "aws_region" {
  description = "AWS region (only used for provider config; the resources here are global/IAM)."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "invoicing"
}

variable "github_repo" {
  description = "GitHub repo allowed to assume the role, as owner/repo."
  type        = string
  default     = "FernandoAyL/invoicing-platform"
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project_name
      ManagedBy = "terraform"
      Stack     = "bootstrap"
    }
  }
}
