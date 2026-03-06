import { useState, useCallback, useRef, useEffect } from 'react';
import { Search, MessageSquare, Image as ImageIcon, Menu, X, ChevronLeft, ChevronRight, SlidersHorizontal, Users } from 'lucide-react';
import { SearchBar, ImageGrid, ImageDetailPanel, ChatInterface, PeopleTab } from './components';
import type { SearchFilters } from './components';
import { useSearch, useFacets, useImages } from './hooks/useApi';
import type { ImageResult, SearchRequest } from './types';

type Tab = 'search' | 'browse' | 'chat' | 'people';

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('search');
  const [searchRequest, setSearchRequest] = useState<SearchRequest | null>(null);
  const [selectedImage, setSelectedImage] = useState<ImageResult | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  
  // Pagination state
  const [searchPageSize, setSearchPageSize] = useState(10);
  const [searchPage, setSearchPage] = useState(0);
  const [browsePageSize, setBrowsePageSize] = useState(10);
  const [browsePage, setBrowsePage] = useState(0);

  // People search state (for navigating from face click)
  const [peopleSearchQuery, setPeopleSearchQuery] = useState('');
  
  // Score threshold filter (0-100, default 75)
  const [scoreThreshold, setScoreThreshold] = useState(75);
  const [pendingThreshold, setPendingThreshold] = useState(75);
  const thresholdTimeoutRef = useRef<number | null>(null);
  
  // Search mode toggles
  const [useVectorSearch, setUseVectorSearch] = useState(true);
  const [useSemanticSearch, setUseSemanticSearch] = useState(true);

  // Queries
  const { data: searchResults, isLoading: isSearching } = useSearch(searchRequest);
  const { data: facets } = useFacets();
  const { data: browseResults, isLoading: isBrowsing } = useImages(browsePageSize, browsePage * browsePageSize);

  const handleSearch = useCallback((query: string, filters: SearchFilters) => {
    setSearchPage(0); // Reset to first page on new search
    setSearchRequest({
      query,
      top: searchPageSize,
      skip: 0,
      ...filters,
      use_vector_search: useVectorSearch,
      use_semantic_search: useSemanticSearch,
      min_score: scoreThreshold / 100, // Convert percentage to 0-1
    });
  }, [searchPageSize, scoreThreshold, useVectorSearch, useSemanticSearch]);

  // Update search request when page or page size changes
  const updateSearchPagination = useCallback((page: number, pageSize: number) => {
    if (searchRequest) {
      setSearchRequest({
        ...searchRequest,
        top: pageSize,
        skip: page * pageSize,
      });
    }
  }, [searchRequest]);

  // Debounced score threshold change - waits 300ms after user stops sliding
  const handleScoreThresholdChange = useCallback((newThreshold: number) => {
    setPendingThreshold(newThreshold);
    
    // Clear existing timeout
    if (thresholdTimeoutRef.current) {
      clearTimeout(thresholdTimeoutRef.current);
    }
    
    // Set new timeout to apply the threshold after 300ms
    thresholdTimeoutRef.current = window.setTimeout(() => {
      setScoreThreshold(newThreshold);
      if (searchRequest) {
        setSearchPage(0);
        setSearchRequest((prev) => prev ? {
          ...prev,
          skip: 0,
          min_score: newThreshold / 100,
        } : null);
      }
    }, 300);
  }, [searchRequest]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (thresholdTimeoutRef.current) {
        clearTimeout(thresholdTimeoutRef.current);
      }
    };
  }, []);

  const handleSearchPageChange = useCallback((newPage: number) => {
    setSearchPage(newPage);
    updateSearchPagination(newPage, searchPageSize);
  }, [searchPageSize, updateSearchPagination]);

  const handleSearchPageSizeChange = useCallback((newSize: number) => {
    setSearchPageSize(newSize);
    setSearchPage(0);
    updateSearchPagination(0, newSize);
  }, [updateSearchPagination]);

  const handleBrowsePageSizeChange = useCallback((newSize: number) => {
    setBrowsePageSize(newSize);
    setBrowsePage(0);
  }, []);

  const handleImageClick = useCallback((image: ImageResult) => {
    setSelectedImage(image);
  }, []);

  const handleChatImageClick = useCallback((imageId: string) => {
    // Find image from search or browse results
    const image =
      searchResults?.results.find((r) => r.id === imageId) ||
      browseResults?.images.find((r) => r.id === imageId);
    
    if (image) {
      setSelectedImage(image);
    }
  }, [searchResults, browseResults]);

  const tabs = [
    { id: 'search' as Tab, label: 'Search', icon: Search },
    { id: 'browse' as Tab, label: 'Browse', icon: ImageIcon },
    { id: 'people' as Tab, label: 'People', icon: Users },
    { id: 'chat' as Tab, label: 'Chat', icon: MessageSquare },
  ];

  return (
    <div className="min-h-screen bg-slate-950">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-slate-900/95 backdrop-blur border-b border-slate-800">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-gradient-to-br from-primary-500 to-purple-600 rounded-lg flex items-center justify-center">
                <Search className="w-4 h-4 text-white" />
              </div>
              <h1 className="text-xl font-bold text-white">Azure Snap Seek</h1>
            </div>

            {/* Desktop Navigation */}
            <nav className="hidden md:flex items-center gap-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                    activeTab === tab.id
                      ? 'bg-primary-600 text-white'
                      : 'text-gray-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  <tab.icon className="w-4 h-4" />
                  {tab.label}
                </button>
              ))}
            </nav>

            {/* Mobile Menu Button */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-2 text-gray-400 hover:text-white"
            >
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>

          {/* Mobile Navigation */}
          {mobileMenuOpen && (
            <nav className="md:hidden py-4 border-t border-slate-800">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => {
                    setActiveTab(tab.id);
                    setMobileMenuOpen(false);
                  }}
                  className={`flex items-center gap-2 w-full px-4 py-3 rounded-lg transition-colors ${
                    activeTab === tab.id
                      ? 'bg-primary-600 text-white'
                      : 'text-gray-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  <tab.icon className="w-4 h-4" />
                  {tab.label}
                </button>
              ))}
            </nav>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6">
        {activeTab === 'search' && (
          <div className="space-y-6">
            <SearchBar
              onSearch={handleSearch}
              facets={facets}
              isLoading={isSearching}
            />

            {/* Score threshold slider and results info */}
            {searchResults && (
              <div className="space-y-3">
                {/* Score Threshold Slider */}
                <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 bg-slate-800 rounded-lg">
                  <div className="flex items-center gap-2">
                    <SlidersHorizontal className="w-4 h-4 text-gray-400" />
                    <label className="text-sm text-gray-300 whitespace-nowrap">
                      Min Score:
                    </label>
                  </div>
                  <div className="flex items-center gap-3 flex-1">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={pendingThreshold}
                      onChange={(e) => handleScoreThresholdChange(Number(e.target.value))}
                      className="flex-1 h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-primary-500"
                    />
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={pendingThreshold}
                        onChange={(e) => {
                          const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                          handleScoreThresholdChange(val);
                        }}
                        className="w-14 px-2 py-1 text-sm font-medium text-white bg-slate-700 border border-slate-600 rounded text-center focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                      <span className="text-sm text-gray-400">%</span>
                      {pendingThreshold !== scoreThreshold && (
                        <span className="text-xs text-gray-500">...</span>
                      )}
                    </div>
                  </div>
                  
                  {/* Search mode toggles */}
                  <div className="flex items-center gap-4 ml-4 pl-4 border-l border-slate-700">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={useVectorSearch}
                        onChange={(e) => setUseVectorSearch(e.target.checked)}
                        className="w-4 h-4 rounded bg-slate-700 border-slate-600 text-primary-500 focus:ring-primary-500"
                      />
                      <span className="text-sm text-gray-300">Vector</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={useSemanticSearch}
                        onChange={(e) => setUseSemanticSearch(e.target.checked)}
                        className="w-4 h-4 rounded bg-slate-700 border-slate-600 text-primary-500 focus:ring-primary-500"
                      />
                      <span className="text-sm text-gray-300">Semantic</span>
                    </label>
                  </div>
                </div>

                {/* Results count */}
                <div className="flex items-center justify-between text-sm text-gray-400">
                  <p>
                    Found {searchResults.total_count} results for "{searchResults.query}" (≥{scoreThreshold}% match)
                    {!useVectorSearch && <span className="text-yellow-500 ml-2">(keyword only)</span>}
                  </p>
                  {searchResults.took_ms && (
                    <p>({searchResults.took_ms.toFixed(0)}ms)</p>
                  )}
                </div>
              </div>
            )}

            <ImageGrid
              images={searchResults?.results || []}
              onImageClick={handleImageClick}
              isLoading={isSearching}
            />

            {/* Search Pagination */}
            {searchResults && searchResults.total_count > 0 && (
              <Pagination
                currentPage={searchPage}
                pageSize={searchPageSize}
                totalCount={searchResults.total_count}
                onPageChange={handleSearchPageChange}
                onPageSizeChange={handleSearchPageSizeChange}
              />
            )}
          </div>
        )}

        {activeTab === 'browse' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-white">All Images</h2>
              {browseResults && (
                <p className="text-sm text-gray-400">
                  {browseResults.total_count} images indexed
                </p>
              )}
            </div>

            <ImageGrid
              images={browseResults?.images || []}
              onImageClick={handleImageClick}
              isLoading={isBrowsing}
            />

            {/* Browse Pagination */}
            {browseResults && browseResults.total_count > 0 && (
              <Pagination
                currentPage={browsePage}
                pageSize={browsePageSize}
                totalCount={browseResults.total_count}
                onPageChange={setBrowsePage}
                onPageSizeChange={handleBrowsePageSizeChange}
              />
            )}
          </div>
        )}

        {activeTab === 'chat' && (
          <div className="h-[calc(100vh-10rem)]">
            <ChatInterface onImageClick={handleChatImageClick} />
          </div>
        )}

        {activeTab === 'people' && (
          <div className="h-[calc(100vh-10rem)]">
            <PeopleTab onImageSelect={handleImageClick} initialSearchQuery={peopleSearchQuery} />
          </div>
        )}
      </main>

      {/* Image Detail Modal */}
      {selectedImage && (
        <ImageDetailPanel
          image={selectedImage}
          onClose={() => setSelectedImage(null)}
          onSearchPerson={(personId) => {
            setSelectedImage(null);
            setPeopleSearchQuery(personId);
            setActiveTab('people');
          }}
        />
      )}
    </div>
  );
}

// Pagination Component
interface PaginationProps {
  currentPage: number;
  pageSize: number;
  totalCount: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

function Pagination({ currentPage, pageSize, totalCount, onPageChange, onPageSizeChange }: PaginationProps) {
  const totalPages = Math.ceil(totalCount / pageSize);
  const startItem = currentPage * pageSize + 1;
  const endItem = Math.min((currentPage + 1) * pageSize, totalCount);

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-4 border-t border-slate-800">
      {/* Page size selector */}
      <div className="flex items-center gap-2">
        <label className="text-sm text-gray-400">Show:</label>
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className="bg-slate-800 text-white text-sm rounded-lg px-3 py-1.5 border border-slate-700 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        >
          {PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        <span className="text-sm text-gray-400">per page</span>
      </div>

      {/* Page info and navigation */}
      <div className="flex items-center gap-4">
        <span className="text-sm text-gray-400">
          {startItem}-{endItem} of {totalCount}
        </span>
        
        <div className="flex items-center gap-1">
          <button
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage === 0}
            className="p-2 rounded-lg bg-slate-800 text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-700 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          
          <span className="px-3 py-1 text-sm text-white">
            Page {currentPage + 1} of {totalPages}
          </span>
          
          <button
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages - 1}
            className="p-2 rounded-lg bg-slate-800 text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-700 transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
