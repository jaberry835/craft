import { getAzureConfig } from './config'

export interface OCRBlock {
  text: string
  boundingBox: number[]
  confidence?: number
}

export interface OCRResult {
  text: string
  confidence: number
  language: string
  blocks: OCRBlock[]
}

export interface DocumentIntelligenceResponse {
  analyzeResult: {
    content: string
    pages: Array<{
      pageNumber: number
      width: number
      height: number
      unit: string
      lines: Array<{
        content: string
        boundingBox: number[]
        spans: Array<{
          offset: number
          length: number
        }>
      }>
    }>
    languages: Array<{
      locale: string
      confidence: number
    }>
  }
}

const mockOCRData: OCRResult = {
  text: "Hola, este es un documento de prueba. Contiene información importante sobre el proyecto de inteligencia de documentos. La tecnología de OCR puede extraer texto de imágenes y documentos escaneados con alta precisión.",
  confidence: 0.95,
  language: "es",
  blocks: [
    { text: "Hola, este es un documento de prueba.", boundingBox: [50, 50, 400, 80], confidence: 0.98 },
    { text: "Contiene información importante sobre el proyecto", boundingBox: [50, 100, 450, 130], confidence: 0.95 },
    { text: "de inteligencia de documentos.", boundingBox: [50, 140, 350, 170], confidence: 0.92 },
    { text: "La tecnología de OCR puede extraer texto", boundingBox: [50, 190, 420, 220], confidence: 0.97 },
    { text: "de imágenes y documentos escaneados", boundingBox: [50, 230, 380, 260], confidence: 0.94 },
    { text: "con alta precisión.", boundingBox: [50, 270, 250, 300], confidence: 0.96 }
  ]
}

export class DocumentIntelligenceService {
  private config = getAzureConfig()

  async analyzeDocument(file: File): Promise<OCRResult> {
    if (this.config.useMockData) {
      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 2000))
      return mockOCRData
    }

    try {
      const formData = new FormData()
      formData.append('file', file)

      const response = await fetch(
        `${this.config.documentIntelligence.endpoint}/formrecognizer/documentModels/prebuilt-read:analyze?api-version=2023-07-31`,
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': this.config.documentIntelligence.key,
          },
          body: formData
        }
      )

      if (!response.ok) {
        throw new Error(`Document Intelligence API error: ${response.status} ${response.statusText}`)
      }

      // Get the operation location from the response headers
      const operationLocation = response.headers.get('Operation-Location')
      if (!operationLocation) {
        throw new Error('No operation location returned from Document Intelligence API')
      }

      // Poll for results
      const result = await this.pollForResults(operationLocation)
      return this.parseDocumentIntelligenceResponse(result)
    } catch (error) {
      console.error('Document Intelligence API error:', error)
      throw error
    }
  }

  private async pollForResults(operationLocation: string): Promise<DocumentIntelligenceResponse> {
    const maxAttempts = 30
    const pollInterval = 1000

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(operationLocation, {
          headers: {
            'Ocp-Apim-Subscription-Key': this.config.documentIntelligence.key,
          }
        })

        if (!response.ok) {
          throw new Error(`Polling error: ${response.status} ${response.statusText}`)
        }

        const result = await response.json()
        
        if (result.status === 'succeeded') {
          return result
        } else if (result.status === 'failed') {
          throw new Error(`Document analysis failed: ${result.error?.message || 'Unknown error'}`)
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval))
      } catch (error) {
        console.error(`Polling attempt ${attempt + 1} failed:`, error)
        if (attempt === maxAttempts - 1) {
          throw error
        }
      }
    }

    throw new Error('Document analysis timed out')
  }

  private parseDocumentIntelligenceResponse(response: DocumentIntelligenceResponse): OCRResult {
    const { analyzeResult } = response
    
    // Extract text blocks with bounding boxes
    const blocks: OCRBlock[] = []
    let fullText = ''
    
    if (analyzeResult.pages) {
      for (const page of analyzeResult.pages) {
        for (const line of page.lines || []) {
          blocks.push({
            text: line.content,
            boundingBox: line.boundingBox,
            confidence: 0.95 // Document Intelligence doesn't provide line-level confidence
          })
          fullText += line.content + ' '
        }
      }
    }

    // Detect language
    const detectedLanguage = analyzeResult.languages?.[0]?.locale || 'en'
    const confidence = analyzeResult.languages?.[0]?.confidence || 0.95

    return {
      text: fullText.trim(),
      confidence,
      language: detectedLanguage,
      blocks
    }
  }
}
