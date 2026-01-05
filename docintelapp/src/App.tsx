import { useState, useCallback, useEffect } from 'react'
import {
  Box,
  Paper,
  Typography,
  Button,
  Tab,
  Tabs,
  AppBar,
  Toolbar,
  CircularProgress,
  Alert
} from '@mui/material'
import { CloudUpload, Psychology, Translate, SmartToy, Hub } from '@mui/icons-material'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import FileDropArea from './components/FileDropArea'
import ImagePreview from './components/ImagePreview'
import OCRTab from './components/OCRTab'
import TranslationTab from './components/TranslationTab'
import AOAITab from './components/AOAITab'
import VectorizationTab from './components/VectorizationTab'
import { DocumentIntelligenceService } from './services/documentIntelligence'
import { TranslatorService } from './services/translator'
import { validateConfig } from './services/config'
import './App.css'

const theme = createTheme({
  palette: {
    primary: {
      main: '#1976d2',
    },
    secondary: {
      main: '#dc004e',
    },
  },
})

function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [imageUrl, setImageUrl] = useState<string>('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [hasProcessed, setHasProcessed] = useState(false)
  const [activeTab, setActiveTab] = useState(0)
  const [ocrData, setOcrData] = useState<any>(null)
  const [translationData, setTranslationData] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  const handleFileSelect = useCallback((file: File) => {
    setSelectedFile(file)
    setHasProcessed(false)
    setOcrData(null)
    setTranslationData(null)
    setError(null)
    
    // Create preview URL
    const url = URL.createObjectURL(file)
    setImageUrl(url)
  }, [])

  const handleProcess = async () => {
    if (!selectedFile) return

    setIsProcessing(true)
    setOcrData(null)
    setTranslationData(null)
    setError(null)

    try {
      // Initialize services
      const documentService = new DocumentIntelligenceService()
      const translatorService = new TranslatorService()

      // Step 1: OCR Analysis
      const ocrResult = await documentService.analyzeDocument(selectedFile)
      setOcrData(ocrResult)

      // Step 2: Translation
      const translationResult = await translatorService.translateText(ocrResult.text)
      setTranslationData(translationResult)

      setHasProcessed(true)
    } catch (error) {
      console.error('Processing error:', error)
      setError(error instanceof Error ? error.message : 'An unknown error occurred')
    } finally {
      setIsProcessing(false)
    }
  }

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setActiveTab(newValue)
  }

  // Validate configuration on app start
  useEffect(() => {
    const { valid, errors } = validateConfig()
    if (!valid) {
      setError(`Configuration Error: ${errors.join(', ')}`)
    }
  }, [])

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ 
        height: '100vh', 
        width: '100vw', 
        display: 'flex', 
        flexDirection: 'column',
        overflow: 'hidden'
      }}>
        <AppBar position="static" elevation={1}>
          <Toolbar>
            <Psychology sx={{ mr: 2 }} />
            <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
              Document Intelligence Preview
            </Typography>
          </Toolbar>
        </AppBar>

        <Box sx={{ flex: 1, overflow: 'hidden', width: '100%' }}>
          <PanelGroup direction="horizontal" style={{ height: '100%', width: '100%' }}>
            {/* Left Panel - File Drop and Image Preview */}
            <Panel defaultSize={50} minSize={30}>
              <Paper sx={{ 
                height: '100%', 
                width: '100%',
                display: 'flex', 
                flexDirection: 'column',
                borderRadius: 0,
                boxShadow: 'none',
                borderRight: 1,
                borderColor: 'divider'
              }}>
                {!selectedFile ? (
                  <Box sx={{ flex: 1, p: 2 }}>
                    <FileDropArea onFileSelect={handleFileSelect} />
                  </Box>
                ) : (
                  <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                    <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
                      <Typography variant="h6" gutterBottom>
                        Document Preview
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {selectedFile.name}
                      </Typography>
                    </Box>
                    <Box sx={{ flex: 1, p: 2, minHeight: 0 }}>
                      <ImagePreview 
                        imageUrl={imageUrl} 
                        highlights={hasProcessed ? ocrData?.blocks : []}
                      />
                    </Box>
                    <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider', flexShrink: 0 }}>
                      <Box sx={{ display: 'flex', gap: 1 }}>
                        <Button
                          variant="contained"
                          onClick={handleProcess}
                          disabled={isProcessing}
                          startIcon={isProcessing ? <CircularProgress size={20} /> : <CloudUpload />}
                          sx={{ flex: 1 }}
                        >
                          {isProcessing ? 'Processing...' : 'Process Document'}
                        </Button>
                        <Button
                          variant="outlined"
                          component="label"
                          startIcon={<CloudUpload />}
                          disabled={isProcessing}
                          sx={{ minWidth: 'auto', whiteSpace: 'nowrap' }}
                        >
                          Upload New
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden-file-input"
                            aria-label="Upload new document"
                            onChange={(e) => {
                              const file = e.target.files?.[0]
                              if (file && file.type.startsWith('image/')) {
                                handleFileSelect(file)
                              }
                              // Reset the input value so the same file can be selected again
                              e.target.value = ''
                            }}
                          />
                        </Button>
                      </Box>
                      {error && (
                        <Alert severity="error" sx={{ mt: 2 }}>
                          {error}
                        </Alert>
                      )}
                    </Box>
                  </Box>
                )}
              </Paper>
            </Panel>

            {/* Resize Handle */}
            <PanelResizeHandle style={{
              width: '4px',
              backgroundColor: '#e0e0e0',
              cursor: 'col-resize',
              borderLeft: 'none',
              borderRight: 'none',
              transition: 'background-color 0.2s ease'
            }} />

            {/* Right Panel - Results Tabs */}
            <Panel defaultSize={50} minSize={30}>
              <Paper sx={{ 
                height: '100%', 
                width: '100%',
                display: 'flex', 
                flexDirection: 'column',
                borderRadius: 0,
                boxShadow: 'none'
              }}>
                <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
                  <Tabs value={activeTab} onChange={handleTabChange}>
                    <Tab label="OCR Results" icon={<Psychology />} />
                    <Tab label="Translation" icon={<Translate />} />
                    <Tab label="AI Analysis" icon={<SmartToy />} />
                    <Tab label="Vectorization" icon={<Hub />} />
                  </Tabs>
                </Box>
                
                <Box sx={{ flex: 1, p: 2, overflow: 'hidden' }}>
                  {activeTab === 0 && (
                    <OCRTab 
                      data={ocrData} 
                      isProcessing={isProcessing}
                      hasFile={!!selectedFile}
                    />
                  )}
                  {activeTab === 1 && (
                    <TranslationTab 
                      data={translationData} 
                      isProcessing={isProcessing}
                      hasFile={!!selectedFile}
                    />
                  )}
                  {activeTab === 2 && (
                    <AOAITab 
                      ocrData={ocrData} 
                      hasFile={!!selectedFile}
                    />
                  )}
                  {activeTab === 3 && (
                    <VectorizationTab 
                      ocrData={ocrData} 
                      hasFile={!!selectedFile}
                    />
                  )}
                </Box>
              </Paper>
            </Panel>
          </PanelGroup>
        </Box>
      </Box>
    </ThemeProvider>
  )
}

export default App
