# Docker image repo CD pushes to (see .github/workflows/deploy.yml). Equivalent to the old ECR
# repo's IMMUTABLE + lifecycle-rule setup: cleanup_policies here keeps the most recent 20 images
# instead of a raw count-based lifecycle rule (Artifact Registry's native mechanism for it).
resource "google_artifact_registry_repository" "app" {
  repository_id = "${var.project_name}-api"
  location      = var.region
  format        = "DOCKER"

  depends_on = [google_project_service.required]

  cleanup_policies {
    id     = "keep-most-recent-20"
    action = "KEEP"
    most_recent_versions {
      keep_count = 20
    }
  }
}
