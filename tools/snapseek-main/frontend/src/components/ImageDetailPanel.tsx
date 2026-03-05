import { useState, useRef, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Tag, FileText, Users, Palette, Calendar, HardDrive, Eye, EyeOff, Pencil, Check, Loader2 } from 'lucide-react';
import { useImage } from '../hooks/useApi';
import { updatePersonName, getPerson } from '../services/api';
import type { ImageResult, FaceDetail } from '../types';

interface ImageDetailPanelProps {
  image: ImageResult;
  onClose: () => void;
  onSearchPerson?: (personId: string) => void;
}

export function ImageDetailPanel({ image, onClose, onSearchPerson }: ImageDetailPanelProps) {
  const queryClient = useQueryClient();
  
  // Only fetch extra details (dense_captions, face_details, indexed_at, etc.)
  // We already have most data from the search results
  const { data: detail, isLoading } = useImage(image.id);
  
  // State for bounding box toggle
  const [showBoundingBoxes, setShowBoundingBoxes] = useState(false);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  
  // State for editing person names
  const [editingPersonId, setEditingPersonId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  
  // State for fetched person names (from Face API)
  const [personNames, setPersonNames] = useState<Record<string, string>>({});
  const [loadingNames, setLoadingNames] = useState<Set<string>>(new Set());
  
  // Fetch person names when face_details are available
  useEffect(() => {
    if (!detail?.face_details) return;
    
    const personIds = detail.face_details
      .map(f => f.person_id)
      .filter((id): id is string => !!id && !personNames[id] && !loadingNames.has(id));
    
    if (personIds.length === 0) return;
    
    // Mark as loading
    setLoadingNames(prev => {
      const next = new Set(prev);
      personIds.forEach(id => next.add(id));
      return next;
    });
    
    // Fetch names
    Promise.all(
      personIds.map(async (personId) => {
        try {
          const person = await getPerson(personId);
          return { personId, name: person.name };
        } catch {
          return { personId, name: null };
        }
      })
    ).then(results => {
      setPersonNames(prev => {
        const next = { ...prev };
        results.forEach(({ personId, name }) => {
          if (name) next[personId] = name;
        });
        return next;
      });
      setLoadingNames(prev => {
        const next = new Set(prev);
        personIds.forEach(id => next.delete(id));
        return next;
      });
    });
  }, [detail?.face_details]);
  
  // Mutation for updating person name
  const updateNameMutation = useMutation({
    mutationFn: ({ personId, name }: { personId: string; name: string }) =>
      updatePersonName(personId, name),
    onSuccess: (_, { personId, name }) => {
      // Update local cache immediately
      setPersonNames(prev => ({ ...prev, [personId]: name }));
      // Invalidate queries to refresh other views
      queryClient.invalidateQueries({ queryKey: ['image', image.id] });
      queryClient.invalidateQueries({ queryKey: ['persons'] });
      setEditingPersonId(null);
    },
  });

  const startEditingName = (personId: string, currentName: string | null) => {
    setEditingPersonId(personId);
    setEditName(currentName || '');
  };

  const savePersonName = (personId: string) => {
    if (editName.trim()) {
      updateNameMutation.mutate({ personId, name: editName.trim() });
    }
  };

  const formatFileSize = (bytes: number | null): string => {
    if (!bytes) return 'Unknown';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return 'Unknown';
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const placeholderUrl = `https://placehold.co/800x600/1e293b/64748b?text=${encodeURIComponent(image.filename)}`;

  // Handle image load to get actual rendered dimensions
  const handleImageLoad = () => {
    if (imageRef.current) {
      setImageDimensions({
        width: imageRef.current.naturalWidth,
        height: imageRef.current.naturalHeight,
      });
    }
  };

  // Use detail data if available, fall back to image data from search results
  const tags = detail?.tags ?? image.tags;
  const objects = detail?.objects ?? image.objects;
  const colors = detail?.dominant_colors ?? image.dominant_colors;
  const caption = detail?.caption ?? image.caption;
  const extractedText = detail?.extracted_text ?? image.extracted_text;
  const hasFaces = detail?.has_faces ?? image.has_faces;
  const faceCount = detail?.face_count ?? image.face_count;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div
        className="relative w-full max-w-5xl max-h-[90vh] bg-slate-900 rounded-2xl overflow-hidden flex flex-col lg:flex-row animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-2 bg-black/50 hover:bg-black/70 rounded-full transition-colors"
        >
          <X className="w-5 h-5 text-white" />
        </button>

        {/* Image with bounding box overlay */}
        <div className="lg:w-3/5 bg-black flex flex-col">
          {/* Bounding box toggle */}
          {detail?.face_details && detail.face_details.some(f => f.bounding_box) && (
            <div className="flex justify-end p-2 bg-slate-900/90">
              <button
                onClick={() => setShowBoundingBoxes(!showBoundingBoxes)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                  showBoundingBoxes 
                    ? 'bg-blue-500 text-white' 
                    : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                }`}
              >
                {showBoundingBoxes ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                {showBoundingBoxes ? 'Hide Boxes' : 'Show Boxes'}
              </button>
            </div>
          )}
          
          {/* Image container with SVG overlay */}
          <div className="flex-1 flex items-center justify-center relative">
            <div className="relative inline-block">
              <img
                ref={imageRef}
                src={image.file_url || placeholderUrl}
                alt={caption || image.filename}
                className="max-w-full max-h-[50vh] lg:max-h-[80vh] object-contain"
                onLoad={handleImageLoad}
              />
              
              {/* Bounding box overlay */}
              {showBoundingBoxes && imageDimensions && detail?.face_details && (
                <svg
                  className="absolute inset-0 w-full h-full pointer-events-none"
                  viewBox={`0 0 ${imageDimensions.width} ${imageDimensions.height}`}
                  preserveAspectRatio="xMidYMid meet"
                >
                  {detail.face_details.map((face, i) => 
                    face.bounding_box && (
                      <g key={i}>
                        {/* Box rectangle */}
                        <rect
                          x={face.bounding_box.x}
                          y={face.bounding_box.y}
                          width={face.bounding_box.width}
                          height={face.bounding_box.height}
                          fill="none"
                          stroke="#3b82f6"
                          strokeWidth="3"
                        />
                        {/* Label background */}
                        <rect
                          x={face.bounding_box.x}
                          y={face.bounding_box.y - 24}
                          width={80}
                          height={22}
                          fill="#3b82f6"
                        />
                        {/* Label text */}
                        <text
                          x={face.bounding_box.x + 5}
                          y={face.bounding_box.y - 8}
                          fill="white"
                          fontSize="14"
                          fontFamily="sans-serif"
                        >
                          Face #{i + 1}
                        </text>
                      </g>
                    )
                  )}
                </svg>
              )}
            </div>
          </div>
        </div>

        {/* Details - show immediately with data from search results */}
        <div className="lg:w-2/5 p-6 overflow-y-auto">
          <h2 className="text-xl font-semibold text-white mb-2">{image.filename}</h2>
          
          {caption && (
            <p className="text-gray-300 mb-4">{caption}</p>
          )}

          <div className="space-y-4">
            {/* Dense Captions - only from detail API */}
            {detail?.dense_captions && detail.dense_captions.length > 0 && (
              <Section title="Details" icon={<FileText className="w-4 h-4" />}>
                <ul className="text-sm text-gray-400 space-y-1">
                  {detail.dense_captions.map((cap, i) => (
                    <li key={i}>• {cap}</li>
                  ))}
                </ul>
              </Section>
            )}

            {/* Tags - show immediately */}
            {tags.length > 0 && (
              <Section title="Tags" icon={<Tag className="w-4 h-4" />}>
                <div className="flex flex-wrap gap-1">
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      className="px-2 py-1 bg-blue-500/20 text-blue-300 text-xs rounded-full"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </Section>
            )}

            {/* Objects - show immediately */}
            {objects.length > 0 && (
              <Section title="Detected Objects" icon={<Tag className="w-4 h-4" />}>
                <div className="flex flex-wrap gap-1">
                  {objects.map((obj, i) => (
                    <span
                      key={i}
                      className="px-2 py-1 bg-purple-500/20 text-purple-300 text-xs rounded-full"
                    >
                      {obj}
                    </span>
                  ))}
                </div>
              </Section>
            )}

            {/* Extracted Text - show immediately */}
            {extractedText && (
              <Section title="Extracted Text" icon={<FileText className="w-4 h-4" />}>
                <p className="text-sm text-gray-400 bg-slate-800 p-3 rounded-lg whitespace-pre-wrap">
                  {extractedText}
                </p>
              </Section>
            )}

            {/* Faces - show immediately, face_details from API */}
            {hasFaces && (
              <Section title="Faces Detected" icon={<Users className="w-4 h-4" />}>
                <p className="text-sm text-gray-400 mb-3">
                  {faceCount} {faceCount === 1 ? 'face' : 'faces'} detected
                </p>
                
                {/* Face thumbnails grid */}
                {detail?.face_details && detail.face_details.some(f => f.bounding_box) && imageDimensions && (
                  <div className="flex flex-wrap gap-2 mb-4">
                    {detail.face_details.map((face, i) => 
                      face.bounding_box && (
                        <FaceThumbnail
                          key={i}
                          face={face}
                          faceIndex={i}
                          imageUrl={image.file_url || placeholderUrl}
                          imageDimensions={imageDimensions}
                          onClick={() => onSearchPerson?.(face.person_id || face.persisted_face_id || '')}
                        />
                      )
                    )}
                  </div>
                )}
                
                {detail?.face_details && detail.face_details.length > 0 && (
                  <div className="space-y-3">
                    {detail.face_details.map((face, i) => (
                      <div key={i} className="bg-slate-800 p-3 rounded-lg">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-medium text-blue-300">
                            Face #{i + 1}
                          </span>
                          {face.confidence && (
                            <span className="text-xs text-green-400">
                              {(face.confidence * 100).toFixed(0)}% match
                            </span>
                          )}
                        </div>
                        
                        {/* Persisted Face ID - always show if available */}
                        {face.persisted_face_id && (
                          <div className="mb-2">
                            <span className="text-xs text-gray-500">Face ID: </span>
                            <code 
                              className="text-xs text-cyan-400 bg-slate-900 px-2 py-0.5 rounded cursor-pointer hover:bg-slate-800 break-all"
                              onClick={() => onSearchPerson?.(face.persisted_face_id!)}
                              title="Click to search for this face"
                            >
                              {face.persisted_face_id}
                            </code>
                          </div>
                        )}
                        
                        {/* Person ID - always show */}
                        <div className="mb-2">
                          <span className="text-xs text-gray-500">Person ID: </span>
                          {face.person_id ? (
                            <code 
                              className="text-xs text-amber-400 bg-slate-900 px-2 py-0.5 rounded cursor-pointer hover:bg-slate-800 break-all"
                              onClick={() => onSearchPerson?.(face.person_id!)}
                              title="Click to search for this person"
                            >
                              {face.person_id}
                            </code>
                          ) : (
                            <span className="text-xs text-gray-500 italic">Not assigned</span>
                          )}
                        </div>
                        
                        {/* Person Name - editable */}
                        {face.person_id && (
                          <div className="mb-2">
                            <span className="text-xs text-gray-500">Name: </span>
                            {editingPersonId === face.person_id ? (
                              <div className="inline-flex items-center gap-1 mt-1">
                                <input
                                  type="text"
                                  value={editName}
                                  onChange={(e) => setEditName(e.target.value)}
                                  className="px-2 py-1 text-sm bg-slate-700 border border-slate-600 rounded text-white w-32"
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') savePersonName(face.person_id!);
                                    if (e.key === 'Escape') setEditingPersonId(null);
                                  }}
                                />
                                <button
                                  onClick={() => savePersonName(face.person_id!)}
                                  disabled={updateNameMutation.isPending}
                                  className="p-1 text-green-400 hover:bg-slate-600 rounded disabled:opacity-50"
                                >
                                  {updateNameMutation.isPending ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <Check className="w-4 h-4" />
                                  )}
                                </button>
                                <button
                                  onClick={() => setEditingPersonId(null)}
                                  className="p-1 text-gray-400 hover:bg-slate-600 rounded"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </div>
                            ) : (
                              <span className="inline-flex items-center gap-2">
                                {loadingNames.has(face.person_id!) ? (
                                  <Loader2 className="w-3 h-3 animate-spin text-gray-400" />
                                ) : (
                                  <span className="text-sm text-white">
                                    {personNames[face.person_id!] || 'Unknown'}
                                  </span>
                                )}
                                <button
                                  onClick={() => startEditingName(face.person_id!, personNames[face.person_id!] || null)}
                                  className="p-1 text-gray-400 hover:text-white hover:bg-slate-600 rounded"
                                  title="Edit name"
                                >
                                  <Pencil className="w-3 h-3" />
                                </button>
                              </span>
                            )}
                          </div>
                        )}
                        
                        {/* Face attributes */}
                        <div className="text-xs text-gray-400 space-y-1">
                          {face.age && <p>Estimated Age: ~{face.age}</p>}
                          {face.emotion && <p>Emotion: {face.emotion}</p>}
                          
                          {/* Bounding box info */}
                          {face.bounding_box && (
                            <p className="text-gray-500">
                              Position: ({face.bounding_box.x}, {face.bounding_box.y}) 
                              • Size: {face.bounding_box.width}×{face.bounding_box.height}px
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                
                {/* Show unique person IDs for easy copying/searching */}
                {detail?.person_ids && detail.person_ids.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-slate-700">
                    <p className="text-xs text-gray-500 mb-2">Unique Persons in Image:</p>
                    <div className="flex flex-wrap gap-2">
                      {detail.person_ids.map((pid) => (
                        <code 
                          key={pid} 
                          className="text-xs text-amber-400 bg-slate-900 px-2 py-1 rounded cursor-pointer hover:bg-slate-800"
                          title="Click to search for this person"
                        >
                          {pid.slice(0, 8)}...
                        </code>
                      ))}
                    </div>
                  </div>
                )}
              </Section>
            )}

            {/* Colors - show immediately */}
            {colors.length > 0 && (
              <Section title="Colors" icon={<Palette className="w-4 h-4" />}>
                <div className="flex flex-wrap gap-2">
                  {colors.map((color) => (
                    <div key={color} className="flex items-center gap-2">
                      <div
                        className="w-4 h-4 rounded-full border border-white/20"
                        style={{ backgroundColor: color.toLowerCase() }}
                      />
                      <span className="text-xs text-gray-400">{color}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Metadata - show immediately what we have */}
            <Section title="File Info" icon={<HardDrive className="w-4 h-4" />}>
              <div className="text-sm text-gray-400 space-y-1">
                {(detail?.width || image.width) && (detail?.height || image.height) && (
                  <p>Dimensions: {detail?.width ?? image.width} × {detail?.height ?? image.height}</p>
                )}
                <p>Size: {formatFileSize(detail?.file_size ?? image.file_size)}</p>
                {detail?.content_type && <p>Type: {detail.content_type}</p>}
              </div>
            </Section>

            {/* Indexed Date - only from detail API */}
            {detail?.indexed_at && (
              <Section title="Indexed" icon={<Calendar className="w-4 h-4" />}>
                <p className="text-sm text-gray-400">{formatDate(detail.indexed_at)}</p>
              </Section>
            )}

            {/* Loading indicator for extra details */}
            {isLoading && (
              <p className="text-xs text-gray-500 italic">Loading additional details...</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface SectionProps {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}

function Section({ title, icon, children }: SectionProps) {
  return (
    <div className="border-t border-slate-700 pt-4">
      <h3 className="flex items-center gap-2 text-sm font-medium text-gray-300 mb-2">
        {icon}
        {title}
      </h3>
      {children}
    </div>
  );
}

interface FaceThumbnailProps {
  face: FaceDetail;
  faceIndex: number;
  imageUrl: string;
  imageDimensions: { width: number; height: number };
  onClick?: () => void;
}

function FaceThumbnail({ face, faceIndex, imageUrl, imageDimensions, onClick }: FaceThumbnailProps) {
  if (!face.bounding_box) return null;
  
  const { x, y, width, height } = face.bounding_box;
  const thumbSize = 64;
  
  // Add padding around the face (20% on each side)
  const padding = Math.max(width, height) * 0.2;
  const cropX = Math.max(0, x - padding);
  const cropY = Math.max(0, y - padding);
  const cropWidth = Math.min(width + padding * 2, imageDimensions.width - cropX);
  const cropHeight = Math.min(height + padding * 2, imageDimensions.height - cropY);
  
  // Calculate scale to fit the crop into the thumbnail
  const scale = thumbSize / Math.max(cropWidth, cropHeight);
  
  // Calculate background position and size
  const bgWidth = imageDimensions.width * scale;
  const bgHeight = imageDimensions.height * scale;
  const bgX = -cropX * scale;
  const bgY = -cropY * scale;
  
  return (
    <div 
      className="relative group cursor-pointer"
      title={`Face #${faceIndex + 1}${face.person_id ? ` (${face.person_id.slice(0, 8)}...)` : ''} - Click to search`}
      onClick={onClick}
    >
      <div 
        className="w-16 h-16 rounded-lg overflow-hidden border-2 border-blue-500 bg-slate-700 hover:border-blue-400 transition-colors"
        style={{
          backgroundImage: `url(${imageUrl})`,
          backgroundPosition: `${bgX}px ${bgY}px`,
          backgroundSize: `${bgWidth}px ${bgHeight}px`,
          backgroundRepeat: 'no-repeat',
        }}
      />
      <span className="absolute -top-1 -right-1 bg-blue-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center">
        {faceIndex + 1}
      </span>
      {face.person_id && (
        <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 bg-amber-500 text-black text-[8px] px-1 rounded">
          ID
        </span>
      )}
    </div>
  );
}
