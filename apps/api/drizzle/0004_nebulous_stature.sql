CREATE TABLE "payment_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"payment_txn_id" uuid NOT NULL,
	"invoice_txn_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_payment_txn_id_transactions_id_fk" FOREIGN KEY ("payment_txn_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_invoice_txn_id_transactions_id_fk" FOREIGN KEY ("invoice_txn_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_applications_payment_idx" ON "payment_applications" USING btree ("payment_txn_id");--> statement-breakpoint
CREATE INDEX "payment_applications_invoice_idx" ON "payment_applications" USING btree ("invoice_txn_id");