# Secret Manager — the GCP analog of the old SSM Parameter Store secrets. Each secret is a
# `google_secret_manager_secret` + one `_version` holding the actual value, with the runtime
# service account (iam.tf) granted `secretAccessor` on it so Cloud Run can mount it as an env var
# (cloud_run.tf's `env { value_source { secret_key_ref } }`).
#
# QBO secrets (client secret, webhook verifier token) stay deferred, same as the AWS stack — add
# them later under this exact pattern: a secret + version + a matching
# `google_secret_manager_secret_iam_member` grant.
resource "random_password" "session" {
  length  = 32
  special = false
}

resource "random_password" "sweep" {
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
