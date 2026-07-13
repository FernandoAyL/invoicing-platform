# The Cloud Run service (API) and the one-off migration job, both running as the `run` service
# account and both reaching Postgres through the Cloud SQL connector volume (no public-IP/
# authorized-networks path — see cloud_sql.tf + README.md ## Cloud SQL connectivity).
#
# Both carry `lifecycle.ignore_changes` on their image: they boot from `var.bootstrap_image`
# (a public placeholder) until CD's first deploy, and Terraform must never fight CD over the tag
# it sets afterward — see README.md ## Bootstrapping the container image.
# QBO env, wired into the service only when `qbo_enabled` — empty lists otherwise, so a
# qbo_enabled=false apply adds no env and leaves the running service untouched. `config.qbo` needs
# CLIENT_ID + CLIENT_SECRET + REDIRECT_URI all set to become non-null; until then the QBO routes
# fail closed (503). See README.md ## Enabling the QuickBooks integration.
locals {
  qbo_plain_env = var.qbo_enabled ? [
    { name = "QUICKBOOKS_CLIENT_ID", value = var.qbo_client_id },
    { name = "QUICKBOOKS_REDIRECT_URI", value = var.qbo_redirect_uri },
    { name = "QUICKBOOKS_ENVIRONMENT", value = var.qbo_environment },
  ] : []

  qbo_secret_env = var.qbo_enabled ? [
    { name = "QUICKBOOKS_CLIENT_SECRET", secret = google_secret_manager_secret.qbo_client_secret.secret_id },
    { name = "QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN", secret = google_secret_manager_secret.qbo_webhook_verifier_token.secret_id },
  ] : []
}

resource "google_cloud_run_v2_service" "api" {
  name     = "${var.project_name}-api"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  # Single-operator demo — let Terraform replace/destroy the service (mirrors the Cloud SQL stance).
  # Defaults to true, which blocks the destroy half of any replacement.
  deletion_protection = false

  # The container reads DATABASE_URL from the `latest` secret version. Terraform only infers a
  # dependency on the secret itself (via secret_id), NOT its version, so without this the service
  # can be created before the version exists and its first revision fails SECRETS_ACCESS_CHECK.
  depends_on = [
    google_project_service.required,
    google_secret_manager_secret_version.database_url,
    google_secret_manager_secret_version.qbo_token_encryption_key,
  ]

  template {
    service_account = google_service_account.run.email

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      image = var.bootstrap_image

      ports {
        container_port = var.container_port
      }

      # Cheapest billing mode: `cpu_idle = true` bills CPU only while a request is being processed,
      # not for the whole time an instance is alive. This matters here because the every-2-minutes
      # Cloud Scheduler sweep keeps an instance warm almost continuously — with CPU "always
      # allocated" that would bill as a ~24/7 instance (~$45/mo); throttled, the brief per-request
      # CPU stays inside the free tier. The app needs no CPU between requests (the in-process timer
      # is off — SYNC_RETRY_ENABLED=false), so throttling is free of downside. 1 vCPU / 512Mi is the
      # default and is plenty for a Fastify API; `startup_cpu_boost` stays off (it costs extra).
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = false
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      # The in-process setInterval sweep stays off here — Cloud Scheduler drives
      # /internal/retry-sweep instead (see scheduler.tf and
      # docs/architecture-decisions.md#why-cloud-run-and-how-the-retry-sweep-survives-scale-to-zero).
      env {
        name  = "SYNC_RETRY_ENABLED"
        value = "false"
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "SESSION_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.session_secret.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "SYNC_SWEEP_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.sweep_token.secret_id
            version = "latest"
          }
        }
      }

      # Unconditional (not part of qbo_secret_env / qbo_enabled) — see secrets.tf's provenance
      # comment. Must be present before QBO is ever turned on, not conditionally on it.
      env {
        name = "QBO_TOKEN_ENCRYPTION_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.qbo_token_encryption_key.secret_id
            version = "latest"
          }
        }
      }

      dynamic "env" {
        for_each = local.qbo_plain_env
        content {
          name  = env.value.name
          value = env.value.value
        }
      }

      dynamic "env" {
        for_each = local.qbo_secret_env
        content {
          name = env.value.name
          value_source {
            secret_key_ref {
              secret  = env.value.secret
              version = "latest"
            }
          }
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }
  }

  # CD owns the image after the first apply (see README.md ## Bootstrapping the container image);
  # `client`/`client_version` are stamped by whatever last applied (Terraform locally vs. gcloud
  # in CD) and must not cause perpetual diffs either.
  lifecycle {
    ignore_changes = [
      client,
      client_version,
      template[0].containers[0].image,
    ]
  }
}

# Public: the QBO webhook and the Firebase Hosting rewrite both need unauthenticated access.
# Auth for the sensitive /internal/retry-sweep route is the shared-secret header, not IAM.
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "scheduler_invoker" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_run_v2_job" "migrate" {
  name     = "${var.project_name}-migrate"
  location = var.region

  deletion_protection = false

  # Same secret-version ordering guard as the service above.
  depends_on = [
    google_project_service.required,
    google_secret_manager_secret_version.database_url,
  ]

  template {
    template {
      service_account = google_service_account.run.email

      containers {
        image   = var.bootstrap_image
        command = ["pnpm", "--filter", "@invoicing/api", "db:migrate"]

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.database_url.secret_id
              version = "latest"
            }
          }
        }

        # config.ts validates ALL required env at import time, so `db:migrate` (which imports it
        # transitively) needs SESSION_SECRET present even though the migrator never uses it.
        env {
          name = "SESSION_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.session_secret.secret_id
              version = "latest"
            }
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.main.connection_name]
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
    ]
  }
}
