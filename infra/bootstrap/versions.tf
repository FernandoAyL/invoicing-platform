# Local state, deliberately separate from infra/terraform/terraform.tfstate — see README.md:
# this stack is applied once (or on the rare change to CI's trust/permissions) by a project owner,
# never by the identity it creates.
terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}
