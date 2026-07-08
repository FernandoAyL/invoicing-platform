# Enables every Google Cloud API this stack's resources need, so a fresh project works from a
# single `apply` (the first run may take a few minutes while these propagate + Cloud SQL
# provisions). `disable_on_destroy = false`: tearing down this stack must never disable an API
# that some other project resource (or a human) still depends on.
locals {
  required_services = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudscheduler.googleapis.com",
    "iam.googleapis.com",
    "firebase.googleapis.com",
    "firebasehosting.googleapis.com",
    "serviceusage.googleapis.com",
  ]
}

resource "google_project_service" "required" {
  for_each = toset(local.required_services)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
