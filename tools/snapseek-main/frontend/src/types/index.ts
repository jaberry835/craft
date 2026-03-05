/**
 * Type definitions for the Azure Snap Seek API
 */

export interface ImageResult {
  id: string;
  filename: string;
  file_url: string | null;
  caption: string | null;
  tags: string[];
  objects: string[];
  extracted_text: string | null;
  has_text: boolean;
  face_count: number;
  has_faces: boolean;
  dominant_colors: string[];
  score: number | null;
  width: number | null;
  height: number | null;
  file_size: number | null;
}

export interface SearchRequest {
  query: string;
  top?: number;
  skip?: number;
  tags?: string[];
  objects?: string[];
  has_text?: boolean;
  has_faces?: boolean;
  min_faces?: number;
  colors?: string[];
  person_ids?: string[];
  use_vector_search?: boolean;
  use_semantic_search?: boolean;
  min_score?: number;
}

export interface SearchResponse {
  results: ImageResult[];
  total_count: number;
  filtered_count?: number;
  query: string;
  took_ms: number | null;
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface FacetsResponse {
  tags: FacetValue[];
  objects: FacetValue[];
  colors: FacetValue[];
  has_text: FacetValue[];
  has_faces: FacetValue[];
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FaceDetail {
  face_id: string | null;
  persisted_face_id: string | null;
  person_id: string | null;
  person_name: string | null;
  confidence: number | null;
  age: number | null;
  emotion: string | null;
  bounding_box: BoundingBox | null;
}

export interface ImageDetail {
  id: string;
  filename: string;
  file_path: string;
  file_url: string | null;
  file_size: number | null;
  content_type: string | null;
  caption: string | null;
  caption_confidence: number | null;
  dense_captions: string[];
  tags: string[];
  objects: string[];
  brands: string[];
  categories: string[];
  extracted_text: string | null;
  has_text: boolean;
  face_count: number;
  has_faces: boolean;
  face_details: FaceDetail[];
  person_ids: string[];
  dominant_colors: string[];
  accent_color: string | null;
  is_black_white: boolean;
  rich_description: string | null;
  width: number | null;
  height: number | null;
  indexed_at: string | null;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatRequest {
  message: string;
  history?: ChatMessage[];
  include_images?: boolean;
}

export interface ChatImageReference {
  id: string;
  filename: string;
  file_url: string | null;
  caption: string | null;
  relevance_reason: string | null;
}

export interface ChatResponse {
  message: string;
  images: ChatImageReference[];
  search_query: string | null;
}

export interface ImageListResponse {
  images: ImageResult[];
  total_count: number;
  skip: number;
  top: number;
}

// Person types
export interface Person {
  person_id: string;
  name: string | null;
  user_data: string | null;
  face_count: number;
  image_count: number;
}

export interface PersonListResponse {
  persons: Person[];
  total_count: number;
}

export interface FindByFaceResponse {
  matched_persisted_face_ids: string[];
  matched_document_ids: string[];
  confidence_scores: Record<string, number>;
  total_matches: number;
}

export interface FindByFaceImagesResponse {
  results: ImageResult[];
  total_count: number;
  matched_faces: number;
  message?: string;
}
