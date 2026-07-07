variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Prefix used to name/tag every resource (matches the repo, docker-compose defaults)."
  type        = string
  default     = "invoicing"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "Two public subnet CIDRs across two AZs (RDS subnet groups require >= 2 AZs)."
  type        = list(string)
  default     = ["10.0.0.0/24", "10.0.1.0/24"]
}

variable "container_port" {
  description = "Port the API listens on inside the container (matches Dockerfile EXPOSE / apps/api PORT)."
  type        = number
  default     = 8080
}

variable "task_cpu" {
  description = "Fargate task-level vCPU units."
  type        = string
  default     = "256"
}

variable "task_memory" {
  description = "Fargate task-level memory (MiB)."
  type        = string
  default     = "512"
}

variable "desired_count" {
  description = "Number of Fargate tasks the service keeps running. The no-ALB/direct-public-IP design (see docs/architecture-decisions.md) only supports one task at a time."
  type        = number
  default     = 1
}

# Bootstraps a valid initial task definition before CD has ever pushed a real
# image — see docs/design-decisions.md#deploy-and-iac-boundary ("Terraform
# provides only the initial task def, CD registers revisions"). The service's
# lifecycle.ignore_changes on task_definition means Terraform never fights CD
# over this after the first apply.
variable "bootstrap_image" {
  description = "Placeholder container image for the initial task definition, replaced by the first CD deploy."
  type        = string
  default     = "public.ecr.aws/docker/library/hello-world:latest"
}

variable "db_name" {
  description = "RDS database name."
  type        = string
  default     = "invoicing"
}

variable "db_username" {
  description = "RDS master username."
  type        = string
  default     = "invoicing"
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "RDS allocated storage in GiB."
  type        = number
  default     = 20
}
