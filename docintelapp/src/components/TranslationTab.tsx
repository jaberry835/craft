import React from 'react'
import { 
  Box, 
  Typography, 
  Paper, 
  Chip, 
  Alert,
  CircularProgress
} from '@mui/material'
import { Translate, Language, Visibility } from '@mui/icons-material'

interface TranslationTabProps {
  data: any
  isProcessing: boolean
  hasFile: boolean
}

const TranslationTab: React.FC<TranslationTabProps> = ({ data, isProcessing, hasFile }) => {
  if (!hasFile) {
    return (
      <Box sx={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        height: '100%',
        flexDirection: 'column'
      }}>
        <Translate sx={{ fontSize: 80, color: 'grey.300', mb: 2 }} />
        <Typography variant="h6" color="text.secondary">
          No document selected
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Upload a document to see translation
        </Typography>
      </Box>
    )
  }

  if (isProcessing) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <CircularProgress size={60} sx={{ mb: 2 }} />
        <Typography variant="h6" gutterBottom>
          Translating text...
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Using Azure Translator
        </Typography>
      </Box>
    )
  }

  if (!data) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="info">
          Process the document first to see translation results
        </Alert>
      </Box>
    )
  }

  return (
    <Box sx={{ height: '100%', overflow: 'auto' }}>
      {/* Header with metadata */}
      <Box sx={{ mb: 3 }}>
        <Typography variant="h6" gutterBottom>
          Translation Results
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
          <Chip 
            icon={<Language />} 
            label={`From: ${data.detectedLanguage}`}
            size="small"
            color="primary"
          />
          <Chip 
            icon={<Translate />} 
            label="To: English"
            size="small"
            color="secondary"
          />
          <Chip 
            icon={<Visibility />} 
            label={`Confidence: ${(data.confidence * 100).toFixed(1)}%`}
            size="small"
            variant="outlined"
          />
        </Box>
      </Box>

      {/* Translation result */}
      <Box sx={{ flex: 1, overflow: 'auto' }}>
        <Typography variant="subtitle1" gutterBottom>
          Translated Text
        </Typography>
        <Paper sx={{ p: 2, backgroundColor: 'grey.50', minHeight: '200px' }}>
          <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
            {data.translatedText}
          </Typography>
        </Paper>
        
        <Box sx={{ mt: 2 }}>
          <Typography variant="caption" color="text.secondary">
            Language detection confidence: {Math.round(data.confidence * 100)}%
          </Typography>
        </Box>
      </Box>
    </Box>
  )
}

export default TranslationTab
