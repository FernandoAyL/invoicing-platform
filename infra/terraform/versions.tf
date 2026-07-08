# Local state, applied by hand (single-operator, single-environment) — see README.md and
# docs/design-decisions.md#deploy-and-iac-boundary.
terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

locals {
  default_labels = {
    project    = var.project_name
    managed_by = "terraform"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region

  default_labels = local.default_labels
}

provider "google-beta" {
  project = var.project_id
  region  = var.region

  default_labels = local.default_labels
}
