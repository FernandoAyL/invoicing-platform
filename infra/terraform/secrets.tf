# Secret Manager — the GCP analog of the old SSM Parameter Store secrets. Each secret is a
# `google_secret_manager_secret` + one `_version` holding the actual value, with the runtime
# service account (iam.tf) granted `secretAccessor` on it so Cloud Run can mount it as an env var
# (cloud_run.tf's `env { value_source { secret_key_ref } }`).
#
# Three groups, by provenance:
#   1. Terraform-generated, always mounted (database_url, session_secret, sweep_token,
#      qbo_token_encryption_key below) — `random_password` values Terraform owns end to end, wired
#      into the service unconditionally regardless of `qbo_enabled`. The token-encryption key in
#      particular must exist before QBO is ever turned on, not conditionally on it (30020) — see
#      `qbo/token-crypto.ts` + `qbo/connection-service.ts`.
#   2. Terraform-generated, conditionally mounted — none currently; kept distinct from (1) in case
#      a future secret should only exist when `qbo_enabled`.
#   3. Out-of-band (QBO client secret, webhook verifier token, below) — values come from an
#      external Intuit app, so Terraform creates the secret containers + accessor grants but NOT
#      the versions; the values are added manually (never git/tfstate) and the service only
#      references them when `qbo_enabled` (cloud_run.tf). See README.md
#      ## Enabling the QuickBooks integration.
resource "random_password" "session" {
  length  = 32
  special = false
}

resource "random_password" "sweep" {
  length  = 32
  special = false
}

resource "random_password" "qbo_token_encryption" {
  length  = 32
  special = false
}

resource "google_secret_manager_secret" "database_url" {
  secret_id = "${var.project_name}-database-url"

  depends_on = [google_project_service.required]

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "database_url" {
  secret = google_secret_manager_secret.database_url.id
  # Unix-socket form node-postgres accepts — no host/port exposure, reached via the Cloud SQL
  # connector volume mount instead. See README.md ## Cloud SQL connectivity.
  secret_data = "postgresql://${google_sql_user.app.name}:${random_password.db.result}@/${google_sql_database.app.name}?host=/cloudsql/${google_sql_database_instance.main.connection_name}"
}

resource "google_secret_manager_secret" "session_secret" {
  secret_id = "${var.project_name}-session-secret"

  depends_on = [google_project_service.required]

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "session_secret" {
  secret      = google_secret_manager_secret.session_secret.id
  secret_data = random_password.session.result
}

resource "google_secret_manager_secret" "sweep_token" {
  secret_id = "${var.project_name}-sweep-token"

  depends_on = [google_project_service.required]

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "sweep_token" {
  secret      = google_secret_manager_secret.sweep_token.id
  secret_data = random_password.sweep.result
}

resource "google_secret_manager_secret" "qbo_token_encryption_key" {
  secret_id = "${var.project_name}-qbo-token-encryption-key"

  depends_on = [google_project_service.required]

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "qbo_token_encryption_key" {
  secret      = google_secret_manager_secret.qbo_token_encryption_key.id
  secret_data = random_password.qbo_token_encryption.result
}

resource "google_secret_manager_secret_iam_member" "database_url_access" {
  secret_id = google_secret_manager_secret.database_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run.email}"
}

resource "google_secret_manager_secret_iam_member" "session_secret_access" {
  secret_id = google_secret_manager_secret.session_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run.email}"
}

resource "google_secret_manager_secret_iam_member" "sweep_token_access" {
  secret_id = google_secret_manager_secret.sweep_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run.email}"
}

resource "google_secret_manager_secret_iam_member" "qbo_token_encryption_key_access" {
  secret_id = google_secret_manager_secret.qbo_token_encryption_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run.email}"
}

# ---- QBO integration secrets (containers only — values added out-of-band, see the comment above) ----

resource "google_secret_manager_secret" "qbo_client_secret" {
  secret_id = "${var.project_name}-qbo-client-secret"

  depends_on = [google_project_service.required]

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "qbo_webhook_verifier_token" {
  secret_id = "${var.project_name}-qbo-webhook-verifier-token"

  depends_on = [google_project_service.required]

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "qbo_client_secret_access" {
  secret_id = google_secret_manager_secret.qbo_client_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run.email}"
}

resource "google_secret_manager_secret_iam_member" "qbo_webhook_verifier_token_access" {
  secret_id = google_secret_manager_secret.qbo_webhook_verifier_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run.email}"
}
