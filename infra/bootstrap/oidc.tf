# Fetch the thumbprint live rather than hardcoding it: GitHub has rotated its
# OIDC issuer's intermediate CA before, and a stale hardcoded thumbprint just
# silently breaks every workflow's AssumeRoleWithWebIdentity call.
data "tls_certificate" "github_actions" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github_actions" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github_actions.certificates[0].sha1_fingerprint]

  tags = {
    Name = "${var.project_name}-github-actions"
  }
}
