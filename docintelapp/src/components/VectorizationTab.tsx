import React, { useState, useCallback } from 'react'
import { 
  Box, 
  Typography, 
  Paper, 
  Alert, 
  Button,
  CircularProgress,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Chip,
  Card,
  CardContent,
  List,
  ListItem,
  ListItemText,
  ListItemIcon
} from '@mui/material'
import { 
  Hub, 
  Timeline, 
  Info, 
  ExpandMore, 
  Memory,
  Functions,
  DataArray,
  Analytics
} from '@mui/icons-material'
import { EmbeddingService, type EmbeddingResult } from '../services/embedding'

interface VectorizationTabProps {
  ocrData: {
    text: string
    confidence: number
    language: string
    blocks: Array<{
      text: string
      boundingBox: number[]
      confidence?: number
    }>
  } | null
  hasFile: boolean
}

const VectorizationTab: React.FC<VectorizationTabProps> = ({ ocrData, hasFile }) => {
  const [embeddingData, setEmbeddingData] = useState<EmbeddingResult | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const embeddingService = new EmbeddingService()

  const handleGenerateEmbedding = useCallback(async () => {
    if (!ocrData?.text) {
      setError('No text available for vectorization')
      return
    }

    setIsGenerating(true)
    setError(null)
    setEmbeddingData(null)

    try {
      const result = await embeddingService.generateEmbedding(ocrData.text)
      setEmbeddingData(result)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred'
      setError(errorMessage)
    } finally {
      setIsGenerating(false)
    }
  }, [ocrData?.text, embeddingService])

  const renderVectorStats = (data: EmbeddingResult) => {
    const stats = embeddingService.getVectorStats(data.vectors)
    
    return (
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            <Analytics sx={{ mr: 1, verticalAlign: 'middle' }} />
            Vector Statistics
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
            <Paper sx={{ p: 1.5, textAlign: 'center', minWidth: 120 }}>
              <Typography variant="body2" color="text.secondary">
                Dimensions
              </Typography>
              <Typography variant="h6">
                {data.dimensions.toLocaleString()}
              </Typography>
            </Paper>
            <Paper sx={{ p: 1.5, textAlign: 'center', minWidth: 120 }}>
              <Typography variant="body2" color="text.secondary">
                Mean
              </Typography>
              <Typography variant="h6">
                {stats.mean.toFixed(4)}
              </Typography>
            </Paper>
            <Paper sx={{ p: 1.5, textAlign: 'center', minWidth: 120 }}>
              <Typography variant="body2" color="text.secondary">
                Std Dev
              </Typography>
              <Typography variant="h6">
                {stats.std.toFixed(4)}
              </Typography>
            </Paper>
            <Paper sx={{ p: 1.5, textAlign: 'center', minWidth: 120 }}>
              <Typography variant="body2" color="text.secondary">
                Norm
              </Typography>
              <Typography variant="h6">
                {stats.norm.toFixed(4)}
              </Typography>
            </Paper>
          </Box>
        </CardContent>
      </Card>
    )
  }

  const renderVectorPreview = (vectors: number[]) => {
    const previewSize = 20
    const preview = vectors.slice(0, previewSize)
    
    return (
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            <DataArray sx={{ mr: 1, verticalAlign: 'middle' }} />
            Vector Preview (First {previewSize} dimensions)
          </Typography>
          <Box sx={{ 
            display: 'flex', 
            flexWrap: 'wrap', 
            gap: 0.5,
            maxHeight: 150,
            overflowY: 'auto'
          }}>
            {preview.map((value, index) => (
              <Chip
                key={index}
                label={`${index}: ${value.toFixed(4)}`}
                size="small"
                variant="outlined"
                sx={{ fontFamily: 'monospace' }}
              />
            ))}
            {vectors.length > previewSize && (
              <Chip
                label={`... and ${vectors.length - previewSize} more`}
                size="small"
                variant="filled"
                color="secondary"
              />
            )}
          </Box>
        </CardContent>
      </Card>
    )
  }

  if (!hasFile) {
    return (
      <Box sx={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        height: '100%',
        flexDirection: 'column'
      }}>
        <Hub sx={{ fontSize: 80, color: 'grey.300', mb: 2 }} />
        <Typography variant="h6" color="text.secondary">
          No document selected
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Upload a document to generate embeddings
        </Typography>
      </Box>
    )
  }

  if (!ocrData) {
    return (
      <Box sx={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        height: '100%',
        flexDirection: 'column'
      }}>
        <Memory sx={{ fontSize: 80, color: 'grey.300', mb: 2 }} />
        <Typography variant="h6" color="text.secondary">
          Process document first
        </Typography>
        <Typography variant="body2" color="text.secondary">
          OCR analysis is required before vectorization
        </Typography>
      </Box>
    )
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ mb: 2 }}>
        <Typography variant="h5" gutterBottom>
          <Hub sx={{ mr: 1, verticalAlign: 'middle' }} />
          Text Vectorization
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Generate embeddings from extracted text using Azure OpenAI
        </Typography>
      </Box>

      <Box sx={{ mb: 2 }}>
        <Button
          variant="contained"
          onClick={handleGenerateEmbedding}
          disabled={isGenerating || !ocrData?.text}
          startIcon={isGenerating ? <CircularProgress size={20} /> : <Functions />}
          size="large"
        >
          {isGenerating ? 'Generating Embeddings...' : 'Generate Embeddings'}
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {embeddingData && (
        <Box sx={{ flex: 1, overflow: 'auto' }}>
          <Paper sx={{ p: 2, mb: 2 }}>
            <Typography variant="h6" gutterBottom>
              <Info sx={{ mr: 1, verticalAlign: 'middle' }} />
              Embedding Information
            </Typography>
            <List dense>
              <ListItem>
                <ListItemIcon>
                  <Timeline />
                </ListItemIcon>
                <ListItemText 
                  primary="Model" 
                  secondary={embeddingData.model}
                />
              </ListItem>
              <ListItem>
                <ListItemIcon>
                  <Memory />
                </ListItemIcon>
                <ListItemText 
                  primary="Generated" 
                  secondary={new Date(embeddingData.timestamp).toLocaleString()}
                />
              </ListItem>
              <ListItem>
                <ListItemIcon>
                  <DataArray />
                </ListItemIcon>
                <ListItemText 
                  primary="Text Sample" 
                  secondary={embeddingData.text}
                />
              </ListItem>
            </List>
          </Paper>

          {renderVectorStats(embeddingData)}
          {renderVectorPreview(embeddingData.vectors)}

          <Accordion>
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Typography variant="h6">
                Complete Vector Data ({embeddingData.vectors.length} dimensions)
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Paper sx={{ 
                p: 2, 
                maxHeight: 300, 
                overflow: 'auto',
                backgroundColor: 'grey.50'
              }}>
                <Typography variant="body2" component="pre" sx={{ 
                  fontFamily: 'monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all'
                }}>
                  {JSON.stringify(embeddingData.vectors, null, 2)}
                </Typography>
              </Paper>
            </AccordionDetails>
          </Accordion>
        </Box>
      )}
    </Box>
  )
}

export default VectorizationTab
