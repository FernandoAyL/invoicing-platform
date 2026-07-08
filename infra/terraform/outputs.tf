# Everything CD (.github/workflows/deploy.yml) needs as GitHub Actions repo `vars` — copy these
# values in directly. See README.md ## Wiring into CD.
output "region" {
  value = var.region
}

output "project_id" {
  value = var.project_id
}

output "artifact_registry_repository" {
  value = google_artifact_registry_repository.app.repository_id
}

output "cloud_run_service_name" {
  value = google_cloud_run_v2_service.api.name
}

output "cloud_run_service_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "cloud_run_migrate_job_name" {
  value = google_cloud_run_v2_job.migrate.name
}

output "run_service_account_email" {
  value = google_service_account.run.email
}

output "firebase_site_id" {
  value = google_firebase_hosting_site.app.site_id
}
