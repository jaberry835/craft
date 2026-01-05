import React from 'react'
import { 
  Box, 
  Typography, 
  Paper, 
  Alert, 
  Chip, 
  Divider,
  List,
  ListItem,
  ListItemText,
  CircularProgress
} from '@mui/material'
import { TextFields, Language, Visibility } from '@mui/icons-material'

interface OCRTabProps {
  data: {
    text: string
    confidence: number
    language: string
    blocks: Array<{
      text: string
      boundingBox: number[]
      confidence?: number
    }>
  } | null
  isProcessing: boolean
  hasFile: boolean
}

const OCRTab: React.FC<OCRTabProps> = ({ data, isProcessing, hasFile }) => {
  if (!hasFile) {
    return (
      <Box sx={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        height: '100%',
        flexDirection: 'column'
      }}>
        <TextFields sx={{ fontSize: 80, color: 'grey.300', mb: 2 }} />
        <Typography variant="h6" color="text.secondary">
          No document selected
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Upload a document to see OCR results
        </Typography>
      </Box>
    )
  }

  if (isProcessing) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <CircularProgress size={60} sx={{ mb: 2 }} />
        <Typography variant="h6" gutterBottom>
          Analyzing document...
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Using Azure Document Intelligence
        </Typography>
      </Box>
    )
  }

  if (!data) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="info">
          Click "Process Document" to extract text from your image
        </Alert>
      </Box>
    )
  }

  return (
    <Box sx={{ height: '100%', overflow: 'auto' }}>
      {/* Header with metadata */}
      <Box sx={{ mb: 3 }}>
        <Typography variant="h6" gutterBottom>
          OCR Results
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
          <Chip 
            icon={<Language />} 
            label={`Language: ${data.language.toUpperCase()}`}
            size="small"
            color="primary"
          />
          <Chip 
            icon={<Visibility />} 
            label={`Confidence: ${(data.confidence * 100).toFixed(1)}%`}
            size="small"
            color="secondary"
          />
          <Chip 
            label={`${Array.isArray(data.blocks) ? data.blocks.length : 0} text blocks`}
            size="small"
            variant="outlined"
          />
        </Box>
      </Box>

      {/* Full extracted text */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle2" gutterBottom>
          Extracted Text
        </Typography>
        <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap' }}>
          {data.text}
        </Typography>
      </Paper>

      <Divider sx={{ mb: 2 }} />

      {/* Individual text blocks */}
      <Typography variant="subtitle2" gutterBottom>
        Text Blocks
      </Typography>
      <List dense>
        {Array.isArray(data.blocks) && data.blocks.map((block: any, index: number) => (
          <ListItem key={index} sx={{ px: 0 }}>
            <Paper sx={{ width: '100%', p: 1 }}>
              <ListItemText
                primary={block.text || 'No text'}
                secondary={`Block ${index + 1}${
                  block.boundingBox && Array.isArray(block.boundingBox) 
                    ? ` • Position: [${block.boundingBox.join(', ')}]` 
                    : ''
                }`}
              />
            </Paper>
          </ListItem>
        ))}
      </List>
    </Box>
  )
}

export default OCRTab
