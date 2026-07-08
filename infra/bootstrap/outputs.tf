# Set as WIF_PROVIDER / DEPLOYER_SA in the repo's GitHub Actions variables — see README.md
# ## Wiring into CI.
output "workload_identity_provider" {
  value = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_service_account_email" {
  value = google_service_account.github_actions.email
}
