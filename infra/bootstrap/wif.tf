# Workload Identity Federation — lets GitHub Actions authenticate to Google Cloud with a
# short-lived, OIDC-derived credential instead of a long-lived service-account key. See README.md
# for the full narrative.
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "${var.project_name}-github"
  display_name              = "${var.project_name} GitHub Actions"

  depends_on = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "${var.project_name}-github"
  display_name                       = "${var.project_name} GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  attribute_condition = "assertion.repository == \"${var.github_repo}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "github_actions" {
  account_id   = "${var.project_name}-github-actions"
  display_name = "${var.project_name} GitHub Actions deployer"
}

resource "google_service_account_iam_member" "github_actions_wif" {
  service_account_id = google_service_account.github_actions.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}
