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

# Bootstraps a valid initial revision before CD has ever pushed a real image — see
# docs/design-decisions.md#deploy-and-iac-boundary and README.md ## Bootstrapping the container
# image. The service/job's lifecycle.ignore_changes on their image means Terraform never fights CD
# over this after the first apply.
variable "bootstrap_image" {
  description = "Placeholder container image for the initial Cloud Run revision, replaced by the first CD deploy."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}
