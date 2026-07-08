variable "project_id" {
  description = "Google Cloud project id. No default — every apply must target an explicit project."
  type        = string
}

variable "region" {
  description = "Region for all regional resources (Cloud Run, Cloud SQL, Artifact Registry, Cloud Scheduler)."
  type        = string
  default     = "us-central1"
}

variable "project_name" {
  description = "Prefix used to name every resource (matches the repo, docker-compose defaults)."
  type        = string
  default     = "invoicing"
}

variable "container_port" {
  description = "Port the API listens on inside the container (matches Dockerfile EXPOSE / apps/api PORT)."
  type        = number
  default     = 8080
}

variable "db_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-f1-micro"
}

variable "db_disk_size" {
  description = "Cloud SQL disk size in GiB."
  type        = number
  default     = 10
}

variable "qbo_enabled" {
  description = "Wire the QuickBooks env vars + secrets into the Cloud Run service. Keep false until the Intuit credentials exist as secret versions in Secret Manager (see README.md ## Enabling the QuickBooks integration) — flipping this true while a version is missing fails the Cloud Run revision."
  type        = bool
  default     = false
}

variable "qbo_client_id" {
  description = "Intuit OAuth client id (not secret — injected as a plain env var). Only used when qbo_enabled = true."
  type        = string
  default     = ""
}

variable "qbo_redirect_uri" {
  description = "Intuit OAuth redirect URI; must match the Intuit app config and the deployed callback (e.g. https://<firebase-site>.web.app/api/integrations/qbo/callback). Only used when qbo_enabled = true."
  type        = string
  default     = ""
}

variable "qbo_environment" {
  description = "QBO environment: 'sandbox' or 'production'."
  type        = string
  default     = "sandbox"
}

# Bootstraps a valid initial revision before CD has ever pushed a real image — see
# docs/design-decisions.md#deploy-and-iac-boundary and README.md ## Bootstrapping the container
# image. The service/job's lifecycle.ignore_changes on their image means Terraform never fights CD
# over this after the first apply.
variable "bootstrap_image" {
  description = "Placeholder container image for the initial Cloud Run revision, replaced by the first CD deploy."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}
