import axios from 'axios';
import type {
  SearchRequest,
  SearchResponse,
  FacetsResponse,
  ImageDetail,
  ImageResult,
  ImageListResponse,
  ChatRequest,
  ChatResponse,
  Person,
  PersonListResponse,
  FindByFaceImagesResponse,
} from '../types';

const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

/**
 * Search for images
 */
export async function searchImages(request: SearchRequest): Promise<SearchResponse> {
  const response = await api.post<SearchResponse>('/search', request);
  return response.data;
}

/**
 * Get image details by ID
 */
export async function getImage(imageId: string): Promise<ImageDetail> {
  const response = await api.get<ImageDetail>(`/images/${imageId}`);
  return response.data;
}

/**
 * List all images with pagination
 */
export async function listImages(
  top = 50,
  skip = 0,
  orderBy = 'indexed_at',
  orderDesc = true
): Promise<ImageListResponse> {
  const response = await api.get<ImageListResponse>('/images', {
    params: { top, skip, order_by: orderBy, order_desc: orderDesc },
  });
  return response.data;
}

/**
 * Get available facets for filtering
 */
export async function getFacets(): Promise<FacetsResponse> {
  const response = await api.get<FacetsResponse>('/facets');
  return response.data;
}

/**
 * Send a chat message
 */
export async function sendChatMessage(request: ChatRequest): Promise<ChatResponse> {
  const response = await api.post<ChatResponse>('/chat', request);
  return response.data;
}

/**
 * Health check
 */
export async function healthCheck(): Promise<{ status: string; version: string }> {
  const response = await api.get('/health');
  return response.data;
}

// ============ Person API Functions ============

/**
 * List all persons
 */
export async function listPersons(search?: string): Promise<PersonListResponse> {
  const response = await api.get<PersonListResponse>('/persons', {
    params: search ? { search } : undefined,
  });
  return response.data;
}

/**
 * Get a specific person
 */
export async function getPerson(personId: string): Promise<Person> {
  const response = await api.get<Person>(`/persons/${personId}`);
  return response.data;
}

/**
 * Update person name
 */
export async function updatePersonName(
  personId: string,
  name: string
): Promise<{ status: string; person_id: string; name: string }> {
  const response = await api.patch(`/persons/${personId}`, { name });
  return response.data;
}

/**
 * Get images containing a person
 */
export async function getPersonImages(
  personId: string,
  top = 50,
  skip = 0
): Promise<{ results: ImageResult[]; total_count: number; person_id: string }> {
  const response = await api.get(`/persons/${personId}/images`, {
    params: { top, skip },
  });
  return response.data;
}

/**
 * Find images by uploading a face image
 */
export async function findImagesByFace(
  imageFile: File,
  threshold = 0.5
): Promise<FindByFaceImagesResponse> {
  const formData = new FormData();
  formData.append('image', imageFile);
  
  const response = await api.post<FindByFaceImagesResponse>(
    '/persons/find-by-face/images',
    formData,
    {
      params: { threshold },
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    }
  );
  return response.data;
}

export default api;
