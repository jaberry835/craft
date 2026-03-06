import { useQuery, useMutation } from '@tanstack/react-query';
import {
  searchImages,
  getImage,
  listImages,
  getFacets,
  sendChatMessage,
} from '../services/api';
import type { SearchRequest, ChatRequest } from '../types';

// Cache times in milliseconds
const STALE_TIME = 30 * 1000; // 30 seconds - data considered fresh
const CACHE_TIME = 5 * 60 * 1000; // 5 minutes - keep in cache

/**
 * Hook for searching images
 */
export function useSearch(request: SearchRequest | null) {
  return useQuery({
    queryKey: ['search', request],
    queryFn: () => searchImages(request!),
    enabled: !!request && !!request.query,
    staleTime: STALE_TIME,
    gcTime: CACHE_TIME,
    placeholderData: (previousData) => previousData, // Keep previous data while loading
  });
}

/**
 * Hook for getting image details
 */
export function useImage(imageId: string | null) {
  return useQuery({
    queryKey: ['image', imageId],
    queryFn: () => getImage(imageId!),
    enabled: !!imageId,
    staleTime: STALE_TIME,
    gcTime: CACHE_TIME,
  });
}

/**
 * Hook for listing images
 */
export function useImages(top = 50, skip = 0) {
  return useQuery({
    queryKey: ['images', top, skip],
    queryFn: () => listImages(top, skip),
    staleTime: STALE_TIME,
    gcTime: CACHE_TIME,
    placeholderData: (previousData) => previousData, // Keep previous data while loading
  });
}

/**
 * Hook for getting facets
 */
export function useFacets() {
  return useQuery({
    queryKey: ['facets'],
    queryFn: getFacets,
    staleTime: 60 * 1000, // Facets change less often - 1 minute
    gcTime: CACHE_TIME,
  });
}

/**
 * Hook for chat mutation
 */
export function useChat() {
  return useMutation({
    mutationFn: (request: ChatRequest) => sendChatMessage(request),
  });
}
