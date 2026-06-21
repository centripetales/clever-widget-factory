# Database Schema Diagram

```mermaid
erDiagram
  action_embedding {
    uuid id PK NOT NULL
    uuid action_id NOT NULL
    character varying embedding_type NOT NULL
    character varying model NOT NULL
    USER-DEFINED embedding
    timestamp with time zone created_at
  }
  action_exploration {
    uuid action_id PK NOT NULL
    uuid action_id NOT NULL
    uuid exploration_id NOT NULL
    uuid exploration_id PK NOT NULL
    timestamp without time zone created_at
    timestamp without time zone updated_at
  }
  action_implementation_updates {
    uuid id PK NOT NULL
    uuid action_id NOT NULL
    uuid updated_by NOT NULL
    text update_text NOT NULL
    text update_type NOT NULL
    timestamp with time zone created_at
    timestamp without time zone updated_at
  }
  action_scores {
    uuid id PK NOT NULL
    uuid action_id NOT NULL
    uuid action_id NOT NULL
    text source_type NOT NULL
    uuid source_id NOT NULL
    uuid prompt_id NOT NULL
    text prompt_text NOT NULL
    jsonb scores NOT NULL
    jsonb ai_response
    ARRAY likely_root_causes
    timestamp with time zone created_at NOT NULL
    timestamp with time zone updated_at NOT NULL
    uuid asset_context_id
    text asset_context_name
    text score_attribution_type
    uuid organization_id NOT NULL
  }
  actions {
    uuid id PK NOT NULL
    uuid mission_id
    text title NOT NULL
    text description
    uuid assigned_to
    text status NOT NULL
    timestamp with time zone created_at NOT NULL
    timestamp with time zone updated_at NOT NULL
    timestamp with time zone completed_at
    text policy
    ARRAY required_tools
    uuid linked_issue_id
    text issue_reference
    ARRAY attachments
    uuid asset_id
    jsonb scoring_data
    jsonb required_stock
    boolean plan_commitment
    ARRAY participants
    uuid organization_id NOT NULL
    uuid created_by
    uuid updated_by
    timestamp without time zone policy_agreed_at
    text policy_agreed_by
    USER-DEFINED search_embedding
    uuid policy_id
    boolean is_exploration
    text expected_state
    jsonb skill_profile
  }
  analyses {
    uuid id PK NOT NULL
    uuid organization_id NOT NULL
    uuid created_by
    uuid prompt_id NOT NULL
    jsonb ai_response
    timestamp without time zone created_at
    timestamp without time zone updated_at
  }
  analysis_attributes {
    uuid id PK NOT NULL
    uuid analysis_id NOT NULL
    uuid analysis_id NOT NULL
    text attribute_name NOT NULL
    ARRAY attribute_values NOT NULL
    timestamp without time zone created_at
    timestamp without time zone updated_at
  }
  analysis_contexts {
    uuid id PK NOT NULL
    uuid analysis_id NOT NULL
    uuid analysis_id NOT NULL
    text context_service NOT NULL
    uuid context_id NOT NULL
    timestamp without time zone created_at
  }
  analysis_scores {
    uuid id PK NOT NULL
    uuid analysis_id NOT NULL
    uuid analysis_id NOT NULL
    text score_name NOT NULL
    numeric score NOT NULL
    text reason NOT NULL
    text how_to_improve
    timestamp without time zone created_at
    timestamp without time zone updated_at
  }
  asset_history {
    uuid id PK NOT NULL
    uuid asset_id NOT NULL
    uuid changed_by NOT NULL
    timestamp with time zone changed_at NOT NULL
    text change_type NOT NULL
    text field_changed
    text old_value
    text new_value
    text notes
    uuid organization_id NOT NULL
    timestamp with time zone created_at NOT NULL
  }
  checkins {
    uuid id PK NOT NULL
    uuid checkout_id
    uuid tool_id NOT NULL
    timestamp with time zone checkin_date NOT NULL
    text problems_reported
    text notes
    timestamp with time zone created_at NOT NULL
    numeric hours_used
    ARRAY after_image_urls
    text sop_best_practices NOT NULL
    text what_did_you_do NOT NULL
    text checkin_reason
    uuid organization_id NOT NULL
    text user_id
  }
  checkouts {
    uuid id PK NOT NULL
    uuid tool_id NOT NULL
    text intended_usage
    timestamp with time zone checkout_date
    date expected_return_date
    text before_image_url
    text notes
    boolean is_returned NOT NULL
    timestamp with time zone created_at NOT NULL
    text pre_existing_issues
    text user_id NOT NULL
    uuid organization_id NOT NULL
    uuid action_id
  }
  claim_perspectives {
    uuid id NOT NULL
    uuid id PK NOT NULL
    text content NOT NULL
  }
  energeia_cache {
    uuid id PK NOT NULL
    uuid organization_id NOT NULL
    uuid organization_id NOT NULL
    integer k NOT NULL
    integer time_window_days NOT NULL
    jsonb payload NOT NULL
    timestamp with time zone computed_at NOT NULL
    timestamp with time zone created_at NOT NULL
    timestamp with time zone updated_at NOT NULL
  }
  entity_changes {
    uuid id PK NOT NULL
    character varying entity_type NOT NULL
    uuid entity_id NOT NULL
    character varying mutation_type NOT NULL
    uuid organization_id NOT NULL
    character varying changed_by_connection_id
    timestamp with time zone created_at NOT NULL
  }
  entropy_perspectives {
    uuid id NOT NULL
    uuid id PK NOT NULL
    text content NOT NULL
  }
  epistemic_links {
    uuid id PK NOT NULL
    uuid source_state_id NOT NULL
    uuid target_state_id NOT NULL
    timestamp with time zone created_at NOT NULL
  }
  experience_components {
    uuid id PK NOT NULL
    uuid experience_id NOT NULL
    character varying component_type NOT NULL
    uuid state_id
    uuid action_id
    uuid organization_id NOT NULL
    timestamp with time zone created_at
  }
  experiences {
    uuid id PK NOT NULL
    character varying entity_type NOT NULL
    uuid entity_id NOT NULL
    uuid organization_id NOT NULL
    uuid created_by NOT NULL
    timestamp with time zone created_at
  }
  exploration {
    uuid id PK NOT NULL
    uuid action_id
    uuid action_id
    character varying exploration_code NOT NULL
    text exploration_notes_text
    text metrics_text
    boolean public_flag
    timestamp with time zone created_at
    timestamp with time zone updated_at
    ARRAY key_photos
    USER-DEFINED status
    text name
  }
  exploration_embedding {
    uuid id PK NOT NULL
    uuid exploration_id NOT NULL
    character varying embedding_type NOT NULL
    character varying model NOT NULL
    USER-DEFINED embedding
    timestamp with time zone created_at
  }
  financial_record_edits {
    uuid id PK NOT NULL
    uuid record_id NOT NULL
    uuid edited_by NOT NULL
    timestamp with time zone edited_at NOT NULL
    character varying field_changed NOT NULL
    text old_value
    text new_value
  }
  financial_records {
    uuid id PK NOT NULL
    uuid organization_id NOT NULL
    uuid created_by
    date transaction_date NOT NULL
    numeric amount NOT NULL
    timestamp with time zone created_at NOT NULL
    timestamp with time zone updated_at NOT NULL
    character varying payment_method NOT NULL
    numeric balance_after
  }
  five_whys_sessions {
    uuid id PK NOT NULL
    uuid issue_id NOT NULL
    uuid organization_id NOT NULL
    jsonb conversation_history
    text root_cause_analysis
    text status NOT NULL
    timestamp with time zone created_at
    timestamp with time zone updated_at
    uuid created_by
  }
  issue_history {
    uuid id PK NOT NULL
    uuid issue_id NOT NULL
    uuid changed_by NOT NULL
    timestamp with time zone changed_at NOT NULL
    timestamp with time zone created_at NOT NULL
    text old_status
    text new_status NOT NULL
    text field_changed
    text old_value
    text new_value
    text notes
    uuid organization_id NOT NULL
  }
  issue_requirements {
    uuid id PK NOT NULL
    uuid issue_id
    USER-DEFINED attribute_type NOT NULL
    integer required_level NOT NULL
    timestamp with time zone created_at
    uuid organization_id NOT NULL
  }
  issues {
    uuid id PK NOT NULL
    USER-DEFINED context_type NOT NULL
    uuid context_id NOT NULL
    uuid reported_by NOT NULL
    timestamp with time zone reported_at NOT NULL
    uuid resolved_by
    timestamp with time zone resolved_at
    timestamp with time zone created_at NOT NULL
    timestamp with time zone updated_at NOT NULL
    boolean is_misuse NOT NULL
    uuid related_checkout_id
    boolean responsibility_assigned NOT NULL
    numeric efficiency_loss_percentage
    USER-DEFINED action_required
    USER-DEFINED workflow_status NOT NULL
    uuid diagnosed_by
    timestamp with time zone diagnosed_at
    uuid assigned_to
    boolean ready_to_work
    jsonb materials_needed
    boolean can_self_claim
    numeric estimated_hours
    numeric actual_hours
    text issue_type NOT NULL
    text status NOT NULL
    ARRAY report_photo_urls
    text root_cause
    text resolution_notes
    ARRAY resolution_photo_urls
    text next_steps
    text ai_analysis
    text damage_assessment
    text work_progress
    text description NOT NULL
    jsonb issue_metadata
    uuid organization_id NOT NULL
    USER-DEFINED search_embedding
  }
  llm_generation_configs {
    uuid id PK NOT NULL
    character varying model_id NOT NULL
    character varying version NOT NULL
    text system_prompt NOT NULL
    jsonb inference_config NOT NULL
    timestamp with time zone created_at
  }
  metric_snapshots {
    uuid snapshot_id PK NOT NULL
    uuid state_id NOT NULL
    uuid state_id NOT NULL
    uuid metric_id NOT NULL
    uuid metric_id NOT NULL
    text value NOT NULL
    text notes
    timestamp with time zone created_at
    timestamp with time zone updated_at
  }
  metrics {
    uuid metric_id PK NOT NULL
    uuid tool_id NOT NULL
    character varying name NOT NULL
    character varying unit
    numeric benchmark_value
    text details
    timestamp without time zone created_at
    uuid organization_id NOT NULL
  }
  mission_attachments {
    uuid id PK NOT NULL
    uuid mission_id
    uuid task_id
    text file_url NOT NULL
    text file_name NOT NULL
    text file_type NOT NULL
    text attachment_type NOT NULL
    uuid uploaded_by NOT NULL
    timestamp with time zone created_at NOT NULL
    uuid organization_id NOT NULL
  }
  missions {
    uuid id PK NOT NULL
    text title NOT NULL
    text problem_statement NOT NULL
    text status NOT NULL
    uuid created_by NOT NULL
    uuid qa_assigned_to
    timestamp with time zone created_at NOT NULL
    timestamp with time zone updated_at NOT NULL
    timestamp with time zone completed_at
    text template_id
    text template_name
    text template_color
    text template_icon
    integer mission_number NOT NULL
    text qa_feedback
    uuid organization_id NOT NULL
  }
  organization_members {
    uuid id PK NOT NULL
    uuid organization_id NOT NULL
    uuid organization_id NOT NULL
    uuid organization_id NOT NULL
    uuid user_id NOT NULL
    text role NOT NULL
    uuid invited_by
    timestamp with time zone created_at NOT NULL
    boolean is_active NOT NULL
    text full_name
    boolean super_admin
    text cognito_user_id
    text email
    text favorite_color
    jsonb settings
  }
  organizations {
    uuid id PK NOT NULL
    text name NOT NULL
    text subdomain
    jsonb settings
    boolean is_active NOT NULL
    timestamp with time zone created_at NOT NULL
    timestamp with time zone updated_at NOT NULL
    jsonb ai_config
  }
  parts {
    uuid id PK NOT NULL
    text name NOT NULL
    text description
    text category
    text storage_vicinity
    numeric current_quantity NOT NULL
    numeric minimum_quantity
    text unit
    numeric cost_per_unit
    text supplier
    text image_url
    timestamp with time zone created_at NOT NULL
    timestamp with time zone updated_at NOT NULL
    uuid supplier_id
    text storage_location
    text cost_evidence_url
    text legacy_storage_vicinity
    uuid organization_id NOT NULL
    uuid parent_structure_id
    uuid accountable_person_id
    USER-DEFINED search_embedding
    text search_text
    USER-DEFINED search_embedding_v2
    boolean sellable NOT NULL
    text policy
    bigint target_population_scale NOT NULL
  }
  parts_history {
    uuid id PK NOT NULL
    uuid part_id NOT NULL
    text change_type NOT NULL
    numeric old_quantity
    numeric new_quantity
    numeric quantity_change
    text change_reason
    timestamp with time zone changed_at NOT NULL
    timestamp with time zone created_at NOT NULL
    uuid changed_by NOT NULL
    uuid order_id
    text supplier_name
    text supplier_url
    uuid organization_id NOT NULL
  }
  parts_orders {
    uuid id PK NOT NULL
    uuid part_id NOT NULL
    numeric quantity_ordered NOT NULL
    numeric quantity_received NOT NULL
    text supplier_name
    uuid supplier_id
    numeric estimated_cost
    text order_details
    text notes
    date expected_delivery_date
    uuid ordered_by NOT NULL
    timestamp with time zone ordered_at NOT NULL
    text status NOT NULL
    timestamp with time zone created_at NOT NULL
    timestamp with time zone updated_at NOT NULL
    uuid organization_id NOT NULL
  }
  pending_perspectives {
    uuid id PK NOT NULL
    uuid state_id NOT NULL
    character varying status NOT NULL
    integer attempt_count
    text last_error
    timestamp with time zone created_at
    timestamp with time zone processed_at
  }
  perspective_links {
    uuid id PK NOT NULL
    uuid source_perspective_id NOT NULL
    character varying link_type NOT NULL
    uuid target_perspective_id
    uuid target_state_id
    numeric similarity_score NOT NULL
    timestamp with time zone created_at
  }
  photo_analysis_params {
    uuid id PK NOT NULL
    character varying prompt_key NOT NULL
    character varying model_id NOT NULL
    character varying version NOT NULL
    text system_prompt
    jsonb inference_config NOT NULL
    timestamp with time zone created_at
  }
  photo_metadata_extractions {
    uuid id PK NOT NULL
    character varying photo_url NOT NULL
    numeric gps_latitude
    numeric gps_longitude
    numeric gps_altitude
    timestamp with time zone captured_at
    character varying device_make
    character varying device_model
    jsonb raw_exif NOT NULL
    numeric risk_liquid
    numeric risk_exploit
    numeric risk_geo
    numeric risk_ident
    numeric aggregate_risk
    timestamp with time zone created_at
    timestamp with time zone updated_at
  }
  policy {
    uuid id PK NOT NULL
    character varying title NOT NULL
    text description_text NOT NULL
    character varying status
    date effective_from
    date effective_to
    uuid created_by_user_id NOT NULL
    timestamp with time zone created_at
    timestamp with time zone updated_at
  }
  policy_embedding {
    uuid id PK NOT NULL
    uuid policy_id NOT NULL
    character varying embedding_type NOT NULL
    character varying model NOT NULL
    USER-DEFINED embedding
    timestamp with time zone created_at
  }
  profiles {
    uuid id PK NOT NULL
    uuid user_id NOT NULL
    timestamp with time zone created_at NOT NULL
    timestamp with time zone updated_at NOT NULL
    boolean super_admin
    text favorite_color
    text full_name
  }
  rsp_outbox {
    uuid id PK NOT NULL
    uuid state_id NOT NULL
    text idempotency_key NOT NULL
    character varying status NOT NULL
    integer attempt_count NOT NULL
    text last_error
    timestamp with time zone triggered_at NOT NULL
    timestamp with time zone processed_at
  }
  scoring_prompts {
    uuid id PK NOT NULL
    text name NOT NULL
    text prompt_text NOT NULL
    boolean is_default NOT NULL
    uuid created_by NOT NULL
    timestamp with time zone created_at NOT NULL
    timestamp with time zone updated_at NOT NULL
    uuid organization_id NOT NULL
  }
  significance_perspectives {
    uuid id NOT NULL
    uuid id PK NOT NULL
    text content NOT NULL
  }
  state_links {
    uuid id PK NOT NULL
    uuid state_id NOT NULL
    uuid state_id NOT NULL
    text entity_type NOT NULL
    uuid entity_id NOT NULL
    timestamp with time zone created_at
  }
  state_perspectives {
    uuid id PK NOT NULL
    uuid state_id NOT NULL
    character varying perspective_type NOT NULL
    uuid llm_generation_config_id NOT NULL
    character varying status NOT NULL
    text error_message
    timestamp with time zone created_at
  }
  state_photos {
    uuid id PK NOT NULL
    uuid state_id NOT NULL
    uuid state_id NOT NULL
    text photo_url NOT NULL
    text photo_description
    integer photo_order NOT NULL
    text requested_model
  }
  state_risk_profiles {
    uuid id PK NOT NULL
    uuid state_id NOT NULL
    uuid state_id NOT NULL
    numeric risk_liquid
    numeric risk_exploit
    numeric risk_geo
    numeric risk_ident
    numeric aggregate_risk
    timestamp with time zone created_at
    timestamp with time zone updated_at
  }
  state_space_model_associations {
    uuid id PK NOT NULL
    uuid model_id NOT NULL
    uuid model_id NOT NULL
    text entity_type NOT NULL
    uuid entity_id NOT NULL
    timestamp with time zone created_at
  }
  state_space_models {
    uuid id PK NOT NULL
    uuid organization_id NOT NULL
    uuid organization_id NOT NULL
    text name NOT NULL
    text description
    text version
    text author
    json model_definition NOT NULL
    boolean is_public
    text created_by
    timestamp with time zone created_at
    timestamp with time zone updated_at
  }
  states {
    uuid id PK NOT NULL
    uuid organization_id NOT NULL
    text state_text
    uuid captured_by
    timestamp with time zone captured_at NOT NULL
    timestamp with time zone created_at
    timestamp with time zone updated_at
  }
  storage_vicinities {
    uuid id PK NOT NULL
    text name NOT NULL
    text description
    uuid created_by NOT NULL
    timestamp with time zone created_at NOT NULL
    timestamp with time zone updated_at NOT NULL
    boolean is_active NOT NULL
    uuid organization_id NOT NULL
  }
  suppliers {
    uuid id PK NOT NULL
    text name NOT NULL
    jsonb contact_info
    numeric quality_rating
    text notes
    boolean is_active NOT NULL
    timestamp with time zone created_at NOT NULL
    timestamp with time zone updated_at NOT NULL
    uuid organization_id NOT NULL
  }
  tool_audits {
    uuid id PK NOT NULL
    uuid tool_id NOT NULL
    uuid audited_by NOT NULL
    timestamp with time zone audited_at NOT NULL
    text audit_comments
    ARRAY photo_urls
    boolean flagged_for_maintenance NOT NULL
    uuid last_user_identified
    timestamp with time zone created_at NOT NULL
    uuid organization_id NOT NULL
  }
  tools {
    uuid id PK NOT NULL
    text name NOT NULL
    text description
    text category
    text legacy_storage_vicinity
    text actual_location
    USER-DEFINED status NOT NULL
    text serial_number
    date last_maintenance
    text image_url
    timestamp with time zone created_at NOT NULL
    timestamp with time zone updated_at NOT NULL
    text manual_url
    text known_issues
    boolean has_motor NOT NULL
    text stargazer_sop
    text storage_location
    timestamp with time zone last_audited_at
    text audit_status
    uuid parent_structure_id
    uuid organization_id NOT NULL
    uuid accountable_person_id
    USER-DEFINED search_embedding
    text search_text
    USER-DEFINED search_embedding_v2
    text policy
    bigint target_population_scale NOT NULL
  }
  unified_embeddings {
    uuid id PK NOT NULL
    character varying entity_type NOT NULL
    uuid entity_id NOT NULL
    text embedding_source NOT NULL
    character varying model_version NOT NULL
    USER-DEFINED embedding NOT NULL
    uuid organization_id NOT NULL
    timestamp with time zone created_at
    timestamp with time zone updated_at
    uuid action_id
    text axis_key
  }
  websocket_connections {
    uuid id PK NOT NULL
    character varying connection_id NOT NULL
    uuid user_id NOT NULL
    uuid organization_id NOT NULL
    timestamp with time zone connected_at NOT NULL
    timestamp with time zone disconnected_at
  }
  worker_attributes {
    uuid id PK NOT NULL
    uuid user_id
    uuid user_id
    USER-DEFINED attribute_type NOT NULL
    integer level
    timestamp with time zone earned_at
    timestamp with time zone created_at
    timestamp with time zone updated_at
    uuid organization_id NOT NULL
  }
  worker_performance {
    uuid id PK NOT NULL
    uuid user_id
    uuid issue_id
    text outcome
    ARRAY attributes_used
    integer level_at_completion
    text completion_notes
    text supervisor_notes
    numeric hours_worked
    timestamp with time zone completed_at
    timestamp with time zone created_at
    uuid organization_id NOT NULL
  }
  worker_strategic_attributes {
    uuid id PK NOT NULL
    uuid user_id
    USER-DEFINED attribute_type NOT NULL
    integer level
    timestamp with time zone earned_at
    timestamp with time zone created_at
    timestamp with time zone updated_at
    uuid organization_id NOT NULL
  }
  actions ||--o{ action_embedding : action_id
  actions ||--o{ action_exploration : action_id
  exploration ||--o{ action_exploration : exploration_id
  actions ||--o{ action_implementation_updates : action_id
  actions ||--o{ action_scores : action_id
  organizations ||--o{ action_scores : organization_id
  missions ||--o{ actions : mission_id
  organizations ||--o{ actions : organization_id
  policy ||--o{ actions : policy_id
  profiles ||--o{ actions : assigned_to
  organizations ||--o{ analyses : organization_id
  analyses ||--o{ analysis_attributes : analysis_id
  analyses ||--o{ analysis_contexts : analysis_id
  analyses ||--o{ analysis_scores : analysis_id
  organizations ||--o{ asset_history : organization_id
  tools ||--o{ asset_history : asset_id
  checkouts ||--o{ checkins : checkout_id
  organizations ||--o{ checkins : organization_id
  tools ||--o{ checkins : tool_id
  actions ||--o{ checkouts : action_id
  organizations ||--o{ checkouts : organization_id
  tools ||--o{ checkouts : tool_id
  state_perspectives ||--o{ claim_perspectives : id
  organizations ||--o{ energeia_cache : organization_id
  organizations ||--o{ entity_changes : organization_id
  state_perspectives ||--o{ entropy_perspectives : id
  states ||--o{ epistemic_links : source_state_id
  states ||--o{ epistemic_links : target_state_id
  actions ||--o{ experience_components : action_id
  experiences ||--o{ experience_components : experience_id
  organizations ||--o{ experience_components : organization_id
  states ||--o{ experience_components : state_id
  organization_members ||--o{ experiences : created_by
  organizations ||--o{ experiences : organization_id
  actions ||--o{ exploration : action_id
  exploration ||--o{ exploration_embedding : exploration_id
  financial_records ||--o{ financial_record_edits : record_id
  organizations ||--o{ financial_records : organization_id
  issues ||--o{ five_whys_sessions : issue_id
  organizations ||--o{ five_whys_sessions : organization_id
  organizations ||--o{ issue_history : organization_id
  organizations ||--o{ issue_requirements : organization_id
  organizations ||--o{ issues : organization_id
  metrics ||--o{ metric_snapshots : metric_id
  states ||--o{ metric_snapshots : state_id
  organizations ||--o{ metrics : organization_id
  tools ||--o{ metrics : tool_id
  actions ||--o{ mission_attachments : task_id
  missions ||--o{ mission_attachments : mission_id
  organizations ||--o{ mission_attachments : organization_id
  profiles ||--o{ mission_attachments : uploaded_by
  organizations ||--o{ missions : organization_id
  profiles ||--o{ missions : created_by
  profiles ||--o{ missions : qa_assigned_to
  organizations ||--o{ organization_members : organization_id
  organizations ||--o{ parts : organization_id
  suppliers ||--o{ parts : supplier_id
  organizations ||--o{ parts_history : organization_id
  parts_orders ||--o{ parts_history : order_id
  profiles ||--o{ parts_history : changed_by
  organizations ||--o{ parts_orders : organization_id
  states ||--o{ pending_perspectives : state_id
  state_perspectives ||--o{ perspective_links : source_perspective_id
  state_perspectives ||--o{ perspective_links : target_perspective_id
  states ||--o{ perspective_links : target_state_id
  policy ||--o{ policy_embedding : policy_id
  states ||--o{ rsp_outbox : state_id
  organizations ||--o{ scoring_prompts : organization_id
  state_perspectives ||--o{ significance_perspectives : id
  states ||--o{ state_links : state_id
  llm_generation_configs ||--o{ state_perspectives : llm_generation_config_id
  states ||--o{ state_perspectives : state_id
  states ||--o{ state_photos : state_id
  states ||--o{ state_risk_profiles : state_id
  state_space_models ||--o{ state_space_model_associations : model_id
  organizations ||--o{ state_space_models : organization_id
  organizations ||--o{ states : organization_id
  organizations ||--o{ storage_vicinities : organization_id
  organizations ||--o{ suppliers : organization_id
  organizations ||--o{ tool_audits : organization_id
  profiles ||--o{ tool_audits : audited_by
  profiles ||--o{ tool_audits : last_user_identified
  tools ||--o{ tool_audits : tool_id
  organizations ||--o{ tools : organization_id
  tools ||--o{ tools : parent_structure_id
  organizations ||--o{ unified_embeddings : organization_id
  organizations ||--o{ websocket_connections : organization_id
  organizations ||--o{ worker_attributes : organization_id
  profiles ||--o{ worker_attributes : user_id
  organizations ||--o{ worker_performance : organization_id
  profiles ||--o{ worker_performance : user_id
  organizations ||--o{ worker_strategic_attributes : organization_id
  profiles ||--o{ worker_strategic_attributes : user_id
```
