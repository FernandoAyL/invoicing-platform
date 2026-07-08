# Drives the outbound retry sweep now that Cloud Run scales to zero and the in-process timer is
# switched off (SYNC_RETRY_ENABLED=false in cloud_run.tf). One Scheduler job is free (three per
# billing account). Auth is a shared-secret header — the same value stored in the sweep_token
# secret the app reads — not OIDC-via-scheduler-SA, since the app authenticates the header itself
# (see apps/api/src/routes/internal.ts); the scheduler SA's run.invoker grant (cloud_run.tf) still
# satisfies Cloud Run's own ingress check.
resource "google_cloud_scheduler_job" "retry_sweep" {
  name     = "${var.project_name}-retry-sweep"
  region   = var.region
  schedule = "*/2 * * * *"

  depends_on = [google_project_service.required]

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.api.uri}/internal/retry-sweep"
    headers = {
      "X-Sweep-Token" = random_password.sweep.result
    }
  }
}
