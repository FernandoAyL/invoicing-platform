# Cloud SQL for PostgreSQL 17, db-f1-micro — the single largest line on the bill (see README.md
# ## Cost) and deliberately the only material one. Reached only through the Cloud Run built-in
# Cloud SQL connector (IAM + the `cloudsql-instances` attachment in cloud_run.tf), never a public
# IP with authorized networks — see README.md ## Cloud SQL connectivity.
resource "random_password" "db" {
  length  = 24
  special = false
}

resource "google_sql_database_instance" "main" {
  name             = "${var.project_name}-db"
  region           = var.region
  database_version = "POSTGRES_17"

  depends_on = [google_project_service.required]

  # A single-operator demo has no need to survive a full instance deletion protection cycle —
  # mirrors the old RDS stack's stance (no deletion protection there either).
  deletion_protection = false

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"
    disk_type         = "PD_SSD"
    disk_size         = var.db_disk_size

    ip_configuration {
      ipv4_enabled = true
      # No authorized_networks block: the public IP exists for the connector's use, not for
      # direct internet reachability — nothing is authorized to reach it except via the
      # connector/IAM path Cloud Run uses.
    }

    backup_configuration {
      enabled = true
    }
  }
}

resource "google_sql_database" "app" {
  name     = "invoicing"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "app" {
  name     = "invoicing"
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}
