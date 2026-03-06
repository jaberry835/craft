import { useState } from 'react';
import { Image as ImageIcon, Users, FileText, Tag } from 'lucide-react';
import type { ImageResult } from '../types';

interface ImageCardProps {
  image: ImageResult;
  onClick: (image: ImageResult) => void;
}

export function ImageCard({ image, onClick }: ImageCardProps) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const placeholderUrl = `https://placehold.co/400x300/1e293b/64748b?text=${encodeURIComponent(image.filename)}`;
  const imageUrl = image.file_url || placeholderUrl;

  return (
    <div
      onClick={() => onClick(image)}
      className="group relative bg-slate-800 rounded-xl overflow-hidden cursor-pointer transition-all hover:ring-2 hover:ring-primary-500 hover:scale-[1.02]"
    >
      {/* Image */}
      <div className="aspect-[4/3] relative overflow-hidden">
        {!loaded && !error && (
          <div className="absolute inset-0 image-skeleton" />
        )}
        <img
          src={error ? placeholderUrl : imageUrl}
          alt={image.caption || image.filename}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          className={`w-full h-full object-cover transition-opacity duration-300 ${
            loaded ? 'opacity-100' : 'opacity-0'
          }`}
        />
        
        {/* Overlay on hover */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>

      {/* Info */}
      <div className="p-3">
        <h3 className="text-sm font-medium text-white truncate mb-1">
          {image.filename}
        </h3>
        
        {image.caption && (
          <p className="text-xs text-gray-400 line-clamp-2 mb-2">
            {image.caption}
          </p>
        )}

        {/* Badges */}
        <div className="flex flex-wrap gap-1">
          {image.has_faces && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-purple-500/20 text-purple-300 text-xs rounded">
              <Users className="w-3 h-3" />
              {image.face_count}
            </span>
          )}
          {image.has_text && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-green-500/20 text-green-300 text-xs rounded">
              <FileText className="w-3 h-3" />
              Text
            </span>
          )}
          {image.tags.length > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-500/20 text-blue-300 text-xs rounded">
              <Tag className="w-3 h-3" />
              {image.tags.length}
            </span>
          )}
        </div>
      </div>

      {/* Score badge */}
      {image.score !== null && (
        <div className="absolute top-2 right-2 px-2 py-1 bg-black/60 rounded text-xs text-white">
          {(image.score * 100).toFixed(0)}%
        </div>
      )}
    </div>
  );
}

interface ImageGridProps {
  images: ImageResult[];
  onImageClick: (image: ImageResult) => void;
  isLoading?: boolean;
}

export function ImageGrid({ images, onImageClick, isLoading }: ImageGridProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="aspect-[4/3] bg-slate-800 rounded-xl image-skeleton" />
        ))}
      </div>
    );
  }

  if (images.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-400">
        <ImageIcon className="w-16 h-16 mb-4 opacity-50" />
        <p className="text-lg">No images found</p>
        <p className="text-sm">Try a different search query or adjust filters</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {images.map((image) => (
        <ImageCard key={image.id} image={image} onClick={onImageClick} />
      ))}
    </div>
  );
}
