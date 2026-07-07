resource "random_password" "db" {
  length  = 24
  special = false # keep the password URL-safe since it's embedded in a postgres:// connection string
}

# RDS's supported minor versions shift over time (17.4 was pulled from
# us-east-1 after this was first written) — look up whatever 17.x minor is
# actually available instead of pinning one that can silently 400.
data "aws_rds_engine_version" "postgres" {
  engine             = "postgres"
  preferred_versions = ["17.6", "17.5", "17.4", "17.2", "17.1"]
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-db"
  subnet_ids = aws_subnet.public[*].id

  tags = {
    Name = "${var.project_name}-db"
  }
}

resource "aws_db_instance" "main" {
  identifier     = "${var.project_name}-db"
  engine         = "postgres"
  engine_version = data.aws_rds_engine_version.postgres.version

  instance_class    = var.db_instance_class
  allocated_storage = var.db_allocated_storage
  storage_encrypted = true

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  multi_az                = false
  backup_retention_period = 1
  skip_final_snapshot     = true
  apply_immediately       = true
  deletion_protection     = false

  tags = {
    Name = "${var.project_name}-db"
  }
}

# The one secret an ECS task absolutely cannot boot without (apps/api/src/config.ts
# hard-crashes if DATABASE_URL is missing). QBO client secret/webhook token are
# deferred to 30004 alongside a review of this parameter, but there's no reason
# to make this one wait — the DB credentials only exist because this same apply
# created them.
resource "aws_ssm_parameter" "database_url" {
  name  = "/${var.project_name}/database_url"
  type  = "SecureString"
  value = "postgres://${var.db_username}:${random_password.db.result}@${aws_db_instance.main.address}:5432/${var.db_name}"

  tags = {
    Name = "${var.project_name}-database-url"
  }
}
