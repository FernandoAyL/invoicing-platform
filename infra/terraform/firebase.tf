# Provisions the Firebase project + Hosting site only. Content is released separately by CD
# (`firebase deploy --only hosting`, reading the committed firebase.json) — see
# docs/design-decisions.md#deploy-and-iac-boundary and README.md ## The retry sweep for the same
# split applied to compute.
resource "google_firebase_project" "default" {
  provider = google-beta
  project  = var.project_id

  depends_on = [google_project_service.required]
}

resource "google_firebase_hosting_site" "app" {
  provider = google-beta
  project  = var.project_id
  site_id  = var.project_id

  depends_on = [google_firebase_project.default]
}
