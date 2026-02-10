import { useState, useCallback } from 'react';
import { Search, X, Filter, SlidersHorizontal } from 'lucide-react';
import type { FacetsResponse } from '../types';

interface SearchBarProps {
  onSearch: (query: string, filters: SearchFilters) => void;
  facets?: FacetsResponse;
  isLoading?: boolean;
}

export interface SearchFilters {
  tags?: string[];
  objects?: string[];
  has_text?: boolean;
  has_faces?: boolean;
  colors?: string[];
}

export function SearchBar({ onSearch, facets, isLoading }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<SearchFilters>({});

  const handleSearch = useCallback(() => {
    if (query.trim()) {
      onSearch(query.trim(), filters);
    }
  }, [query, filters, onSearch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const clearSearch = () => {
    setQuery('');
    setFilters({});
  };

  const toggleFilter = (type: keyof SearchFilters, value: string | boolean) => {
    setFilters((prev) => {
      if (type === 'has_text' || type === 'has_faces') {
        return { ...prev, [type]: value === prev[type] ? undefined : value };
      }
      
      const current = (prev[type] as string[]) || [];
      const updated = current.includes(value as string)
        ? current.filter((v) => v !== value)
        : [...current, value as string];
      
      return { ...prev, [type]: updated.length > 0 ? updated : undefined };
    });
  };

  return (
    <div className="w-full max-w-4xl mx-auto">
      {/* Search Input */}
      <div className="relative flex items-center">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search images by description, objects, text..."
            className="w-full pl-12 pr-12 py-4 bg-slate-800 border border-slate-700 rounded-xl text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
          />
          {query && (
            <button
              onClick={clearSearch}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-1 hover:bg-slate-700 rounded-full transition-colors"
            >
              <X className="w-4 h-4 text-gray-400" />
            </button>
          )}
        </div>
        
        <button
          onClick={handleSearch}
          disabled={!query.trim() || isLoading}
          className="ml-3 px-6 py-4 bg-primary-600 hover:bg-primary-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-xl text-white font-medium transition-colors"
        >
          {isLoading ? 'Searching...' : 'Search'}
        </button>
        
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`ml-2 p-4 rounded-xl border transition-colors ${
            showFilters || Object.keys(filters).length > 0
              ? 'bg-primary-600 border-primary-500 text-white'
              : 'bg-slate-800 border-slate-700 text-gray-400 hover:text-white'
          }`}
        >
          <SlidersHorizontal className="w-5 h-5" />
        </button>
      </div>

      {/* Filters Panel */}
      {showFilters && facets && (
        <div className="mt-4 p-4 bg-slate-800 border border-slate-700 rounded-xl animate-slide-up">
          <div className="flex items-center gap-2 mb-4">
            <Filter className="w-4 h-4 text-gray-400" />
            <span className="text-sm font-medium text-gray-300">Filters</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Tags */}
            {facets.tags.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-gray-400 uppercase mb-2">Tags</h4>
                <div className="flex flex-wrap gap-1">
                  {facets.tags.slice(0, 10).map((tag) => (
                    <button
                      key={tag.value}
                      onClick={() => toggleFilter('tags', tag.value)}
                      className={`px-2 py-1 text-xs rounded-full transition-colors ${
                        filters.tags?.includes(tag.value)
                          ? 'bg-primary-600 text-white'
                          : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                      }`}
                    >
                      {tag.value} ({tag.count})
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Objects */}
            {facets.objects.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-gray-400 uppercase mb-2">Objects</h4>
                <div className="flex flex-wrap gap-1">
                  {facets.objects.slice(0, 10).map((obj) => (
                    <button
                      key={obj.value}
                      onClick={() => toggleFilter('objects', obj.value)}
                      className={`px-2 py-1 text-xs rounded-full transition-colors ${
                        filters.objects?.includes(obj.value)
                          ? 'bg-primary-600 text-white'
                          : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                      }`}
                    >
                      {obj.value} ({obj.count})
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Boolean Filters */}
            <div>
              <h4 className="text-xs font-medium text-gray-400 uppercase mb-2">Features</h4>
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => toggleFilter('has_text', true)}
                  className={`px-2 py-1 text-xs rounded-full transition-colors ${
                    filters.has_text === true
                      ? 'bg-primary-600 text-white'
                      : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                  }`}
                >
                  Has Text
                </button>
                <button
                  onClick={() => toggleFilter('has_faces', true)}
                  className={`px-2 py-1 text-xs rounded-full transition-colors ${
                    filters.has_faces === true
                      ? 'bg-primary-600 text-white'
                      : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                  }`}
                >
                  Has Faces
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
