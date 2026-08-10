-- Plates received before the Fresh/Used rack workflow were left reserved in
-- GRN staging even though their linked requirement components were available.
-- Move only that exact legacy shape and retain the transition in the asset log.
WITH candidates AS (
  SELECT pa.id,pa.status AS from_status,pa.rack_location AS from_location,
    pa.current_job_card_id,pa.condition,
    prc.id AS request_component_id,prc.tooling_request_id
  FROM plate_assets pa
  LEFT JOIN LATERAL (
    SELECT c.id,c.tooling_request_id
    FROM plate_request_components c
    WHERE c.matched_asset_id=pa.id AND c.status='available'
    ORDER BY c.id
    LIMIT 1
  ) prc ON true
  WHERE pa.status='reserved'
    AND pa.rack_location='GRN staging'
    AND pa.source_grn_id IS NOT NULL
    AND prc.id IS NOT NULL
), moved AS (
  UPDATE plate_assets pa
  SET status='available',rack_location='Fresh Plates Rack',current_job_card_id=NULL,
    updated_at=now()
  FROM candidates c
  WHERE pa.id=c.id
  RETURNING pa.id,c.from_status,c.from_location,c.current_job_card_id,c.condition,
    c.request_component_id,c.tooling_request_id
)
INSERT INTO plate_asset_movements
  (plate_asset_id,request_component_id,tooling_request_id,job_card_id,action,
   from_status,to_status,from_location,to_location,condition,note,user_name)
SELECT id,request_component_id,tooling_request_id,current_job_card_id,'location_changed',
  from_status,'available',from_location,'Fresh Plates Rack',condition,
  'Legacy GRN staging backfill','System migration'
FROM moved;
