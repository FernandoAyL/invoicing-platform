# Runtime identities. `run` is the service account the Cloud Run service AND the migration job
# both run as (same identity — both need Cloud SQL + secret access, nothing else); `scheduler` is
# a distinct, narrower identity used only to invoke the service (granted `run.invoker` in
# cloud_run.tf, nothing more).
resource "google_service_account" "run" {
  account_id   = "${var.project_name}-run"
  display_name = "${var.project_name} Cloud Run runtime"
}

resource "google_service_account" "scheduler" {
  account_id   = "${var.project_name}-scheduler"
  display_name = "${var.project_name} Cloud Scheduler invoker"
}

# Lets the runtime SA open the Cloud SQL connector's tunnel to the instance. Secret access is
# granted per-secret in secrets.tf instead of a blanket project role.
resource "google_project_iam_member" "run_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.run.email}"
}
