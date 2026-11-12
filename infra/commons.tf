# commons: Groups Commons prototype (shared materials for AI safety university groups).
# One Cloud Run service; records in Postgres (Cloud SQL, since 2026-11-12; before that a named Firestore database,
# which is kept), files in a private bucket,
# Vertex AI for semantic search (embeddings) and the printable -> template conversion (Gemini).
# Source: ~/Documents/programming/groups-commons. Deploy: build the image, set it in images.auto.tfvars, plan, apply.

locals {
  commons_project = "cs-project-tvcmny79"
  commons_region  = "us-central1"
  commons_labels  = { app = "commons", purpose = "quota-building" }
}

resource "google_service_account" "commons_web" {
  project      = local.commons_project
  account_id   = "commons-web"
  display_name = "Groups Commons web (Cloud Run)"
}

# ---- data ------------------------------------------------------------------------------------------------------------
resource "google_firestore_database" "commons" {
  project                           = local.commons_project
  name                              = "commons"
  location_id                       = local.commons_region
  type                              = "FIRESTORE_NATIVE"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  deletion_policy                   = "ABANDON"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
}

resource "google_project_iam_member" "commons_datastore" {
  project = local.commons_project
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.commons_web.email}"
  condition {
    title      = "commons database only"
    expression = "resource.name.startsWith(\"projects/cs-project-tvcmny79/databases/commons\")"
  }
}

# Uploaded materials. Private: the service streams files itself (with sandboxing headers for HTML and SVG).
resource "google_storage_bucket" "commons" {
  project                     = local.commons_project
  name                        = "cs-project-tvcmny79-commons"
  location                    = upper(local.commons_region)
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = local.commons_labels
  # A replaced or deleted file stays as an older version for 30 days (restore: see the README), then goes for good.
  versioning {
    enabled = true
  }
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
      with_state                 = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }
}

resource "google_storage_bucket_iam_member" "commons_object_admin" {
  bucket = google_storage_bucket.commons.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.commons_web.email}"
}

# Embeddings and Gemini calls.
resource "google_project_iam_member" "commons_vertex" {
  project = local.commons_project
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.commons_web.email}"
}

# ---- Postgres (Cloud SQL): the system of record for item records, votes, accounts, sites and the file index ------------
# File bytes stay in the bucket above (object storage costs about a tenth of database disk per GB).
# Smallest shared-core instance, about USD 10 a month with its disk. To scale, raise `tier` (for example
# db-custom-1-3840) and, for failover, set availability_type = "REGIONAL"; both are in-place changes with a short restart.
resource "google_project_service" "commons_sqladmin" {
  project            = local.commons_project
  service            = "sqladmin.googleapis.com"
  disable_on_destroy = false
}

# Calls made with a person's credentials (tofu, gcloud) are counted against the ops project, so the API is on there too.
resource "google_project_service" "commons_sqladmin_ops" {
  project            = "your-ops-project"
  service            = "sqladmin.googleapis.com"
  disable_on_destroy = false
}

# The database lives on an address range that is reserved in the default network and handed to Google's managed services.
data "google_compute_network" "commons_default" {
  project = local.commons_project
  name    = "default"
}

resource "google_project_service" "commons_servicenetworking" {
  project            = local.commons_project
  service            = "servicenetworking.googleapis.com"
  disable_on_destroy = false
}

resource "google_compute_global_address" "commons_sql_range" {
  project       = local.commons_project
  name          = "commons-sql-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = data.google_compute_network.commons_default.id
  labels        = local.commons_labels
}

resource "google_service_networking_connection" "commons_sql" {
  network                 = data.google_compute_network.commons_default.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.commons_sql_range.name]
  depends_on              = [google_project_service.commons_servicenetworking]
}

resource "google_sql_database_instance" "commons" {
  project             = local.commons_project
  name                = "commons-pg"
  region              = local.commons_region
  database_version    = "POSTGRES_17"
  deletion_protection = true
  settings {
    edition                     = "ENTERPRISE" # shared-core tiers exist only in this edition
    tier                        = "db-f1-micro"
    availability_type           = "ZONAL"
    disk_type                   = "PD_SSD"
    disk_size                   = 10
    disk_autoresize             = true
    deletion_protection_enabled = true
    user_labels                 = local.commons_labels
    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 7
      }
    }
    ip_configuration {
      # Private address only (the org forbids public ones on databases). Cloud Run reaches it through Direct VPC
      # egress, which costs nothing extra; nothing outside the network can connect.
      ipv4_enabled                                  = false
      private_network                               = data.google_compute_network.commons_default.id
      enable_private_path_for_google_cloud_services = true
      ssl_mode                                      = "ENCRYPTED_ONLY"
    }
    maintenance_window {
      day  = 7
      hour = 4
    }
  }
  depends_on = [google_project_service.commons_sqladmin, google_project_service.commons_sqladmin_ops, google_service_networking_connection.commons_sql]
}

resource "google_sql_database" "commons" {
  project  = local.commons_project
  instance = google_sql_database_instance.commons.name
  name     = "commons"
}

resource "google_project_iam_member" "commons_cloudsql" {
  project = local.commons_project
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.commons_web.email}"
}

# Database password of the user "commons". Secret and user are created with gcloud, so the value never touches tofu:
#   openssl rand -base64 36 | tr -d '\n/+=' | gcloud secrets create commons-db-password --project cs-project-tvcmny79 \
#     --replication-policy=automatic --labels=app=commons,purpose=quota-building --data-file=-
#   gcloud sql users create commons --instance commons-pg --project cs-project-tvcmny79 \
#     --password "$(gcloud secrets versions access latest --secret commons-db-password --project cs-project-tvcmny79)"
import {
  to = google_secret_manager_secret.commons_db_password
  id = "projects/cs-project-tvcmny79/secrets/commons-db-password"
}

resource "google_secret_manager_secret" "commons_db_password" {
  project   = local.commons_project
  secret_id = "commons-db-password"
  labels    = local.commons_labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "commons_db_password" {
  project   = local.commons_project
  secret_id = google_secret_manager_secret.commons_db_password.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.commons_web.email}"
}

# ---- moderator token (created with gcloud together with its first version, so the value never touches tofu) ------------
import {
  to = google_secret_manager_secret.commons_admin_token
  id = "projects/cs-project-tvcmny79/secrets/commons-admin-token"
}

resource "google_secret_manager_secret" "commons_admin_token" {
  project   = local.commons_project
  secret_id = "commons-admin-token"
  labels    = local.commons_labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "commons_admin_token" {
  project   = local.commons_project
  secret_id = google_secret_manager_secret.commons_admin_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.commons_web.email}"
}

# ---- session secret (signs sign-in sessions, preview links and file keys; created with gcloud like the moderator token) -
# Before the first apply with this block, create the secret and its first version by hand (the value never touches tofu):
#   openssl rand -base64 48 | tr -d '\n' | gcloud secrets create commons-session-secret --project cs-project-tvcmny79 \
#     --replication-policy=automatic --labels=app=commons,purpose=quota-building --data-file=-
# Until now sessions were signed with a key derived from the moderator token, so everyone is signed out once.
import {
  to = google_secret_manager_secret.commons_session_secret
  id = "projects/cs-project-tvcmny79/secrets/commons-session-secret"
}

resource "google_secret_manager_secret" "commons_session_secret" {
  project   = local.commons_project
  secret_id = "commons-session-secret"
  labels    = local.commons_labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "commons_session_secret" {
  project   = local.commons_project
  secret_id = google_secret_manager_secret.commons_session_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.commons_web.email}"
}

variable "commons_secrets_rotated" {
  description = "Date of the last rotation of the moderator token or session secret. Changing it rolls out a new revision."
  type        = string
  default     = "2026-11-12"
}

# ---- service ---------------------------------------------------------------------------------------------------------
resource "google_cloud_run_v2_service" "commons_web" {
  project              = local.commons_project
  location             = local.commons_region
  name                 = "commons-web"
  deletion_protection  = true
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true
  launch_stage         = "GA"
  labels               = local.commons_labels
  scaling {
    max_instance_count = 3
    min_instance_count = 1 # no cold start (LibreOffice makes the image large); about USD 20 a month while idle
  }
  template {
    labels                           = local.commons_labels
    service_account                  = google_service_account.commons_web.email
    max_instance_request_concurrency = 40
    timeout                          = "300s" # a conversion can take a few minutes
    # The database has a private address only: the service gets a foot in the default network (no connector to pay for).
    vpc_access {
      network_interfaces {
        network    = "default"
        subnetwork = "default"
      }
      egress = "PRIVATE_RANGES_ONLY"
    }
    containers {
      image = var.images["commons-web"]
      ports {
        container_port = 8080
        name           = "http1"
      }
      resources {
        cpu_idle          = true
        startup_cpu_boost = true
        limits = {
          cpu    = "1"
          memory = "2Gi" # LibreOffice (Office file previews) needs the headroom
        }
      }
      # /api/health answers 200 only when the database and the bucket answer. A new revision that cannot reach its data
      # therefore never takes traffic (the old one keeps serving), and an instance that lost them for two minutes
      # is replaced.
      startup_probe {
        http_get {
          path = "/api/health"
          port = 8080
        }
        initial_delay_seconds = 0
        period_seconds        = 10
        failure_threshold     = 12
        timeout_seconds       = 5
      }
      liveness_probe {
        http_get {
          path = "/api/health"
          port = 8080
        }
        period_seconds    = 30
        failure_threshold = 4
        timeout_seconds   = 5
      }
      env {
        name  = "STORE"
        value = "pg" # records in Postgres, file bytes in the bucket. "gcp" was Firestore (kept as it was on the day of the move)
      }
      env {
        name  = "CLOUDSQL_INSTANCE"
        value = google_sql_database_instance.commons.connection_name
      }
      env {
        name  = "CLOUDSQL_IP_TYPE"
        value = "PRIVATE"
      }
      env {
        name  = "PGDATABASE"
        value = google_sql_database.commons.name
      }
      env {
        name  = "PGUSER"
        value = "commons"
      }
      env {
        name = "PGPASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.commons_db_password.secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "BUCKET"
        value = google_storage_bucket.commons.name
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = local.commons_project
      }
      env {
        name  = "VERTEX"
        value = "1"
      }
      env {
        name = "ADMIN_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.commons_admin_token.secret_id
            version = "latest"
          }
        }
      }
      # Secrets are read as "latest" when an instance starts. After adding a secret version, change this value
      # (for example to the date) and apply: the new revision starts with the new versions.
      env {
        name  = "SECRETS_ROTATED"
        value = var.commons_secrets_rotated
      }
      env {
        name = "SESSION_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.commons_session_secret.secret_id
            version = "latest"
          }
        }
      }
    }
  }
  traffic {
    percent = 100
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
  }
  lifecycle {
    ignore_changes = [client, client_version]
  }
  depends_on = [
    google_project_iam_member.commons_datastore,
    google_project_iam_member.commons_vertex,
    google_storage_bucket_iam_member.commons_object_admin,
    google_secret_manager_secret_iam_member.commons_admin_token,
    google_secret_manager_secret_iam_member.commons_session_secret,
    google_secret_manager_secret_iam_member.commons_db_password,
    google_project_iam_member.commons_cloudsql,
  ]
}

output "commons_url" {
  value = google_cloud_run_v2_service.commons_web.uri
}

# ---- monitoring: an uptime check on the health endpoint and an alert when it fails ------------------------------------
variable "commons_alert_channels" {
  description = "Notification channels (projects/<project>/notificationChannels/<id>) that are told when Groups Commons is down."
  type        = list(string)
  default     = [] # without a channel the alert only shows as an incident in Cloud Monitoring
}

resource "google_monitoring_uptime_check_config" "commons_health" {
  project      = local.commons_project
  display_name = "commons-web /api/health"
  timeout      = "10s"
  period       = "300s"
  user_labels  = local.commons_labels
  http_check {
    path         = "/api/health"
    port         = 443
    use_ssl      = true
    validate_ssl = true
    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }
  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = local.commons_project
      host       = trimprefix(google_cloud_run_v2_service.commons_web.uri, "https://")
    }
  }
  content_matchers {
    content = "\"ok\":true"
    matcher = "CONTAINS_STRING"
  }
}

resource "google_monitoring_alert_policy" "commons_down" {
  project               = local.commons_project
  display_name          = "Groups Commons is down"
  combiner              = "OR"
  notification_channels = var.commons_alert_channels
  user_labels           = local.commons_labels
  conditions {
    display_name = "/api/health fails from at least two regions for five minutes"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.commons_health.uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "300s"
      aggregations {
        alignment_period     = "1200s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.*"]
      }
      trigger {
        count = 1
      }
    }
  }
  documentation {
    mime_type = "text/markdown"
    content   = "The uptime check on `/api/health` of the Cloud Run service `commons-web` fails: the service is down or cannot reach Firestore or its bucket. Logs: Cloud Run > commons-web > Logs, filter `severity>=ERROR`. See \"Running it\" in the README of groups-commons."
  }
}
