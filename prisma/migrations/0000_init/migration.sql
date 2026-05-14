-- CreateEnum
CREATE TYPE "PlateSize" AS ENUM ('SIZE_560_670', 'SIZE_630_700');

-- CreateEnum
CREATE TYPE "PastingStyle" AS ENUM ('LOCK_BOTTOM', 'BSO', 'SPECIAL');

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "role_name" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,
    "wastage_approve_limit_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "can_approve_artwork" BOOLEAN NOT NULL DEFAULT false,
    "can_release_dispatch" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(200) NOT NULL,
    "pin_hash" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "machine_access" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "whatsapp_number" VARCHAR(20),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machines" (
    "id" TEXT NOT NULL,
    "machine_code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "make" VARCHAR(80),
    "specification" VARCHAR(80),
    "capacity_per_shift" INTEGER NOT NULL,
    "std_waste_pct" DECIMAL(5,2) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "last_pm_date" DATE,
    "next_pm_due" DATE,
    "usage_run_hours_since_pm" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "usage_impressions_since_pm" BIGINT NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "machines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_pm_schedules" (
    "id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "interval_run_hours" DECIMAL(12,4) NOT NULL,
    "interval_impressions" BIGINT NOT NULL,
    "task_checklist_json" JSONB,
    "spare_parts_placeholder" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "machine_pm_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preventive_maintenance_logs" (
    "id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "verified_at" TIMESTAMP(3) NOT NULL,
    "verified_by_user_id" TEXT,
    "signed_off_note" VARCHAR(220) NOT NULL,
    "run_hours_before_reset" DECIMAL(14,4) NOT NULL,
    "impressions_before_reset" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preventive_maintenance_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pm_planned_downtime" (
    "id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "planned_start" TIMESTAMP(3) NOT NULL,
    "planned_end" TIMESTAMP(3) NOT NULL,
    "note" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pm_planned_downtime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "gst_number" VARCHAR(20),
    "contact_name" VARCHAR(120),
    "contact_phone" VARCHAR(20),
    "email" VARCHAR(200),
    "address" TEXT,
    "material_types" TEXT[],
    "default_for_board_grades" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lead_time_days" INTEGER NOT NULL DEFAULT 7,
    "payment_terms" VARCHAR(60),
    "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "gst_number" VARCHAR(20),
    "contact_name" VARCHAR(120),
    "contact_phone" VARCHAR(20),
    "email" VARCHAR(200),
    "address" TEXT,
    "credit_limit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "requires_artwork_approval" BOOLEAN NOT NULL DEFAULT true,
    "logo_url" VARCHAR(500),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory" (
    "id" TEXT NOT NULL,
    "material_code" VARCHAR(30) NOT NULL,
    "description" TEXT NOT NULL,
    "board_type" VARCHAR(120),
    "board_classification" VARCHAR(120),
    "sheet_length" DECIMAL(12,4),
    "sheet_width" DECIMAL(12,4),
    "gsm" INTEGER,
    "attributes" TEXT,
    "unit" VARCHAR(20) NOT NULL,
    "supplier_id" TEXT,
    "category" VARCHAR(1) NOT NULL DEFAULT 'A',
    "qty_quarantine" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "qty_available" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "qty_reserved" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "qty_fg" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "weighted_avg_cost" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "reorder_point" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "safety_stock" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "max_daily_usage" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "avg_daily_usage" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "hazmat" BOOLEAN NOT NULL DEFAULT false,
    "max_storage_qty" DECIMAL(12,3),
    "impression_life" INTEGER,
    "storage_location" VARCHAR(60),
    "lead_time_days" INTEGER NOT NULL DEFAULT 7,
    "physical_stock_sheets" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "shortage_sheets" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "total_weight_kg" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "job_number" VARCHAR(30) NOT NULL,
    "customer_id" TEXT NOT NULL,
    "die_master_id" TEXT,
    "product_name" VARCHAR(200) NOT NULL,
    "qty_ordered" INTEGER NOT NULL,
    "qty_produced_good" INTEGER NOT NULL DEFAULT 0,
    "qty_rejected" INTEGER NOT NULL DEFAULT 0,
    "imposition" INTEGER NOT NULL,
    "machine_sequence" TEXT[],
    "artwork_id" TEXT,
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending_artwork',
    "due_date" DATE NOT NULL,
    "special_instructions" TEXT,
    "created_by" TEXT NOT NULL,
    "closed_by" TEXT,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bom_lines" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "material_id" TEXT NOT NULL,
    "machine_id" TEXT,
    "qty_approved" DECIMAL(12,3) NOT NULL,
    "qty_issued" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "qty_used" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "qty_waste_std" DECIMAL(12,3) NOT NULL,
    "net_qty" DECIMAL(12,3) NOT NULL,
    "locked_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bom_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sheet_issues" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "bom_line_id" TEXT NOT NULL,
    "material_id" TEXT NOT NULL,
    "qty_requested" DECIMAL(12,3) NOT NULL,
    "is_excess" BOOLEAN NOT NULL DEFAULT false,
    "reason_code" VARCHAR(60),
    "reason_detail" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "approval_tier" INTEGER,
    "rejected_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "issued_by" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lot_number" VARCHAR(60),

    CONSTRAINT "sheet_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artworks" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "file_url" TEXT NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "locks_completed" INTEGER NOT NULL DEFAULT 0,
    "ctp_release_at" TIMESTAMP(3),
    "plate_barcode" VARCHAR(60),
    "uploaded_by" TEXT NOT NULL,
    "superseded_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "artworks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artwork_approvals" (
    "id" TEXT NOT NULL,
    "artwork_id" TEXT NOT NULL,
    "lock_number" INTEGER NOT NULL,
    "approved_by" TEXT NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL,
    "checklist_data" JSONB,
    "comments" TEXT,
    "rejected" BOOLEAN NOT NULL DEFAULT false,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artwork_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_stages" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "stage_number" INTEGER NOT NULL,
    "machine_id" TEXT,
    "started_by" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_by" TEXT,
    "completed_at" TIMESTAMP(3),
    "qty_in" INTEGER,
    "qty_out" INTEGER,
    "qty_waste" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_records" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "stage_id" TEXT,
    "check_type" VARCHAR(60) NOT NULL,
    "instrument_name" VARCHAR(80) NOT NULL,
    "measured_value" VARCHAR(120),
    "spec_min" VARCHAR(60),
    "spec_max" VARCHAR(60),
    "result" VARCHAR(10) NOT NULL,
    "checked_by" TEXT NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_first_article" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,

    CONSTRAINT "qc_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ncrs" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "qc_record_id" TEXT,
    "trigger" VARCHAR(30) NOT NULL,
    "severity" VARCHAR(20) NOT NULL,
    "description" TEXT NOT NULL,
    "quantity_affected" INTEGER,
    "raised_by" TEXT NOT NULL,
    "raised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "root_cause" TEXT,
    "corrective_action" TEXT,
    "preventive_action" TEXT,
    "assigned_to" TEXT,
    "due_date" DATE,
    "closed_by" TEXT,
    "closed_at" TIMESTAMP(3),
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ncrs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatches" (
    "id" TEXT NOT NULL,
    "job_id" TEXT,
    "production_job_card_id" TEXT,
    "qty_dispatched" INTEGER NOT NULL,
    "vehicle_number" VARCHAR(30),
    "driver_name" VARCHAR(80),
    "eway_bill_number" VARCHAR(30),
    "eway_bill_expiry" DATE,
    "qa_release_by" TEXT,
    "qa_release_at" TIMESTAMP(3),
    "dispatched_at" TIMESTAMP(3),
    "pod_received_at" TIMESTAMP(3),
    "pod_url" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending_qa',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_instruments" (
    "id" TEXT NOT NULL,
    "instrument_name" VARCHAR(80) NOT NULL,
    "specification" VARCHAR(120),
    "range" VARCHAR(60),
    "frequency" VARCHAR(60),
    "purpose" TEXT,
    "last_calibration" DATE,
    "calibration_due" DATE,
    "calibration_freq_days" INTEGER NOT NULL DEFAULT 365,
    "certificate_url" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qc_instruments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "user_id" TEXT,
    "action" VARCHAR(30) NOT NULL,
    "table_name" VARCHAR(60) NOT NULL,
    "record_id" TEXT,
    "old_value" JSONB,
    "new_value" JSONB,
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cartons" (
    "id" TEXT NOT NULL,
    "carton_name" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "product_type" TEXT,
    "category" TEXT,
    "rate" DECIMAL(12,4),
    "gst_pct" INTEGER NOT NULL DEFAULT 12,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "board_grade" TEXT,
    "gsm" INTEGER,
    "caliper_microns" INTEGER,
    "paper_type" TEXT,
    "ply_count" INTEGER DEFAULT 1,
    "burst_strength_min" DECIMAL(6,2),
    "whiteness_min" INTEGER,
    "moisture_max_pct" DECIMAL(4,2),
    "finished_length" DECIMAL(8,2),
    "finished_width" DECIMAL(8,2),
    "finished_height" DECIMAL(8,2),
    "blank_length" DECIMAL(8,2),
    "blank_width" DECIMAL(8,2),
    "dimension_tol" DECIMAL(4,2) DEFAULT 0.5,
    "has_window" BOOLEAN NOT NULL DEFAULT false,
    "window_length" DECIMAL(8,2),
    "window_width" DECIMAL(8,2),
    "batch_space_l" DECIMAL(6,2),
    "batch_space_w" DECIMAL(6,2),
    "mrp_space_l" DECIMAL(6,2),
    "mrp_space_w" DECIMAL(6,2),
    "expiry_space_l" DECIMAL(6,2),
    "expiry_space_w" DECIMAL(6,2),
    "number_of_colours" INTEGER,
    "colour_breakdown" JSONB,
    "back_print" TEXT NOT NULL DEFAULT 'No',
    "screen_ruling_lpi" INTEGER DEFAULT 175,
    "min_font_size_pt" DECIMAL(4,2) DEFAULT 6.0,
    "barcode_type" TEXT,
    "barcode_position" TEXT,
    "artwork_code" TEXT,
    "printing_type" TEXT,
    "plate_size" "PlateSize",
    "laminate_type" TEXT,
    "laminate_microns" INTEGER,
    "coating_type" TEXT,
    "uv_coverage_area" TEXT,
    "foil_type" TEXT,
    "foil_width" DECIMAL(6,2),
    "foil_reg_tol" DECIMAL(4,2) DEFAULT 0.1,
    "embossing_leafing" TEXT,
    "emboss_depth" DECIMAL(4,2),
    "dye_id" TEXT,
    "die_master_id" TEXT,
    "pasting_style" "PastingStyle",
    "crease_depth_mm" DECIMAL(4,2),
    "nick_count" INTEGER,
    "stripping_type" TEXT DEFAULT 'Auto',
    "glue_type" TEXT,
    "glue_bond_min_n" DECIMAL(6,2) DEFAULT 2.0,
    "overlap_width_mm" DECIMAL(6,2),
    "drug_schedule" TEXT,
    "regulatory_text" TEXT,
    "remarks" TEXT,
    "special_instructions" TEXT,
    "iso_9001_required" BOOLEAN NOT NULL DEFAULT true,
    "who_gmp_required" BOOLEAN NOT NULL DEFAULT false,
    "fssai_required" BOOLEAN NOT NULL DEFAULT false,
    "schedule_m_required" BOOLEAN NOT NULL DEFAULT true,
    "delta_e_max" DECIMAL(4,2) DEFAULT 3.0,
    "gloss_units_min" INTEGER,
    "gloss_units_max" INTEGER,
    "registration_tol" DECIMAL(4,2) DEFAULT 0.1,
    "aql_level" TEXT DEFAULT '1.0',
    "post_press_routing" JSONB,
    "emboss_block_id" TEXT,
    "shade_card_id" TEXT,
    "source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cartons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dyes" (
    "id" TEXT NOT NULL,
    "dye_number" INTEGER NOT NULL,
    "dye_type" TEXT NOT NULL,
    "ups" INTEGER NOT NULL,
    "sheet_size" TEXT NOT NULL,
    "carton_size" TEXT NOT NULL,
    "location" TEXT,
    "impression_count" INTEGER NOT NULL DEFAULT 0,
    "max_impressions" INTEGER NOT NULL DEFAULT 500000,
    "last_used_date" DATE,
    "crease_depth_mm" DECIMAL(4,2),
    "crease_count" INTEGER,
    "cut_count" INTEGER,
    "nicks_per_carton" INTEGER DEFAULT 4,
    "die_material" TEXT DEFAULT 'Steel Rule',
    "last_inspection_date" DATE,
    "condition_rating" TEXT DEFAULT 'Good',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "current_stock" INTEGER NOT NULL DEFAULT 1,
    "condition" VARCHAR(40) NOT NULL DEFAULT 'Good',
    "last_sharpened_date" DATE,
    "sharpen_count" INTEGER NOT NULL DEFAULT 0,
    "max_sharpen_count" INTEGER NOT NULL DEFAULT 5,
    "last_inspected_by" TEXT,
    "scrap_reason" TEXT,
    "scrapped_by" TEXT,
    "scrapped_at" TIMESTAMP(3),
    "custody_status" VARCHAR(32) NOT NULL DEFAULT 'in_stock',
    "reuse_count" INTEGER NOT NULL DEFAULT 0,
    "hub_previous_custody" VARCHAR(32),
    "issued_machine_id" TEXT,
    "issued_operator" TEXT,
    "issued_at" TIMESTAMP(3),
    "dim_length_mm" DECIMAL(12,4),
    "dim_width_mm" DECIMAL(12,4),
    "dim_height_mm" DECIMAL(12,4),
    "pasting_style" "PastingStyle",
    "die_make" VARCHAR(16) NOT NULL DEFAULT 'local',
    "date_of_manufacturing" TIMESTAMP(3),
    "hub_custody_source" VARCHAR(32),
    "hub_triage_hold_reason" VARCHAR(500),
    "hub_maintenance_completed_at" TIMESTAMP(3),
    "hub_status_flag" VARCHAR(32),
    "hub_poor_reported_by" VARCHAR(120),
    "hub_soft_deleted_at" TIMESTAMP(3),
    "hub_soft_deleted_by" VARCHAR(120),
    "hub_order_triage" INTEGER,
    "hub_order_prep" INTEGER,
    "hub_order_inventory" INTEGER,
    "hub_order_custody" INTEGER,
    "last_reordered_by" VARCHAR(120),
    "last_reordered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dyes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_master" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operator_master_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "die_hub_events" (
    "id" TEXT NOT NULL,
    "dye_id" TEXT NOT NULL,
    "action_type" VARCHAR(64) NOT NULL,
    "from_zone" VARCHAR(128),
    "to_zone" VARCHAR(128),
    "details" JSONB,
    "operator_name" VARCHAR(120),
    "actor_name" VARCHAR(120),
    "audit_action_type" VARCHAR(32),
    "metadata" JSONB,
    "superseded_by_undo_event_id" TEXT,
    "hub_action" VARCHAR(64),
    "event_condition" VARCHAR(16),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "die_hub_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dye_usage_log" (
    "id" TEXT NOT NULL,
    "dye_id" TEXT NOT NULL,
    "job_card_id" TEXT,
    "carton_name" TEXT,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "used_on" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operator_name" TEXT,
    "condition_after" TEXT,
    "notes" TEXT,

    CONSTRAINT "dye_usage_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dye_maintenance_log" (
    "id" TEXT NOT NULL,
    "dye_id" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "performed_by" TEXT NOT NULL,
    "performed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "condition_before" TEXT,
    "condition_after" TEXT,
    "notes" TEXT,
    "cost" DECIMAL(10,2),

    CONSTRAINT "dye_maintenance_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "po_number" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "po_date" DATE NOT NULL,
    "delivery_required_by" DATE,
    "remarks" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "is_priority" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_line_items" (
    "id" TEXT NOT NULL,
    "po_id" TEXT NOT NULL,
    "carton_id" TEXT,
    "carton_name" TEXT NOT NULL,
    "carton_size" TEXT,
    "quantity" INTEGER NOT NULL,
    "artwork_code" TEXT,
    "back_print" TEXT NOT NULL DEFAULT 'No',
    "rate" DECIMAL(12,4),
    "gsm" INTEGER,
    "gst_pct" INTEGER NOT NULL DEFAULT 12,
    "coating_type" TEXT,
    "other_coating" TEXT,
    "embossing_leafing" TEXT,
    "paper_type" TEXT,
    "dye_id" TEXT,
    "die_master_id" TEXT,
    "tooling_locked" BOOLEAN NOT NULL DEFAULT true,
    "line_die_type" TEXT,
    "dim_length_mm" DECIMAL(12,4),
    "dim_width_mm" DECIMAL(12,4),
    "dim_height_mm" DECIMAL(12,4),
    "remarks" TEXT,
    "set_number" TEXT,
    "job_card_number" INTEGER,
    "planning_status" TEXT NOT NULL DEFAULT 'pending',
    "material_procurement_status" VARCHAR(32) NOT NULL DEFAULT 'not_calculated',
    "spec_overrides" JSONB,
    "tolerance_pct" DECIMAL(5,2) NOT NULL DEFAULT 2.0,
    "director_priority" BOOLEAN NOT NULL DEFAULT false,
    "director_hold" BOOLEAN NOT NULL DEFAULT false,
    "director_broadcast_note" TEXT,
    "director_current_stage_key" VARCHAR(32),
    "director_current_stage_entered_at" TIMESTAMP(3),
    "artwork_stage_entered_at" TIMESTAMP(3),
    "tooling_stage_entered_at" TIMESTAMP(3),
    "material_stage_entered_at" TIMESTAMP(3),
    "production_stage_entered_at" TIMESTAMP(3),
    "logistics_stage_entered_at" TIMESTAMP(3),
    "shade_card_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "short_excess_records" (
    "id" TEXT NOT NULL,
    "po_line_item_id" TEXT NOT NULL,
    "job_card_id" TEXT,
    "bill_id" TEXT,
    "po_qty" INTEGER NOT NULL,
    "actual_qty" INTEGER NOT NULL,
    "tolerance_pct" DECIMAL(5,2) NOT NULL DEFAULT 2.0,
    "variance_qty" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "notes" TEXT,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "short_excess_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_weight_reconciliations" (
    "id" TEXT NOT NULL,
    "po_line_item_id" TEXT NOT NULL,
    "vendor_material_po_line_id" TEXT,
    "invoice_number" VARCHAR(64),
    "invoice_weight_kg" DECIMAL(16,6) NOT NULL,
    "scale_weight_kg" DECIMAL(16,6) NOT NULL,
    "core_weight_kg" DECIMAL(16,6) NOT NULL,
    "net_received_kg" DECIMAL(16,6) NOT NULL,
    "variance_kg" DECIMAL(16,6) NOT NULL,
    "variance_percent" DECIMAL(12,6),
    "rate_per_kg_inr" DECIMAL(14,4),
    "reconciliation_status" VARCHAR(40) NOT NULL DEFAULT 'ok',
    "debit_note_draft_text" TEXT,
    "debit_note_drafted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_weight_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_queue" (
    "id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "po_line_item_id" TEXT NOT NULL,
    "board_type" TEXT NOT NULL,
    "gsm" INTEGER NOT NULL,
    "grain_direction" VARCHAR(64) NOT NULL,
    "sheet_length_mm" DECIMAL(12,4) NOT NULL,
    "sheet_width_mm" DECIMAL(12,4) NOT NULL,
    "ups" INTEGER NOT NULL,
    "wastage_pct" DECIMAL(8,4) NOT NULL,
    "order_qty" INTEGER NOT NULL,
    "total_sheets" INTEGER NOT NULL,
    "total_weight_kg" DECIMAL(16,6) NOT NULL,
    "total_metric_tons" DECIMAL(18,8),
    "formula_version" VARCHAR(32) NOT NULL DEFAULT 'erp_board_v1',
    "calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_logs" (
    "id" TEXT NOT NULL,
    "channel" VARCHAR(24) NOT NULL,
    "direction" VARCHAR(16) NOT NULL DEFAULT 'outbound',
    "subject" VARCHAR(500),
    "body_preview" VARCHAR(2000),
    "to_address" VARCHAR(320),
    "status" VARCHAR(24) NOT NULL DEFAULT 'sent',
    "error_message" TEXT,
    "metadata" JSONB,
    "related_table" VARCHAR(80),
    "related_id" VARCHAR(36),
    "actor_label" VARCHAR(120) NOT NULL DEFAULT 'Anik Dua',
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communication_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_material_purchase_orders" (
    "id" TEXT NOT NULL,
    "po_number" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'draft',
    "order_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "required_delivery_date" DATE,
    "signatory_name" VARCHAR(120) NOT NULL DEFAULT 'Anik Dua',
    "remarks" TEXT,
    "dispatched_at" TIMESTAMP(3),
    "dispatch_actor" VARCHAR(120),
    "transporter_name" VARCHAR(200),
    "lr_number" VARCHAR(120),
    "vehicle_number" VARCHAR(64),
    "estimated_arrival_at" TIMESTAMP(3),
    "logistics_status" VARCHAR(32),
    "logistics_updated_at" TIMESTAMP(3),
    "is_short_closed" BOOLEAN NOT NULL DEFAULT false,
    "short_close_reason" VARCHAR(120),
    "short_close_remarks" TEXT,
    "short_closed_at" TIMESTAMP(3),
    "short_closed_by_user_id" TEXT,
    "short_closed_by_name" VARCHAR(120),
    "short_close_completion_pct" DECIMAL(6,2),
    "total_received_kg" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "total_usable_received_kg" DECIMAL(16,6) NOT NULL DEFAULT 0,
    "accrued_receipt_payable_inr" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "procurement_shortage_flag" VARCHAR(48),
    "replacement_eta_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_material_purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_quality_debit_notes" (
    "id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "vendor_po_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "ordered_gsm" DECIMAL(8,2) NOT NULL,
    "actual_gsm" DECIMAL(8,2) NOT NULL,
    "technical_shortfall_pct" DECIMAL(10,4) NOT NULL,
    "invoice_rate_per_kg" DECIMAL(14,4) NOT NULL,
    "received_qty_kg" DECIMAL(16,6) NOT NULL,
    "amount_inr" DECIMAL(16,2) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'draft_pending_finance',
    "formula_proof" TEXT,
    "authorized_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_quality_debit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_material_receipts" (
    "id" TEXT NOT NULL,
    "vendor_po_id" TEXT NOT NULL,
    "receipt_date" TIMESTAMP(3) NOT NULL,
    "received_qty" DECIMAL(16,6) NOT NULL,
    "vehicle_number" VARCHAR(64) NOT NULL,
    "scale_slip_id" VARCHAR(120) NOT NULL,
    "received_by_user_id" TEXT,
    "received_by_name" VARCHAR(120) NOT NULL DEFAULT 'Anik Dua',
    "qty_accepted_standard" DECIMAL(16,6),
    "qty_accepted_penalty" DECIMAL(16,6),
    "qty_rejected" DECIMAL(16,6),
    "rejection_reason" VARCHAR(120),
    "rejection_remarks" TEXT,
    "return_gate_pass_generated_at" TIMESTAMP(3),
    "qc_status" VARCHAR(32),
    "qc_actual_gsm" DECIMAL(8,2),
    "qc_shade_match" BOOLEAN,
    "qc_surface_cleanliness" BOOLEAN,
    "qc_remarks" TEXT,
    "qc_performed_by_user_id" TEXT,
    "qc_performed_at" TIMESTAMP(3),
    "qc_penalty_recommended_inr" DECIMAL(16,2),
    "qc_invoice_rate_per_kg" DECIMAL(14,4),
    "qc_technical_shortfall_pct" DECIMAL(10,4),
    "qc_accrued_payable_inr" DECIMAL(16,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_material_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_material_po_lines" (
    "id" TEXT NOT NULL,
    "vendor_po_id" TEXT NOT NULL,
    "board_grade" TEXT NOT NULL,
    "gsm" INTEGER NOT NULL,
    "grain_direction" VARCHAR(64) NOT NULL DEFAULT 'Long grain',
    "total_sheets" INTEGER NOT NULL,
    "total_weight_kg" DECIMAL(16,6) NOT NULL,
    "rate_per_kg" DECIMAL(14,4),
    "freight_total_inr" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "unloading_charges_inr" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "insurance_misc_inr" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "landed_rate_per_kg" DECIMAL(14,4),
    "linked_po_line_ids" JSONB NOT NULL,

    CONSTRAINT "vendor_material_po_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_job_cards" (
    "id" TEXT NOT NULL,
    "job_card_number" SERIAL NOT NULL,
    "set_number" TEXT,
    "customer_id" TEXT NOT NULL,
    "machine_id" TEXT,
    "assigned_operator" TEXT,
    "required_sheets" INTEGER NOT NULL,
    "wastage_sheets" INTEGER NOT NULL DEFAULT 0,
    "total_sheets" INTEGER NOT NULL,
    "sheets_issued" INTEGER NOT NULL DEFAULT 0,
    "artwork_approved" BOOLEAN NOT NULL DEFAULT false,
    "first_article_pass" BOOLEAN NOT NULL DEFAULT false,
    "final_qc_pass" BOOLEAN NOT NULL DEFAULT false,
    "qa_released" BOOLEAN NOT NULL DEFAULT false,
    "coa_generated" BOOLEAN NOT NULL DEFAULT false,
    "batch_number" TEXT,
    "file_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'design_ready',
    "job_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "post_press_routing" JSONB,
    "plate_set_id" TEXT,
    "new_plates_required" INTEGER,
    "old_plates_used" INTEGER,
    "plate_notes" TEXT,
    "emboss_block_id" TEXT,
    "shift_operator_user_id" TEXT,
    "allocated_paper_warehouse_id" TEXT,
    "issued_stock_display" VARCHAR(280),
    "inventory_location_pointer" VARCHAR(280),
    "grain_fit_status" VARCHAR(32) NOT NULL DEFAULT 'unknown',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_job_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_stage_records" (
    "id" TEXT NOT NULL,
    "job_card_id" TEXT NOT NULL,
    "stage_name" TEXT NOT NULL,
    "operator" TEXT,
    "set_number" TEXT,
    "paper" TEXT,
    "required_sheets" INTEGER,
    "paper_divide" INTEGER,
    "sheet_size" TEXT,
    "total_sheets" INTEGER,
    "counter" INTEGER,
    "file_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "completed_at" TIMESTAMP(3),
    "stage_data" JSONB,
    "last_production_tick_at" TIMESTAMP(3),
    "in_progress_since" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_stage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_downtime_logs" (
    "id" TEXT NOT NULL,
    "production_job_card_id" TEXT NOT NULL,
    "production_stage_record_id" TEXT,
    "machine_id" TEXT,
    "operator_user_id" TEXT NOT NULL,
    "reason_category" VARCHAR(48) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "duration_seconds" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_downtime_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_oee_ledgers" (
    "id" TEXT NOT NULL,
    "production_job_card_id" TEXT NOT NULL,
    "machine_id" TEXT,
    "availability_pct" DECIMAL(6,2) NOT NULL,
    "performance_pct" DECIMAL(6,2) NOT NULL,
    "quality_pct" DECIMAL(6,2) NOT NULL,
    "oee_pct" DECIMAL(6,2) NOT NULL,
    "shift_minutes" INTEGER NOT NULL,
    "run_minutes" INTEGER NOT NULL,
    "rated_speed_pph" DECIMAL(12,4),
    "actual_avg_speed_pph" DECIMAL(12,4),
    "good_pieces" INTEGER NOT NULL,
    "total_pieces" INTEGER NOT NULL,
    "yield_percent" DECIMAL(6,2),
    "incentive_eligible" BOOLEAN NOT NULL DEFAULT false,
    "incentive_verified_at" TIMESTAMP(3),
    "attributed_operator_user_id" TEXT,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_oee_ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sheet_issue_records" (
    "id" TEXT NOT NULL,
    "job_card_id" TEXT NOT NULL,
    "qty_requested" INTEGER NOT NULL,
    "is_excess" BOOLEAN NOT NULL DEFAULT false,
    "reason_code" TEXT,
    "reason_detail" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "approval_tier" INTEGER,
    "rejected_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "issued_by" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lot_number" TEXT,
    "fifo_override_reason" TEXT,

    CONSTRAINT "sheet_issue_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plate_store" (
    "id" TEXT NOT NULL,
    "current_job_card_id" TEXT,
    "carton_id" TEXT,
    "artwork_id" TEXT,
    "artwork_code" TEXT,
    "artwork_version" TEXT,
    "plate_size" "PlateSize" NOT NULL DEFAULT 'SIZE_560_670',
    "carton_name" TEXT NOT NULL,
    "customer_id" TEXT,
    "plate_set_code" TEXT NOT NULL,
    "serial_number" TEXT,
    "output_number" TEXT,
    "rack_number" TEXT,
    "ups" INTEGER,
    "number_of_colours" INTEGER NOT NULL,
    "colours" JSONB NOT NULL,
    "total_plates" INTEGER NOT NULL,
    "new_plates" INTEGER NOT NULL DEFAULT 0,
    "old_plates" INTEGER NOT NULL DEFAULT 0,
    "rack_location" TEXT,
    "slot_number" TEXT,
    "storage_location" TEXT,
    "ctp_operator" TEXT,
    "ctp_date" DATE,
    "status" VARCHAR(24) NOT NULL DEFAULT 'in_use',
    "printed_on" DATE,
    "collected_by" TEXT,
    "collected_at" TIMESTAMP(3),
    "issued_to" TEXT,
    "issued_at" TIMESTAMP(3),
    "returned_by" TEXT,
    "returned_at" TIMESTAMP(3),
    "storage_notes" TEXT,
    "destroyed_reason" TEXT,
    "destroyed_by" TEXT,
    "destroyed_at" TIMESTAMP(3),
    "total_impressions" INTEGER NOT NULL DEFAULT 0,
    "last_used_date" DATE,
    "hub_custody_source" VARCHAR(32),
    "hub_previous_status" VARCHAR(32),
    "last_status_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cycle_data" JSONB NOT NULL DEFAULT '{}',
    "hub_soft_deleted_at" TIMESTAMP(3),
    "hub_soft_deleted_by" VARCHAR(120),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plate_store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plate_store_scrap_events" (
    "id" TEXT NOT NULL,
    "plate_store_id" TEXT NOT NULL,
    "scrapped_names" JSONB NOT NULL,
    "reason_code" TEXT NOT NULL,
    "reason_label" TEXT NOT NULL,
    "performed_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plate_store_scrap_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plate_requirements" (
    "id" TEXT NOT NULL,
    "requirement_code" TEXT NOT NULL,
    "job_card_id" TEXT,
    "die_master_id" TEXT,
    "carton_name" TEXT NOT NULL,
    "artwork_code" TEXT,
    "artwork_version" TEXT,
    "customer_id" TEXT,
    "number_of_colours" INTEGER NOT NULL,
    "colours_needed" JSONB NOT NULL,
    "new_plates_needed" INTEGER NOT NULL,
    "old_plates_available" INTEGER NOT NULL,
    "ctp_triggered_at" TIMESTAMP(3),
    "ctp_operator" TEXT,
    "ctp_priority" TEXT NOT NULL DEFAULT 'Normal',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "triage_channel" VARCHAR(40),
    "reserved_rack_slot" TEXT,
    "po_line_id" TEXT,
    "partial_remake" BOOLEAN NOT NULL DEFAULT false,
    "plate_size" "PlateSize",
    "created_by" TEXT NOT NULL,
    "last_status_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hub_soft_deleted_at" TIMESTAMP(3),
    "hub_soft_deleted_by" VARCHAR(120),
    "hub_order_ctp" INTEGER,
    "hub_order_vendor" INTEGER,
    "last_reordered_by" VARCHAR(120),
    "last_reordered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plate_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plate_hub_events" (
    "id" TEXT NOT NULL,
    "plate_requirement_id" TEXT,
    "plate_store_id" TEXT,
    "action_type" VARCHAR(64) NOT NULL,
    "from_zone" VARCHAR(128),
    "to_zone" VARCHAR(128),
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plate_hub_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emboss_blocks" (
    "id" TEXT NOT NULL,
    "block_code" TEXT NOT NULL,
    "carton_id" TEXT,
    "carton_name" TEXT,
    "customer_id" TEXT,
    "block_type" TEXT NOT NULL,
    "block_material" TEXT NOT NULL DEFAULT 'Magnesium',
    "material_type" VARCHAR(32),
    "block_size" TEXT,
    "emboss_depth" DECIMAL(4,2),
    "relief_depth_mm" DECIMAL(4,2),
    "storage_location" TEXT,
    "linked_die_id" TEXT,
    "artwork_ref_link" VARCHAR(600),
    "asset_version_id" VARCHAR(40),
    "impression_count" INTEGER NOT NULL DEFAULT 0,
    "cumulative_strikes" INTEGER NOT NULL DEFAULT 0,
    "max_impressions" INTEGER NOT NULL DEFAULT 100000,
    "condition" VARCHAR(40) NOT NULL DEFAULT 'Good',
    "last_polished_date" DATE,
    "polish_count" INTEGER NOT NULL DEFAULT 0,
    "scrap_reason" TEXT,
    "scrapped_by" TEXT,
    "scrapped_at" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "custody_status" VARCHAR(32) NOT NULL DEFAULT 'in_stock',
    "reuse_count" INTEGER NOT NULL DEFAULT 0,
    "hub_previous_custody" VARCHAR(32),
    "issued_machine_id" TEXT,
    "issued_operator" TEXT,
    "issued_at" TIMESTAMP(3),
    "hub_soft_deleted_at" TIMESTAMP(3),
    "hub_soft_deleted_by" VARCHAR(120),
    "hub_order_triage" INTEGER,
    "hub_order_prep" INTEGER,
    "hub_order_inventory" INTEGER,
    "hub_order_custody" INTEGER,
    "last_reordered_by" VARCHAR(120),
    "last_reordered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "emboss_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emboss_hub_events" (
    "id" TEXT NOT NULL,
    "block_id" TEXT NOT NULL,
    "action_type" VARCHAR(64) NOT NULL,
    "from_zone" VARCHAR(128),
    "to_zone" VARCHAR(128),
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emboss_hub_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shade_cards" (
    "id" TEXT NOT NULL,
    "shade_code" TEXT NOT NULL,
    "product_master" TEXT,
    "master_artwork_ref" TEXT,
    "approval_date" DATE,
    "last_verified_at" DATE,
    "delta_e_reading" DECIMAL(5,2),
    "approval_attachment_url" VARCHAR(600),
    "ink_recipe_link" VARCHAR(600),
    "customer_approval_doc" VARCHAR(600),
    "valid_until" DATE,
    "spectro_report_summary" TEXT,
    "color_swatch_hex" VARCHAR(7),
    "customer_id" TEXT,
    "ink_component" TEXT,
    "remarks" TEXT,
    "remarks_edited_at" TIMESTAMP(3),
    "remarks_edited_by_name" VARCHAR(120),
    "current_holder" TEXT,
    "impression_count" INTEGER NOT NULL DEFAULT 0,
    "custody_status" VARCHAR(32) NOT NULL DEFAULT 'in_stock',
    "issued_machine_id" TEXT,
    "issued_job_card_id" TEXT,
    "issued_operator" TEXT,
    "issued_at" TIMESTAMP(3),
    "mfg_date" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "product_id" TEXT,
    "substrate_type" VARCHAR(32),
    "lab_l" DECIMAL(10,4),
    "lab_a" DECIMAL(10,4),
    "lab_b" DECIMAL(10,4),
    "ink_recipe_notes" TEXT,
    "spectro_scan_log" JSONB,
    "hub_soft_deleted_at" TIMESTAMP(3),
    "hub_soft_deleted_by" VARCHAR(120),
    "hub_order_in_stock" INTEGER,
    "hub_order_on_floor" INTEGER,
    "hub_order_reverify" INTEGER,
    "hub_order_expired" INTEGER,
    "last_reordered_by" VARCHAR(120),
    "last_reordered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shade_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shade_card_events" (
    "id" TEXT NOT NULL,
    "shade_card_id" TEXT NOT NULL,
    "action_type" VARCHAR(64) NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shade_card_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emboss_block_usage_log" (
    "id" TEXT NOT NULL,
    "block_id" TEXT NOT NULL,
    "job_card_id" TEXT,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "used_on" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operator_name" TEXT,
    "condition_after" TEXT,
    "notes" TEXT,

    CONSTRAINT "emboss_block_usage_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emboss_block_maintenance_log" (
    "id" TEXT NOT NULL,
    "block_id" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "performed_by" TEXT NOT NULL,
    "performed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "condition_before" TEXT,
    "condition_after" TEXT,
    "notes" TEXT,
    "cost" DECIMAL(10,2),

    CONSTRAINT "emboss_block_maintenance_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_warehouse" (
    "id" TEXT NOT NULL,
    "vendor_id" TEXT,
    "paper_type" TEXT NOT NULL,
    "board_grade" TEXT,
    "gsm" INTEGER NOT NULL,
    "caliper_microns" INTEGER,
    "qty_sheets" INTEGER NOT NULL,
    "lot_number" TEXT,
    "rate" DECIMAL(12,4),
    "coa_reference" TEXT,
    "receipt_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "location" TEXT,
    "originated_from_id" TEXT,
    "supplier_gsm" INTEGER,
    "measured_gsm" INTEGER,
    "measured_caliper" INTEGER,
    "measured_whiteness" INTEGER,
    "measured_moisture" DECIMAL(4,2),
    "measured_burst" DECIMAL(6,2),
    "qc_result" TEXT,
    "qc_inspected_by" TEXT,
    "qc_inspected_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'quarantine',
    "sheet_size_label" VARCHAR(80),
    "grain_direction" VARCHAR(64),
    "warehouse_bay_id" VARCHAR(64),
    "pallet_id" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paper_warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_issue_to_floor" (
    "id" TEXT NOT NULL,
    "source_paper_warehouse_id" TEXT NOT NULL,
    "destination_warehouse_id" TEXT,
    "production_job_card_id" TEXT,
    "qty_sheets" INTEGER NOT NULL,
    "operator_user_id" TEXT NOT NULL,
    "operator_name" TEXT NOT NULL,
    "high_priority_authorized" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paper_issue_to_floor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_spec_reorder_policies" (
    "id" TEXT NOT NULL,
    "radar_key" VARCHAR(256) NOT NULL,
    "minimum_threshold" INTEGER NOT NULL DEFAULT 0,
    "maximum_buffer" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paper_spec_reorder_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bills" (
    "id" TEXT NOT NULL,
    "bill_number" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "bill_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "gst_amount" DECIMAL(12,2) NOT NULL,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_line_items" (
    "id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "job_card_id" TEXT,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "rate" DECIMAL(12,4) NOT NULL,
    "gst_pct" INTEGER NOT NULL DEFAULT 12,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "bill_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_stages" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "stage_number" INTEGER NOT NULL,
    "stage_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "responsible_role" TEXT,
    "assigned_to" TEXT,
    "planned_start" TIMESTAMP(3),
    "planned_end" TIMESTAMP(3),
    "actual_start" TIMESTAMP(3),
    "actual_end" TIMESTAMP(3),
    "documents" JSONB,
    "checklist_data" JSONB,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfqs" (
    "id" TEXT NOT NULL,
    "rfq_number" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "pack_type" TEXT NOT NULL,
    "estimated_volume" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'received',
    "feasibility_data" JSONB,
    "quotation_number" TEXT,
    "quoted_price" DECIMAL(12,4),
    "po_number" TEXT,
    "po_value" DECIMAL(12,2),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rfqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waste_records" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "stage_id" TEXT,
    "waste_type" VARCHAR(40) NOT NULL,
    "qty" DECIMAL(12,3) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "material_id" TEXT NOT NULL,
    "machine_id" TEXT,
    "recorded_by" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waste_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_requisitions" (
    "id" TEXT NOT NULL,
    "material_id" TEXT NOT NULL,
    "qty_required" DECIMAL(12,3) NOT NULL,
    "estimated_value" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "trigger_reason" TEXT NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "raised_by" TEXT NOT NULL,
    "raised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "supplier_id" TEXT,
    "expected_delivery" DATE,
    "po_reference" VARCHAR(60),
    "board_type" VARCHAR(120),
    "size_label" VARCHAR(80),
    "gsm" INTEGER,
    "shortage_id" TEXT,
    "source_job_card_id" TEXT,
    "source_planning_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_requisitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_reservations" (
    "id" TEXT NOT NULL,
    "material_id" TEXT NOT NULL,
    "job_card_id" TEXT NOT NULL,
    "planning_id" TEXT,
    "required_sheets" DECIMAL(12,3) NOT NULL,
    "reserved_sheets" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "shortage_sheets" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "status" VARCHAR(32) NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_shortages" (
    "id" TEXT NOT NULL,
    "material_id" TEXT NOT NULL,
    "job_card_id" TEXT,
    "planning_id" TEXT,
    "source_po_line_id" TEXT,
    "trigger_reason" VARCHAR(64),
    "shortage_qty" DECIMAL(12,3) NOT NULL,
    "allocated_qty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "remaining_qty" DECIMAL(12,3) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'open',
    "purchase_req_id" TEXT,
    "required_by_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_shortages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grn_shortage_allocations" (
    "id" TEXT NOT NULL,
    "grn_id" TEXT NOT NULL,
    "shortage_id" TEXT NOT NULL,
    "material_id" TEXT NOT NULL,
    "allocated_qty" DECIMAL(12,3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grn_shortage_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "material_id" TEXT NOT NULL,
    "movement_type" VARCHAR(40) NOT NULL,
    "qty" DECIMAL(12,3) NOT NULL,
    "ref_type" VARCHAR(40),
    "ref_id" TEXT,
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "effect_categories" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "effect_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "effect_values" (
    "id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "value" VARCHAR(120) NOT NULL,
    "abbreviation" VARCHAR(24),
    "impact_on" VARCHAR(80),
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "effect_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_role_name_key" ON "roles"("role_name");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "machines_machine_code_key" ON "machines"("machine_code");

-- CreateIndex
CREATE UNIQUE INDEX "machine_pm_schedules_machine_id_key" ON "machine_pm_schedules"("machine_id");

-- CreateIndex
CREATE INDEX "preventive_maintenance_logs_machine_id_idx" ON "preventive_maintenance_logs"("machine_id");

-- CreateIndex
CREATE INDEX "preventive_maintenance_logs_verified_at_idx" ON "preventive_maintenance_logs"("verified_at");

-- CreateIndex
CREATE INDEX "pm_planned_downtime_planned_start_planned_end_idx" ON "pm_planned_downtime"("planned_start", "planned_end");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_material_code_key" ON "inventory"("material_code");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_board_size_gsm_unique" ON "inventory"("board_type", "sheet_length", "sheet_width", "gsm");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_job_number_key" ON "jobs"("job_number");

-- CreateIndex
CREATE UNIQUE INDEX "artwork_approvals_artwork_id_lock_number_key" ON "artwork_approvals"("artwork_id", "lock_number");

-- CreateIndex
CREATE INDEX "dispatches_production_job_card_id_idx" ON "dispatches"("production_job_card_id");

-- CreateIndex
CREATE UNIQUE INDEX "qc_instruments_instrument_name_key" ON "qc_instruments"("instrument_name");

-- CreateIndex
CREATE INDEX "cartons_shade_card_id_idx" ON "cartons"("shade_card_id");

-- CreateIndex
CREATE UNIQUE INDEX "dyes_dye_number_key" ON "dyes"("dye_number");

-- CreateIndex
CREATE UNIQUE INDEX "operator_master_name_key" ON "operator_master"("name");

-- CreateIndex
CREATE INDEX "die_hub_events_dye_id_idx" ON "die_hub_events"("dye_id");

-- CreateIndex
CREATE INDEX "die_hub_events_created_at_idx" ON "die_hub_events"("created_at" DESC);

-- CreateIndex
CREATE INDEX "die_hub_events_superseded_by_undo_event_id_idx" ON "die_hub_events"("superseded_by_undo_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_po_number_key" ON "purchase_orders"("po_number");

-- CreateIndex
CREATE INDEX "po_line_items_shade_card_id_idx" ON "po_line_items"("shade_card_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_weight_reconciliations_po_line_item_id_key" ON "material_weight_reconciliations"("po_line_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_queue_po_line_item_id_key" ON "material_queue"("po_line_item_id");

-- CreateIndex
CREATE INDEX "communication_logs_related_table_related_id_idx" ON "communication_logs"("related_table", "related_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_material_purchase_orders_po_number_key" ON "vendor_material_purchase_orders"("po_number");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_quality_debit_notes_receipt_id_key" ON "vendor_quality_debit_notes"("receipt_id");

-- CreateIndex
CREATE INDEX "vendor_quality_debit_notes_vendor_po_id_idx" ON "vendor_quality_debit_notes"("vendor_po_id");

-- CreateIndex
CREATE INDEX "vendor_quality_debit_notes_supplier_id_idx" ON "vendor_quality_debit_notes"("supplier_id");

-- CreateIndex
CREATE INDEX "vendor_material_receipts_vendor_po_id_idx" ON "vendor_material_receipts"("vendor_po_id");

-- CreateIndex
CREATE UNIQUE INDEX "production_job_cards_job_card_number_key" ON "production_job_cards"("job_card_number");

-- CreateIndex
CREATE INDEX "production_downtime_logs_production_job_card_id_idx" ON "production_downtime_logs"("production_job_card_id");

-- CreateIndex
CREATE INDEX "production_downtime_logs_started_at_idx" ON "production_downtime_logs"("started_at");

-- CreateIndex
CREATE INDEX "production_downtime_logs_reason_category_idx" ON "production_downtime_logs"("reason_category");

-- CreateIndex
CREATE UNIQUE INDEX "production_oee_ledgers_production_job_card_id_key" ON "production_oee_ledgers"("production_job_card_id");

-- CreateIndex
CREATE UNIQUE INDEX "plate_store_plate_set_code_key" ON "plate_store"("plate_set_code");

-- CreateIndex
CREATE INDEX "plate_store_scrap_events_plate_store_id_idx" ON "plate_store_scrap_events"("plate_store_id");

-- CreateIndex
CREATE UNIQUE INDEX "plate_requirements_requirement_code_key" ON "plate_requirements"("requirement_code");

-- CreateIndex
CREATE INDEX "plate_hub_events_plate_requirement_id_idx" ON "plate_hub_events"("plate_requirement_id");

-- CreateIndex
CREATE INDEX "plate_hub_events_plate_store_id_idx" ON "plate_hub_events"("plate_store_id");

-- CreateIndex
CREATE INDEX "plate_hub_events_created_at_idx" ON "plate_hub_events"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "emboss_blocks_block_code_key" ON "emboss_blocks"("block_code");

-- CreateIndex
CREATE INDEX "emboss_blocks_linked_die_id_idx" ON "emboss_blocks"("linked_die_id");

-- CreateIndex
CREATE INDEX "emboss_hub_events_block_id_idx" ON "emboss_hub_events"("block_id");

-- CreateIndex
CREATE INDEX "emboss_hub_events_created_at_idx" ON "emboss_hub_events"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "shade_cards_shade_code_key" ON "shade_cards"("shade_code");

-- CreateIndex
CREATE INDEX "shade_cards_customer_id_idx" ON "shade_cards"("customer_id");

-- CreateIndex
CREATE INDEX "shade_cards_product_id_idx" ON "shade_cards"("product_id");

-- CreateIndex
CREATE INDEX "shade_cards_issued_job_card_id_idx" ON "shade_cards"("issued_job_card_id");

-- CreateIndex
CREATE INDEX "shade_card_events_shade_card_id_idx" ON "shade_card_events"("shade_card_id");

-- CreateIndex
CREATE INDEX "shade_card_events_created_at_idx" ON "shade_card_events"("created_at" DESC);

-- CreateIndex
CREATE INDEX "paper_issue_to_floor_source_paper_warehouse_id_idx" ON "paper_issue_to_floor"("source_paper_warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "paper_spec_reorder_policies_radar_key_key" ON "paper_spec_reorder_policies"("radar_key");

-- CreateIndex
CREATE UNIQUE INDEX "bills_bill_number_key" ON "bills"("bill_number");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_stages_job_id_stage_number_key" ON "workflow_stages"("job_id", "stage_number");

-- CreateIndex
CREATE UNIQUE INDEX "rfqs_rfq_number_key" ON "rfqs"("rfq_number");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requisitions_shortage_id_key" ON "purchase_requisitions"("shortage_id");

-- CreateIndex
CREATE INDEX "material_reservations_job_card_id_idx" ON "material_reservations"("job_card_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_reservations_material_id_job_card_id_key" ON "material_reservations"("material_id", "job_card_id");

-- CreateIndex
CREATE INDEX "material_shortages_material_id_status_idx" ON "material_shortages"("material_id", "status");

-- CreateIndex
CREATE INDEX "material_shortages_job_card_id_status_idx" ON "material_shortages"("job_card_id", "status");

-- CreateIndex
CREATE INDEX "grn_shortage_allocations_shortage_id_idx" ON "grn_shortage_allocations"("shortage_id");

-- CreateIndex
CREATE UNIQUE INDEX "grn_shortage_allocations_grn_id_shortage_id_key" ON "grn_shortage_allocations"("grn_id", "shortage_id");

-- CreateIndex
CREATE UNIQUE INDEX "effect_categories_name_key" ON "effect_categories"("name");

-- CreateIndex
CREATE INDEX "effect_values_category_id_active_sort_order_idx" ON "effect_values"("category_id", "active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "effect_values_category_id_value_key" ON "effect_values"("category_id", "value");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_pm_schedules" ADD CONSTRAINT "machine_pm_schedules_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preventive_maintenance_logs" ADD CONSTRAINT "preventive_maintenance_logs_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preventive_maintenance_logs" ADD CONSTRAINT "preventive_maintenance_logs_verified_by_user_id_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pm_planned_downtime" ADD CONSTRAINT "pm_planned_downtime_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_die_master_id_fkey" FOREIGN KEY ("die_master_id") REFERENCES "dyes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_artwork_id_fkey" FOREIGN KEY ("artwork_id") REFERENCES "artworks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "inventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_issues" ADD CONSTRAINT "sheet_issues_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_issues" ADD CONSTRAINT "sheet_issues_bom_line_id_fkey" FOREIGN KEY ("bom_line_id") REFERENCES "bom_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_issues" ADD CONSTRAINT "sheet_issues_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "inventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_issues" ADD CONSTRAINT "sheet_issues_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_issues" ADD CONSTRAINT "sheet_issues_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artworks" ADD CONSTRAINT "artworks_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artworks" ADD CONSTRAINT "artworks_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_approvals" ADD CONSTRAINT "artwork_approvals_artwork_id_fkey" FOREIGN KEY ("artwork_id") REFERENCES "artworks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_approvals" ADD CONSTRAINT "artwork_approvals_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_started_by_fkey" FOREIGN KEY ("started_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_records" ADD CONSTRAINT "qc_records_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_records" ADD CONSTRAINT "qc_records_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "job_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_records" ADD CONSTRAINT "qc_records_checked_by_fkey" FOREIGN KEY ("checked_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ncrs" ADD CONSTRAINT "ncrs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ncrs" ADD CONSTRAINT "ncrs_qc_record_id_fkey" FOREIGN KEY ("qc_record_id") REFERENCES "qc_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ncrs" ADD CONSTRAINT "ncrs_raised_by_fkey" FOREIGN KEY ("raised_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ncrs" ADD CONSTRAINT "ncrs_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ncrs" ADD CONSTRAINT "ncrs_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_production_job_card_id_fkey" FOREIGN KEY ("production_job_card_id") REFERENCES "production_job_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartons" ADD CONSTRAINT "cartons_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartons" ADD CONSTRAINT "cartons_dye_id_fkey" FOREIGN KEY ("dye_id") REFERENCES "dyes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartons" ADD CONSTRAINT "cartons_die_master_id_fkey" FOREIGN KEY ("die_master_id") REFERENCES "dyes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartons" ADD CONSTRAINT "cartons_emboss_block_id_fkey" FOREIGN KEY ("emboss_block_id") REFERENCES "emboss_blocks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartons" ADD CONSTRAINT "cartons_shade_card_id_fkey" FOREIGN KEY ("shade_card_id") REFERENCES "shade_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "die_hub_events" ADD CONSTRAINT "die_hub_events_dye_id_fkey" FOREIGN KEY ("dye_id") REFERENCES "dyes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "die_hub_events" ADD CONSTRAINT "die_hub_events_superseded_by_undo_event_id_fkey" FOREIGN KEY ("superseded_by_undo_event_id") REFERENCES "die_hub_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dye_usage_log" ADD CONSTRAINT "dye_usage_log_dye_id_fkey" FOREIGN KEY ("dye_id") REFERENCES "dyes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dye_maintenance_log" ADD CONSTRAINT "dye_maintenance_log_dye_id_fkey" FOREIGN KEY ("dye_id") REFERENCES "dyes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_line_items" ADD CONSTRAINT "po_line_items_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_line_items" ADD CONSTRAINT "po_line_items_carton_id_fkey" FOREIGN KEY ("carton_id") REFERENCES "cartons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_line_items" ADD CONSTRAINT "po_line_items_die_master_id_fkey" FOREIGN KEY ("die_master_id") REFERENCES "dyes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_line_items" ADD CONSTRAINT "po_line_items_shade_card_id_fkey" FOREIGN KEY ("shade_card_id") REFERENCES "shade_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "short_excess_records" ADD CONSTRAINT "short_excess_records_po_line_item_id_fkey" FOREIGN KEY ("po_line_item_id") REFERENCES "po_line_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_weight_reconciliations" ADD CONSTRAINT "material_weight_reconciliations_po_line_item_id_fkey" FOREIGN KEY ("po_line_item_id") REFERENCES "po_line_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_queue" ADD CONSTRAINT "material_queue_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_queue" ADD CONSTRAINT "material_queue_po_line_item_id_fkey" FOREIGN KEY ("po_line_item_id") REFERENCES "po_line_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_material_purchase_orders" ADD CONSTRAINT "vendor_material_purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_quality_debit_notes" ADD CONSTRAINT "vendor_quality_debit_notes_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "vendor_material_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_quality_debit_notes" ADD CONSTRAINT "vendor_quality_debit_notes_vendor_po_id_fkey" FOREIGN KEY ("vendor_po_id") REFERENCES "vendor_material_purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_quality_debit_notes" ADD CONSTRAINT "vendor_quality_debit_notes_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_material_receipts" ADD CONSTRAINT "vendor_material_receipts_vendor_po_id_fkey" FOREIGN KEY ("vendor_po_id") REFERENCES "vendor_material_purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_material_po_lines" ADD CONSTRAINT "vendor_material_po_lines_vendor_po_id_fkey" FOREIGN KEY ("vendor_po_id") REFERENCES "vendor_material_purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_job_cards" ADD CONSTRAINT "production_job_cards_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_job_cards" ADD CONSTRAINT "production_job_cards_shift_operator_user_id_fkey" FOREIGN KEY ("shift_operator_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_job_cards" ADD CONSTRAINT "production_job_cards_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_job_cards" ADD CONSTRAINT "production_job_cards_allocated_paper_warehouse_id_fkey" FOREIGN KEY ("allocated_paper_warehouse_id") REFERENCES "paper_warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_job_cards" ADD CONSTRAINT "production_job_cards_plate_set_id_fkey" FOREIGN KEY ("plate_set_id") REFERENCES "plate_store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_job_cards" ADD CONSTRAINT "production_job_cards_emboss_block_id_fkey" FOREIGN KEY ("emboss_block_id") REFERENCES "emboss_blocks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_stage_records" ADD CONSTRAINT "production_stage_records_job_card_id_fkey" FOREIGN KEY ("job_card_id") REFERENCES "production_job_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_downtime_logs" ADD CONSTRAINT "production_downtime_logs_production_job_card_id_fkey" FOREIGN KEY ("production_job_card_id") REFERENCES "production_job_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_downtime_logs" ADD CONSTRAINT "production_downtime_logs_production_stage_record_id_fkey" FOREIGN KEY ("production_stage_record_id") REFERENCES "production_stage_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_downtime_logs" ADD CONSTRAINT "production_downtime_logs_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_downtime_logs" ADD CONSTRAINT "production_downtime_logs_operator_user_id_fkey" FOREIGN KEY ("operator_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_oee_ledgers" ADD CONSTRAINT "production_oee_ledgers_production_job_card_id_fkey" FOREIGN KEY ("production_job_card_id") REFERENCES "production_job_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_oee_ledgers" ADD CONSTRAINT "production_oee_ledgers_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_oee_ledgers" ADD CONSTRAINT "production_oee_ledgers_attributed_operator_user_id_fkey" FOREIGN KEY ("attributed_operator_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_issue_records" ADD CONSTRAINT "sheet_issue_records_job_card_id_fkey" FOREIGN KEY ("job_card_id") REFERENCES "production_job_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plate_store" ADD CONSTRAINT "plate_store_carton_id_fkey" FOREIGN KEY ("carton_id") REFERENCES "cartons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plate_store" ADD CONSTRAINT "plate_store_current_job_card_id_fkey" FOREIGN KEY ("current_job_card_id") REFERENCES "production_job_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plate_store" ADD CONSTRAINT "plate_store_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plate_store_scrap_events" ADD CONSTRAINT "plate_store_scrap_events_plate_store_id_fkey" FOREIGN KEY ("plate_store_id") REFERENCES "plate_store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plate_requirements" ADD CONSTRAINT "plate_requirements_die_master_id_fkey" FOREIGN KEY ("die_master_id") REFERENCES "dyes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plate_hub_events" ADD CONSTRAINT "plate_hub_events_plate_requirement_id_fkey" FOREIGN KEY ("plate_requirement_id") REFERENCES "plate_requirements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plate_hub_events" ADD CONSTRAINT "plate_hub_events_plate_store_id_fkey" FOREIGN KEY ("plate_store_id") REFERENCES "plate_store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emboss_blocks" ADD CONSTRAINT "emboss_blocks_issued_machine_id_fkey" FOREIGN KEY ("issued_machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emboss_blocks" ADD CONSTRAINT "emboss_blocks_linked_die_id_fkey" FOREIGN KEY ("linked_die_id") REFERENCES "dyes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emboss_hub_events" ADD CONSTRAINT "emboss_hub_events_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "emboss_blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shade_cards" ADD CONSTRAINT "shade_cards_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shade_cards" ADD CONSTRAINT "shade_cards_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "cartons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shade_cards" ADD CONSTRAINT "shade_cards_issued_job_card_id_fkey" FOREIGN KEY ("issued_job_card_id") REFERENCES "production_job_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shade_card_events" ADD CONSTRAINT "shade_card_events_shade_card_id_fkey" FOREIGN KEY ("shade_card_id") REFERENCES "shade_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emboss_block_usage_log" ADD CONSTRAINT "emboss_block_usage_log_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "emboss_blocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emboss_block_maintenance_log" ADD CONSTRAINT "emboss_block_maintenance_log_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "emboss_blocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_warehouse" ADD CONSTRAINT "paper_warehouse_originated_from_id_fkey" FOREIGN KEY ("originated_from_id") REFERENCES "paper_warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_issue_to_floor" ADD CONSTRAINT "paper_issue_to_floor_source_paper_warehouse_id_fkey" FOREIGN KEY ("source_paper_warehouse_id") REFERENCES "paper_warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_issue_to_floor" ADD CONSTRAINT "paper_issue_to_floor_destination_warehouse_id_fkey" FOREIGN KEY ("destination_warehouse_id") REFERENCES "paper_warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_issue_to_floor" ADD CONSTRAINT "paper_issue_to_floor_production_job_card_id_fkey" FOREIGN KEY ("production_job_card_id") REFERENCES "production_job_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_line_items" ADD CONSTRAINT "bill_line_items_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_stages" ADD CONSTRAINT "workflow_stages_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste_records" ADD CONSTRAINT "waste_records_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste_records" ADD CONSTRAINT "waste_records_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "job_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste_records" ADD CONSTRAINT "waste_records_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "inventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste_records" ADD CONSTRAINT "waste_records_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste_records" ADD CONSTRAINT "waste_records_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "inventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_reservations" ADD CONSTRAINT "material_reservations_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "inventory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_reservations" ADD CONSTRAINT "material_reservations_job_card_id_fkey" FOREIGN KEY ("job_card_id") REFERENCES "production_job_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_shortages" ADD CONSTRAINT "material_shortages_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "inventory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_shortages" ADD CONSTRAINT "material_shortages_job_card_id_fkey" FOREIGN KEY ("job_card_id") REFERENCES "production_job_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "inventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "effect_values" ADD CONSTRAINT "effect_values_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "effect_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

