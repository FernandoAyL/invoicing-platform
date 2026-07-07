output "github_actions_role_arn" {
  description = "Set as CD_ROLE_ARN in the repo's GitHub Actions variables (used by deploy.yml and any future terraform-apply workflow)."
  value       = aws_iam_role.github_actions.arn
}

output "oidc_provider_arn" {
  value = aws_iam_openid_connect_provider.github_actions.arn
}
