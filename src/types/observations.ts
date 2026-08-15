export interface Observation {
  id: string;
  organization_id: string;
  observation_text: string | null;
  captured_by: string;
  captured_by_name?: string;
  captured_at: string;
  created_at: string;
  updated_at: string;
  photos: ObservationPhoto[];
  links: ObservationLink[];
  shared_with_partners?: boolean;
  is_shared_inbound?: boolean;
  perspectives?: {
    perspective_type: string;
    content: string;
    status?: string; // 'PENDING' used as optimistic sentinel
    created_at?: string | null;
    model_id?: string | null;
    system_prompt?: string | null;
  }[];
}

export interface ObservationPhoto {
  id: string;
  observation_id: string;
  photo_url: string;
  photo_description: string | null;
  photo_order: number;
  transcription?: string | null;
  model_id?: string | null;
  system_prompt?: string | null;
  transcription_created_at?: string | null;
}

export interface ObservationLink {
  id: string;
  observation_id: string;
  entity_type: string;
  entity_id: string;
}

export interface CreateObservationData {
  state_text?: string;  // Backend field name (general concept)
  captured_at?: string;
  shared_with_partners?: boolean;
  photos: Array<{
    photo_url: string;
    photo_description?: string;
    photo_order?: number;
    // Write-once, client-captured-at-selection-time metadata (see
    // PhotoUploadPanel's PhotoItem). Never round-tripped from an existing
    // photo — only present for newly selected photos in this submission.
    client_captured_at?: string;
    capture_method?: 'camera' | 'gallery';
    original_filename?: string;
    original_file_size_bytes?: number;
    original_mime_type?: string;
    original_width?: number;
    original_height?: number;
    client_gps_latitude?: number;
    client_gps_longitude?: number;
  }>;
  links?: Array<{
    entity_type: string;
    entity_id: string;
  }>;
}

export interface UpdateObservationData {
  state_text?: string;  // Backend field name (general concept)
  captured_at?: string;
  shared_with_partners?: boolean;
  photos?: Array<{
    photo_url: string;
    photo_description?: string;
    photo_order?: number;
    // Only meaningful for a photo_url not already attached to this
    // observation (i.e. a genuinely new photo added during an edit) — see
    // CreateObservationData for the full field docs. Ignored for existing
    // photos, which never carry these anyway.
    client_captured_at?: string;
    capture_method?: 'camera' | 'gallery';
    original_filename?: string;
    original_file_size_bytes?: number;
    original_mime_type?: string;
    original_width?: number;
    original_height?: number;
    client_gps_latitude?: number;
    client_gps_longitude?: number;
  }>;
  links?: Array<{
    entity_type: string;
    entity_id: string;
  }>;
}
