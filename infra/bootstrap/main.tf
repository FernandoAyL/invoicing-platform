variable "project_id" {
  description = "Google Cloud project id. No default — every apply must target an explicit project."
  type        = string
}

variable "project_number" {
  description = "Google Cloud project number (the workload-identity principalSet is addressed by number, not id). Find it with `gcloud projects describe <project_id> --format='value(projectNumber)'`."
  type        = string
}

variable "region" {
  description = "Region (only used for provider config; the resources here are global/IAM)."
  type        = string
  default     = "us-central1"
}

variable "project_name" {
  type    = string
  default = "invoicing"
}

variable "github_repo" {
  description = "GitHub repo allowed to impersonate the deployer service account, as owner/repo."
  type        = string
  default     = "FernandoAyL/invoicing-platform"
}

provider "google" {
  project = var.project_id
  region  = var.region
}
