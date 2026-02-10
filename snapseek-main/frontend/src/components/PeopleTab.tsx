import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Upload, Users, Image, Pencil, Check, X, Loader2 } from 'lucide-react';
import { listPersons, updatePersonName, findImagesByFace, getPersonImages } from '../services/api';
import type { Person, ImageResult } from '../types';

interface PeopleTabProps {
  onImageSelect?: (image: ImageResult) => void;
  initialSearchQuery?: string;
}

export function PeopleTab({ onImageSelect, initialSearchQuery }: PeopleTabProps) {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery || '');

  // Sync with external search query
  useEffect(() => {
    if (initialSearchQuery) {
      setSearchQuery(initialSearchQuery);
    }
  }, [initialSearchQuery]);
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [editingPersonId, setEditingPersonId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch persons list
  const { data: personsData, isLoading: loadingPersons } = useQuery({
    queryKey: ['persons', searchQuery],
    queryFn: () => listPersons(searchQuery || undefined),
    staleTime: 30000,
  });

  // Fetch selected person's images
  const { data: personImages, isLoading: loadingImages } = useQuery({
    queryKey: ['personImages', selectedPerson?.person_id],
    queryFn: () => selectedPerson ? getPersonImages(selectedPerson.person_id) : null,
    enabled: !!selectedPerson,
    staleTime: 30000,
  });

  // Find by face mutation
  const findByFaceMutation = useMutation({
    mutationFn: (file: File) => findImagesByFace(file, 0.5),
  });

  // Update person name mutation
  const updateNameMutation = useMutation({
    mutationFn: ({ personId, name }: { personId: string; name: string }) =>
      updatePersonName(personId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['persons'] });
      setEditingPersonId(null);
    },
  });

  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      // Show preview
      const reader = new FileReader();
      reader.onload = (e) => setUploadedImage(e.target?.result as string);
      reader.readAsDataURL(file);
      
      // Search for matching faces
      findByFaceMutation.mutate(file);
    }
  }, [findByFaceMutation]);

  const handleDropZoneClick = () => {
    fileInputRef.current?.click();
  };

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => setUploadedImage(e.target?.result as string);
      reader.readAsDataURL(file);
      findByFaceMutation.mutate(file);
    }
  }, [findByFaceMutation]);

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
  };

  const startEditingName = (person: Person) => {
    setEditingPersonId(person.person_id);
    setEditName(person.name || '');
  };

  const savePersonName = (personId: string) => {
    if (editName.trim()) {
      updateNameMutation.mutate({ personId, name: editName.trim() });
    }
  };

  const clearUpload = () => {
    setUploadedImage(null);
    findByFaceMutation.reset();
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-900">
      {/* Header */}
      <div className="p-4 border-b border-slate-700">
        <h2 className="text-xl font-semibold text-white flex items-center gap-2 mb-4">
          <Users className="w-5 h-5" />
          People Search
        </h2>
        
        {/* Search input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search by name or ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Face Upload Section */}
        <div className="bg-slate-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
            <Upload className="w-4 h-4" />
            Find by Face
          </h3>
          
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileUpload}
            className="hidden"
          />
          
          {!uploadedImage ? (
            <div
              onClick={handleDropZoneClick}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              className="border-2 border-dashed border-slate-600 rounded-lg p-6 text-center cursor-pointer hover:border-blue-500 hover:bg-slate-700/50 transition-colors"
            >
              <Image className="w-8 h-8 mx-auto mb-2 text-gray-400" />
              <p className="text-sm text-gray-400">
                Drop an image or click to upload
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Upload a photo to find all images of that person
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="relative inline-block">
                <img
                  src={uploadedImage}
                  alt="Uploaded"
                  className="max-h-32 rounded-lg"
                />
                <button
                  onClick={clearUpload}
                  className="absolute -top-2 -right-2 p-1 bg-red-500 rounded-full hover:bg-red-600"
                >
                  <X className="w-3 h-3 text-white" />
                </button>
              </div>
              
              {findByFaceMutation.isPending && (
                <div className="flex items-center gap-2 text-gray-400">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Searching for matches...</span>
                </div>
              )}
              
              {findByFaceMutation.isError && (
                <p className="text-sm text-red-400">
                  {(findByFaceMutation.error as Error).message || 'Failed to search'}
                </p>
              )}
              
              {findByFaceMutation.isSuccess && (
                <div>
                  <p className="text-sm text-green-400 mb-3">
                    Found {findByFaceMutation.data.total_count} matching images
                  </p>
                  {findByFaceMutation.data.results.length > 0 && (
                    <div className="grid grid-cols-4 gap-2">
                      {findByFaceMutation.data.results.slice(0, 8).map((img) => (
                        <div
                          key={img.id}
                          onClick={() => onImageSelect?.(img as ImageResult)}
                          className="aspect-square rounded-lg overflow-hidden cursor-pointer hover:ring-2 hover:ring-blue-500"
                        >
                          <img
                            src={img.file_url || ''}
                            alt={img.filename}
                            className="w-full h-full object-cover"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Known Persons Grid */}
        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-3">
            Known Persons ({personsData?.total_count || 0})
          </h3>
          
          {loadingPersons ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          ) : personsData?.persons.length === 0 ? (
            <p className="text-gray-500 text-center py-8">
              No persons found. Index some images with faces first.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {personsData?.persons.map((person) => (
                <div
                  key={person.person_id}
                  className={`bg-slate-800 rounded-lg p-3 cursor-pointer transition-colors ${
                    selectedPerson?.person_id === person.person_id
                      ? 'ring-2 ring-blue-500'
                      : 'hover:bg-slate-700'
                  }`}
                  onClick={() => setSelectedPerson(person)}
                >
                  <div className="flex items-start justify-between mb-2">
                    {editingPersonId === person.person_id ? (
                      <div className="flex items-center gap-1 flex-1">
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          className="flex-1 px-2 py-1 text-sm bg-slate-700 border border-slate-600 rounded text-white"
                          autoFocus
                        />
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            savePersonName(person.person_id);
                          }}
                          disabled={updateNameMutation.isPending}
                          className="p-1 text-green-400 hover:bg-slate-600 rounded"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingPersonId(null);
                          }}
                          className="p-1 text-gray-400 hover:bg-slate-600 rounded"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="text-sm font-medium text-white truncate">
                          {person.name || 'Unknown'}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            startEditingName(person);
                          }}
                          className="p-1 text-gray-400 hover:text-white hover:bg-slate-600 rounded"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                      </>
                    )}
                  </div>
                  <code className="text-xs text-amber-400 block truncate mb-2">
                    {person.person_id.slice(0, 12)}...
                  </code>
                  <div className="text-xs text-gray-400">
                    {selectedPerson?.person_id === person.person_id && personImages?.total_count !== undefined
                      ? `${personImages.total_count} images`
                      : `${person.image_count} images`
                    } • {person.face_count} faces
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Selected Person Images */}
        {selectedPerson && (
          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-3">
              Images of {selectedPerson.name || 'Unknown'} ({personImages?.total_count || 0})
            </h3>
            
            {loadingImages ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
              </div>
            ) : personImages?.results.length === 0 ? (
              <p className="text-gray-500 text-center py-4">No images found</p>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {personImages?.results.map((img) => (
                  <div
                    key={img.id}
                    onClick={() => onImageSelect?.(img)}
                    className="aspect-square rounded-lg overflow-hidden cursor-pointer hover:ring-2 hover:ring-blue-500"
                  >
                    <img
                      src={img.file_url || ''}
                      alt={img.filename}
                      className="w-full h-full object-cover"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
