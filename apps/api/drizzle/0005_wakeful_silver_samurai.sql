CREATE TABLE "processed_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"realm_id" text NOT NULL,
	"entity_name" text NOT NULL,
	"entity_id" text NOT NULL,
	"operation" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_key_unique" UNIQUE("org_id","event_key")
);
--> statement-breakpoint
ALTER TABLE "processed_events" ADD CONSTRAINT "processed_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "processed_events_org_idx" ON "processed_events" USING btree ("org_id");