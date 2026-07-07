# Local state, deliberately separate from infra/terraform/terraform.tfstate:
# this stack is applied once (or on the rare change to CI's trust/permissions),
# by hand, with admin/root credentials — never by the role it creates, and
# never by the narrower terraform-deployer IAM user used for infra/terraform.
terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}
