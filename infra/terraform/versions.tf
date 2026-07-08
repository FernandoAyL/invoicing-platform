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

  # The Firebase Management API (google_firebase_project / _hosting_site) bills quota against a
  # user project and 403s "caller does not have permission" without one. This sends the caller's
  # quota project as X-Goog-User-Project — set it in ADC first:
  #   gcloud auth application-default set-quota-project <project_id>
  user_project_override = true
}
