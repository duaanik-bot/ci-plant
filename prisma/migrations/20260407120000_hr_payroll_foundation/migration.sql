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
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "machines_pkey" PRIMARY KEY ("id")
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
    "lead_time_days" INTEGER NOT NULL DEFAULT 7,
    "payment_terms" VARCHAR(60),
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
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory" (
    "id" TEXT NOT NULL,
    "material_code" VARCHAR(50) NOT NULL,
    "description" TEXT NOT NULL,
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
    "active" BOOLEAN NOT NULL DEFAULT true,
    "board_type" TEXT,
    "gsm" INTEGER,
    "sheet_length" DECIMAL(8,2),
    "sheet_width" DECIMAL(8,2),
    "grain_direction" TEXT,
    "caliper_microns" INTEGER,
    "brightness_pct" DECIMAL(5,2),
    "moisture_pct" DECIMAL(5,2),
    "hsn_code" VARCHAR(20),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "job_number" VARCHAR(30) NOT NULL,
    "customer_id" TEXT NOT NULL,
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
    "plate_store_id" TEXT,
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
    "job_id" TEXT NOT NULL,
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
    "remarks" TEXT,
    "carton_size" TEXT,
    "print_size" TEXT,
    "dye_condition" TEXT,
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
    "printing_type" TEXT,
    "screen_ruling_lpi" INTEGER DEFAULT 175,
    "min_font_size_pt" DECIMAL(4,2) DEFAULT 6.0,
    "barcode_type" TEXT,
    "barcode_position" TEXT,
    "artwork_code" TEXT,
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
    "carton_construct" TEXT,
    "crease_depth_mm" DECIMAL(4,2),
    "nick_count" INTEGER,
    "stripping_type" TEXT DEFAULT 'Auto',
    "pasting_type" TEXT,
    "glue_type" TEXT,
    "glue_bond_min_n" DECIMAL(6,2) DEFAULT 2.0,
    "overlap_width_mm" DECIMAL(6,2),
    "drug_schedule" TEXT,
    "regulatory_text" TEXT,
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
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dyes_pkey" PRIMARY KEY ("id")
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
    "remarks" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
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
    "remarks" TEXT,
    "set_number" TEXT,
    "job_card_number" INTEGER,
    "planning_status" TEXT NOT NULL DEFAULT 'pending',
    "spec_overrides" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "po_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_job_cards" (
    "id" TEXT NOT NULL,
    "job_card_number" SERIAL NOT NULL,
    "set_number" TEXT,
    "customer_id" TEXT NOT NULL,
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
    "excess_sheets" INTEGER,
    "counter" INTEGER,
    "file_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "completed_at" TIMESTAMP(3),
    "stage_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_stage_records_pkey" PRIMARY KEY ("id")
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

    CONSTRAINT "sheet_issue_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plate_store" (
    "id" TEXT NOT NULL,
    "plate_set_code" TEXT NOT NULL,
    "carton_id" TEXT,
    "carton_name" TEXT NOT NULL,
    "customer_id" TEXT,
    "artwork_code" TEXT,
    "artwork_version" TEXT,
    "artwork_id" TEXT,
    "number_of_colours" INTEGER NOT NULL,
    "colours" JSONB NOT NULL,
    "total_plates" INTEGER NOT NULL,
    "new_plates_count" INTEGER NOT NULL DEFAULT 0,
    "old_plates_count" INTEGER NOT NULL DEFAULT 0,
    "rack_location" TEXT,
    "slot_number" TEXT,
    "ctp_operator" TEXT,
    "ctp_date" DATE,
    "ctp_job_reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "current_job_card_id" TEXT,
    "issued_to" TEXT,
    "issued_at" TIMESTAMP(3),
    "expected_return" DATE,
    "returned_by" TEXT,
    "returned_at" TIMESTAMP(3),
    "return_condition" TEXT,
    "destroyed_count" INTEGER NOT NULL DEFAULT 0,
    "destroyed_reason" TEXT,
    "destroyed_by" TEXT,
    "destroyed_at" TIMESTAMP(3),
    "total_jobs_used" INTEGER NOT NULL DEFAULT 0,
    "last_used_job_card" TEXT,
    "last_used_date" DATE,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plate_store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plate_issue_records" (
    "id" TEXT NOT NULL,
    "plate_store_id" TEXT NOT NULL,
    "plate_set_code" TEXT NOT NULL,
    "job_card_id" TEXT,
    "job_card_number" INTEGER,
    "carton_name" TEXT,
    "artwork_code" TEXT,
    "issued_to" TEXT NOT NULL,
    "issued_by" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "colours_issued" JSONB NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'production',
    "returned_by" TEXT,
    "returned_at" TIMESTAMP(3),
    "return_condition" TEXT,
    "colours_returned" JSONB,
    "return_notes" TEXT,
    "colours_destroyed" JSONB,
    "destroy_reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'issued',

    CONSTRAINT "plate_issue_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plate_audit_log" (
    "id" TEXT NOT NULL,
    "plate_store_id" TEXT NOT NULL,
    "plate_set_code" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "performed_by" TEXT NOT NULL,
    "performed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB,
    "ip_address" TEXT,

    CONSTRAINT "plate_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plate_requirements" (
    "id" TEXT NOT NULL,
    "requirement_code" TEXT NOT NULL,
    "job_card_id" TEXT,
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
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plate_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "die_store" (
    "id" TEXT NOT NULL,
    "die_code" TEXT NOT NULL,
    "dye_id" TEXT,
    "die_number" INTEGER,
    "die_type" TEXT NOT NULL,
    "ups" INTEGER NOT NULL DEFAULT 1,
    "sheet_size" TEXT,
    "carton_size" TEXT,
    "carton_id" TEXT,
    "carton_name" TEXT,
    "customer_id" TEXT,
    "die_material" TEXT NOT NULL DEFAULT 'Steel Rule',
    "die_size" TEXT,
    "board_thickness" TEXT,
    "rule_height" TEXT,
    "number_of_rules" INTEGER,
    "number_of_creases" INTEGER,
    "nick_count" INTEGER,
    "vendor_id" TEXT,
    "vendor_name" TEXT,
    "vendor_order_ref" TEXT,
    "manufacturing_cost" DECIMAL(10,2),
    "manufacturing_days" INTEGER,
    "storage_location" TEXT,
    "compartment" TEXT,
    "impression_count" INTEGER NOT NULL DEFAULT 0,
    "max_impressions" INTEGER NOT NULL DEFAULT 500000,
    "sharpen_count" INTEGER NOT NULL DEFAULT 0,
    "max_sharpen_count" INTEGER NOT NULL DEFAULT 5,
    "total_jobs_used" INTEGER NOT NULL DEFAULT 0,
    "condition" TEXT NOT NULL DEFAULT 'New',
    "last_inspected_by" TEXT,
    "last_inspected_at" TIMESTAMP(3),
    "last_sharpened_at" DATE,
    "last_sharpened_by" TEXT,
    "status" TEXT NOT NULL DEFAULT 'in_stock',
    "current_job_card_id" TEXT,
    "issued_to" TEXT,
    "issued_at" TIMESTAMP(3),
    "expected_return" DATE,
    "returned_by" TEXT,
    "returned_at" TIMESTAMP(3),
    "return_condition" TEXT,
    "scrap_reason" TEXT,
    "scrapped_by" TEXT,
    "scrapped_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "die_store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "die_issue_records" (
    "id" TEXT NOT NULL,
    "die_store_id" TEXT NOT NULL,
    "die_code" TEXT NOT NULL,
    "die_number" INTEGER,
    "job_card_id" TEXT,
    "job_card_number" INTEGER,
    "carton_name" TEXT,
    "machine_code" TEXT,
    "issued_to" TEXT NOT NULL,
    "issued_by" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purpose" TEXT NOT NULL DEFAULT 'production',
    "impressions_at_issue" INTEGER NOT NULL DEFAULT 0,
    "returned_by" TEXT,
    "returned_at" TIMESTAMP(3),
    "impressions_at_return" INTEGER,
    "impressions_this_run" INTEGER,
    "return_condition" TEXT,
    "return_notes" TEXT,
    "action_taken" TEXT,
    "status" TEXT NOT NULL DEFAULT 'issued',

    CONSTRAINT "die_issue_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "die_maintenance_log" (
    "id" TEXT NOT NULL,
    "die_store_id" TEXT NOT NULL,
    "die_code" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "performed_by" TEXT NOT NULL,
    "performed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vendor_name" TEXT,
    "condition_before" TEXT,
    "condition_after" TEXT,
    "impressions_before" INTEGER,
    "cost" DECIMAL(10,2),
    "notes" TEXT,
    "next_action_due" DATE,

    CONSTRAINT "die_maintenance_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "die_vendor_orders" (
    "id" TEXT NOT NULL,
    "order_code" TEXT NOT NULL,
    "die_store_id" TEXT,
    "order_type" TEXT NOT NULL,
    "carton_name" TEXT,
    "carton_size" TEXT,
    "die_type" TEXT,
    "ups" INTEGER,
    "sheet_size" TEXT,
    "special_instructions" TEXT,
    "vendor_id" TEXT,
    "vendor_name" TEXT NOT NULL,
    "vendor_contact" TEXT,
    "quoted_cost" DECIMAL(10,2),
    "final_cost" DECIMAL(10,2),
    "advance_paid" DECIMAL(10,2),
    "ordered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expected_by" DATE,
    "received_at" TIMESTAMP(3),
    "is_overdue" BOOLEAN NOT NULL DEFAULT false,
    "job_card_id" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'Normal',
    "status" TEXT NOT NULL DEFAULT 'ordered',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "die_vendor_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "die_audit_log" (
    "id" TEXT NOT NULL,
    "die_store_id" TEXT NOT NULL,
    "die_code" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "performed_by" TEXT NOT NULL,
    "performed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB,

    CONSTRAINT "die_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "die_requirements" (
    "id" TEXT NOT NULL,
    "requirement_code" TEXT NOT NULL,
    "job_card_id" TEXT,
    "carton_name" TEXT NOT NULL,
    "carton_size" TEXT,
    "die_type" TEXT,
    "ups" INTEGER,
    "sheet_size" TEXT,
    "customer_id" TEXT,
    "requirement_type" TEXT NOT NULL,
    "existing_die_id" TEXT,
    "existing_die_code" TEXT,
    "existing_condition" TEXT,
    "vendor_order_id" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'Normal',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "die_requirements_pkey" PRIMARY KEY ("id")
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
    "block_size" TEXT,
    "emboss_depth" DECIMAL(4,2),
    "storage_location" TEXT,
    "impression_count" INTEGER NOT NULL DEFAULT 0,
    "max_impressions" INTEGER NOT NULL DEFAULT 100000,
    "condition" VARCHAR(40) NOT NULL DEFAULT 'Good',
    "last_polished_date" DATE,
    "polish_count" INTEGER NOT NULL DEFAULT 0,
    "manufacture_date" DATE,
    "parent_block_id" TEXT,
    "replaces_block_id" TEXT,
    "destroyed_at" TIMESTAMP(3),
    "destroy_reason" TEXT,
    "scrap_reason" TEXT,
    "scrapped_by" TEXT,
    "scrapped_at" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "emboss_blocks_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "emboss_block_custody_log" (
    "id" TEXT NOT NULL,
    "block_id" TEXT NOT NULL,
    "given_by" TEXT NOT NULL,
    "taken_by" TEXT NOT NULL,
    "checkout_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "return_at" TIMESTAMP(3),
    "condition_on_return" TEXT,
    "notes" TEXT,

    CONSTRAINT "emboss_block_custody_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "block_transactions" (
    "id" TEXT NOT NULL,
    "block_id" TEXT NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "operator_id" TEXT NOT NULL,
    "supervisor_id" TEXT NOT NULL,
    "impressions_count" INTEGER,
    "condition" VARCHAR(40) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "block_transactions_pkey" PRIMARY KEY ("id")
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
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paper_warehouse_pkey" PRIMARY KEY ("id")
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
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_requisitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "material_id" TEXT NOT NULL,
    "movement_type" VARCHAR(40) NOT NULL,
    "qty" DECIMAL(12,3) NOT NULL,
    "qty_weight_kg" DECIMAL(12,3),
    "entry_unit" VARCHAR(10),
    "lot_number" VARCHAR(60),
    "mill_date" DATE,
    "pallet_count" INTEGER,
    "price_per_kg" DECIMAL(12,4),
    "ref_type" VARCHAR(40),
    "ref_id" TEXT,
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "code_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firm" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "transaction_mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "esi_payable" BOOLEAN NOT NULL DEFAULT false,
    "bank_name" TEXT,
    "account_number" TEXT,
    "ifsc_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_records" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "base_salary" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "increment" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "present_days" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "absent_days" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overtime_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overtime_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "misc_additions" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "holiday_pay" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "advances" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "loans" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "installments" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_salary" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "final_payment" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "payment_status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salary_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_role_name_key" ON "roles"("role_name");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "machines_machine_code_key" ON "machines"("machine_code");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_material_code_key" ON "inventory"("material_code");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_job_number_key" ON "jobs"("job_number");

-- CreateIndex
CREATE UNIQUE INDEX "artwork_approvals_artwork_id_lock_number_key" ON "artwork_approvals"("artwork_id", "lock_number");

-- CreateIndex
CREATE UNIQUE INDEX "qc_instruments_instrument_name_key" ON "qc_instruments"("instrument_name");

-- CreateIndex
CREATE UNIQUE INDEX "dyes_dye_number_key" ON "dyes"("dye_number");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_po_number_key" ON "purchase_orders"("po_number");

-- CreateIndex
CREATE UNIQUE INDEX "production_job_cards_job_card_number_key" ON "production_job_cards"("job_card_number");

-- CreateIndex
CREATE UNIQUE INDEX "plate_store_plate_set_code_key" ON "plate_store"("plate_set_code");

-- CreateIndex
CREATE UNIQUE INDEX "plate_requirements_requirement_code_key" ON "plate_requirements"("requirement_code");

-- CreateIndex
CREATE UNIQUE INDEX "die_store_die_code_key" ON "die_store"("die_code");

-- CreateIndex
CREATE UNIQUE INDEX "die_vendor_orders_order_code_key" ON "die_vendor_orders"("order_code");

-- CreateIndex
CREATE UNIQUE INDEX "die_requirements_requirement_code_key" ON "die_requirements"("requirement_code");

-- CreateIndex
CREATE UNIQUE INDEX "emboss_blocks_block_code_key" ON "emboss_blocks"("block_code");

-- CreateIndex
CREATE INDEX "block_transactions_block_id_type_idx" ON "block_transactions"("block_id", "type");

-- CreateIndex
CREATE INDEX "block_transactions_block_id_created_at_idx" ON "block_transactions"("block_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "bills_bill_number_key" ON "bills"("bill_number");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_stages_job_id_stage_number_key" ON "workflow_stages"("job_id", "stage_number");

-- CreateIndex
CREATE UNIQUE INDEX "rfqs_rfq_number_key" ON "rfqs"("rfq_number");

-- CreateIndex
CREATE UNIQUE INDEX "employees_code_no_key" ON "employees"("code_no");

-- CreateIndex
CREATE INDEX "employees_firm_idx" ON "employees"("firm");

-- CreateIndex
CREATE INDEX "employees_department_idx" ON "employees"("department");

-- CreateIndex
CREATE INDEX "employees_transaction_mode_idx" ON "employees"("transaction_mode");

-- CreateIndex
CREATE INDEX "employees_status_idx" ON "employees"("status");

-- CreateIndex
CREATE INDEX "salary_records_month_year_idx" ON "salary_records"("month", "year");

-- CreateIndex
CREATE INDEX "salary_records_payment_status_idx" ON "salary_records"("payment_status");

-- CreateIndex
CREATE UNIQUE INDEX "salary_records_employee_id_month_year_key" ON "salary_records"("employee_id", "month", "year");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "artwork_approvals" ADD CONSTRAINT "artwork_approvals_plate_store_id_fkey" FOREIGN KEY ("plate_store_id") REFERENCES "plate_store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartons" ADD CONSTRAINT "cartons_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartons" ADD CONSTRAINT "cartons_dye_id_fkey" FOREIGN KEY ("dye_id") REFERENCES "dyes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartons" ADD CONSTRAINT "cartons_emboss_block_id_fkey" FOREIGN KEY ("emboss_block_id") REFERENCES "emboss_blocks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dye_usage_log" ADD CONSTRAINT "dye_usage_log_dye_id_fkey" FOREIGN KEY ("dye_id") REFERENCES "dyes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dye_maintenance_log" ADD CONSTRAINT "dye_maintenance_log_dye_id_fkey" FOREIGN KEY ("dye_id") REFERENCES "dyes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_line_items" ADD CONSTRAINT "po_line_items_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_job_cards" ADD CONSTRAINT "production_job_cards_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_job_cards" ADD CONSTRAINT "production_job_cards_plate_set_id_fkey" FOREIGN KEY ("plate_set_id") REFERENCES "plate_store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_job_cards" ADD CONSTRAINT "production_job_cards_emboss_block_id_fkey" FOREIGN KEY ("emboss_block_id") REFERENCES "emboss_blocks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_stage_records" ADD CONSTRAINT "production_stage_records_job_card_id_fkey" FOREIGN KEY ("job_card_id") REFERENCES "production_job_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_issue_records" ADD CONSTRAINT "sheet_issue_records_job_card_id_fkey" FOREIGN KEY ("job_card_id") REFERENCES "production_job_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plate_store" ADD CONSTRAINT "plate_store_carton_id_fkey" FOREIGN KEY ("carton_id") REFERENCES "cartons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plate_store" ADD CONSTRAINT "plate_store_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plate_store" ADD CONSTRAINT "plate_store_current_job_card_id_fkey" FOREIGN KEY ("current_job_card_id") REFERENCES "production_job_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plate_issue_records" ADD CONSTRAINT "plate_issue_records_plate_store_id_fkey" FOREIGN KEY ("plate_store_id") REFERENCES "plate_store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plate_audit_log" ADD CONSTRAINT "plate_audit_log_plate_store_id_fkey" FOREIGN KEY ("plate_store_id") REFERENCES "plate_store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "die_store" ADD CONSTRAINT "die_store_dye_id_fkey" FOREIGN KEY ("dye_id") REFERENCES "dyes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "die_issue_records" ADD CONSTRAINT "die_issue_records_die_store_id_fkey" FOREIGN KEY ("die_store_id") REFERENCES "die_store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "die_maintenance_log" ADD CONSTRAINT "die_maintenance_log_die_store_id_fkey" FOREIGN KEY ("die_store_id") REFERENCES "die_store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "die_vendor_orders" ADD CONSTRAINT "die_vendor_orders_die_store_id_fkey" FOREIGN KEY ("die_store_id") REFERENCES "die_store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "die_audit_log" ADD CONSTRAINT "die_audit_log_die_store_id_fkey" FOREIGN KEY ("die_store_id") REFERENCES "die_store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emboss_block_usage_log" ADD CONSTRAINT "emboss_block_usage_log_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "emboss_blocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emboss_block_maintenance_log" ADD CONSTRAINT "emboss_block_maintenance_log_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "emboss_blocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emboss_block_custody_log" ADD CONSTRAINT "emboss_block_custody_log_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "emboss_blocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "block_transactions" ADD CONSTRAINT "block_transactions_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "emboss_blocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "inventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_records" ADD CONSTRAINT "salary_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

