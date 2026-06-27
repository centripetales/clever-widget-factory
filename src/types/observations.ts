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
  }>;
  links?: Array<{
    entity_type: string;
    entity_id: string;
  }>;
}
