import React, { useState } from 'react'
import { 
  Box, 
  Typography, 
  Button, 
  Paper, 
  Alert, 
  CircularProgress,
  Accordion,
  AccordionSummary,
  AccordionDetails
} from '@mui/material'
import { 
  SmartToy, 
  Summarize, 
  Info, 
  Transform,
  ExpandMore
} from '@mui/icons-material'
import { AOAIService } from '../services/aoai'

interface AOAITabProps {
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

const AOAITab: React.FC<AOAITabProps> = ({ ocrData, hasFile }) => {
  const [summary, setSummary] = useState<string>('')
  const [context, setContext] = useState<string>('')
  const [translatedFormatted, setTranslatedFormatted] = useState<string>('')
  const [loading, setLoading] = useState<{
    summary: boolean
    context: boolean
    translateFormat: boolean
  }>({
    summary: false,
    context: false,
    translateFormat: false
  })
  const [errors, setErrors] = useState<{
    summary: string | null
    context: string | null
    translateFormat: string | null
  }>({
    summary: null,
    context: null,
    translateFormat: null
  })

  const handleSummarize = async () => {
    if (!ocrData?.text) return
    
    setLoading(prev => ({ ...prev, summary: true }))
    setErrors(prev => ({ ...prev, summary: null }))
    
    try {
      const result = await AOAIService.summarizeDocument(ocrData.text)
      setSummary(result)
    } catch (error) {
      setErrors(prev => ({ ...prev, summary: error instanceof Error ? error.message : 'Failed to summarize document' }))
    } finally {
      setLoading(prev => ({ ...prev, summary: false }))
    }
  }

  const handleProvideContext = async () => {
    if (!ocrData?.text) return
    
    setLoading(prev => ({ ...prev, context: true }))
    setErrors(prev => ({ ...prev, context: null }))
    
    try {
      const result = await AOAIService.provideContext(ocrData.text)
      setContext(result)
    } catch (error) {
      setErrors(prev => ({ ...prev, context: error instanceof Error ? error.message : 'Failed to provide context' }))
    } finally {
      setLoading(prev => ({ ...prev, context: false }))
    }
  }

  const handleTranslateAndFormat = async () => {
    if (!ocrData?.text) return
    
    setLoading(prev => ({ ...prev, translateFormat: true }))
    setErrors(prev => ({ ...prev, translateFormat: null }))
    
    try {
      const result = await AOAIService.translateAndFormat(ocrData.text)
      setTranslatedFormatted(result)
    } catch (error) {
      setErrors(prev => ({ ...prev, translateFormat: error instanceof Error ? error.message : 'Failed to translate and format' }))
    } finally {
      setLoading(prev => ({ ...prev, translateFormat: false }))
    }
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
        <SmartToy sx={{ fontSize: 80, color: 'grey.300', mb: 2 }} />
        <Typography variant="h6" color="text.secondary">
          No document selected
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Upload and process a document to use AI analysis
        </Typography>
      </Box>
    )
  }

  if (!ocrData) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="info">
          Process the document first to use AI analysis features
        </Alert>
      </Box>
    )
  }

  return (
    <Box sx={{ height: '100%', overflow: 'auto' }}>
      <Typography variant="h6" gutterBottom>
        AI Analysis
      </Typography>
      
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Use Azure OpenAI to analyze your document with advanced AI capabilities
      </Typography>

      {/* Action Buttons */}
      <Box sx={{ display: 'flex', gap: 1, mb: 3, flexWrap: 'wrap' }}>
        <Button
          variant="contained"
          startIcon={loading.summary ? <CircularProgress size={20} /> : <Summarize />}
          onClick={handleSummarize}
          disabled={loading.summary}
          size="small"
        >
          {loading.summary ? 'Summarizing...' : 'Summarize Document'}
        </Button>
        
        <Button
          variant="contained"
          startIcon={loading.context ? <CircularProgress size={20} /> : <Info />}
          onClick={handleProvideContext}
          disabled={loading.context}
          size="small"
        >
          {loading.context ? 'Analyzing...' : 'Provide Context'}
        </Button>
        
        <Button
          variant="contained"
          startIcon={loading.translateFormat ? <CircularProgress size={20} /> : <Transform />}
          onClick={handleTranslateAndFormat}
          disabled={loading.translateFormat}
          size="small"
        >
          {loading.translateFormat ? 'Processing...' : 'Translate & Format'}
        </Button>
      </Box>

      {/* Results */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {/* Summary */}
        {(summary || errors.summary) && (
          <Accordion defaultExpanded={!!summary}>
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Summarize color="primary" />
                <Typography variant="subtitle1">Document Summary</Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails>
              {errors.summary ? (
                <Alert severity="error">{errors.summary}</Alert>
              ) : (
                <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                  {summary}
                </Typography>
              )}
            </AccordionDetails>
          </Accordion>
        )}

        {/* Context */}
        {(context || errors.context) && (
          <Accordion defaultExpanded={!!context}>
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Info color="primary" />
                <Typography variant="subtitle1">Additional Context</Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails>
              {errors.context ? (
                <Alert severity="error">{errors.context}</Alert>
              ) : (
                <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                  {context}
                </Typography>
              )}
            </AccordionDetails>
          </Accordion>
        )}

        {/* Translated & Formatted */}
        {(translatedFormatted || errors.translateFormat) && (
          <Accordion defaultExpanded={!!translatedFormatted}>
            <AccordionSummary expandIcon={<ExpandMore />}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Transform color="primary" />
                <Typography variant="subtitle1">Translated & Formatted</Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails>
              {errors.translateFormat ? (
                <Alert severity="error">{errors.translateFormat}</Alert>
              ) : (
                <Paper sx={{ p: 2, backgroundColor: 'grey.50' }}>
                  <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                    {translatedFormatted}
                  </Typography>
                </Paper>
              )}
            </AccordionDetails>
          </Accordion>
        )}
      </Box>
    </Box>
  )
}

export default AOAITab
