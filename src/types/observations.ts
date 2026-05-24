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
  perspectives?: {
    perspective_type: string;
    content: string;
    status?: string; // 'PENDING' used as optimistic sentinel
  }[];
}

export interface ObservationPhoto {
  id: string;
  observation_id: string;
  photo_url: string;
  photo_description: string | null;
  photo_order: number;
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
