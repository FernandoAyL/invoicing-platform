# Local backend (state file on the operator's machine) — appropriate for a
# single-operator, single-environment deploy. See ../README.md and
# docs/design-decisions.md#deploy-and-iac-boundary: Terraform is applied
# deliberately by hand on infra changes, never from CI.
terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project_name
      ManagedBy = "terraform"
    }
  }
}
