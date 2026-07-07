# Everything a future 30005 (wiring CD to this Terraform-managed infra) needs
# as GitHub Actions repo `vars` — copy these values in directly.

output "aws_region" {
  value = var.aws_region
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  value = aws_ecs_service.app.name
}

output "ecs_task_family" {
  value = aws_ecs_task_definition.app.family
}

output "ecs_container_name" {
  value = local.container_name
}

output "ecs_subnet_ids" {
  description = "Public subnets the Fargate service and CD's one-off migration task run in."
  value       = aws_subnet.public[*].id
}

output "ecs_security_group_id" {
  value = aws_security_group.ecs_task.id
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "database_url_ssm_parameter" {
  description = "SSM parameter name (SecureString) holding the full postgres:// connection string."
  value       = aws_ssm_parameter.database_url.name
}
