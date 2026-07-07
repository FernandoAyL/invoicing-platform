ALTER TABLE "sync_links" ALTER COLUMN "qbo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "last_error" text;