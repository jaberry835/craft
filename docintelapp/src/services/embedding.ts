import { getAzureConfig } from './config'

export interface EmbeddingResult {
  vectors: number[]
  dimensions: number
  model: string
  text: string
  timestamp: string
}

export interface EmbeddingResponse {
  data: Array<{
    embedding: number[]
    index: number
    object: string
  }>
  model: string
  object: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}

const mockEmbeddingData: EmbeddingResult = {
  vectors: Array.from({ length: 1536 }, () => Math.random() * 2 - 1), // Random values between -1 and 1
  dimensions: 1536,
  model: 'text-embedding-3-small',
  text: 'Sample document text that has been vectorized',
  timestamp: new Date().toISOString()
}

export class EmbeddingService {
  private config = getAzureConfig()
  private embeddingEndpoint: string
  private embeddingKey: string
  private embeddingDeploymentName: string

  constructor() {
    // Use OpenAI endpoint for embeddings
    this.embeddingEndpoint = this.config.aoai.endpoint
    this.embeddingKey = this.config.aoai.key
    this.embeddingDeploymentName = this.config.aoai.embeddingDeploymentName
  }

  async generateEmbedding(text: string): Promise<EmbeddingResult> {
    if (this.config.useMockData) {
      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 1000))
      
      return {
        ...mockEmbeddingData,
        text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
        timestamp: new Date().toISOString()
      }
    }

    try {
      const response = await fetch(`${this.embeddingEndpoint}/openai/deployments/${this.embeddingDeploymentName}/embeddings?api-version=2023-05-15`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.embeddingKey
        },
        body: JSON.stringify({
          input: text,
          model: this.embeddingDeploymentName
        })
      })

      if (!response.ok) {
        throw new Error(`Embedding API error: ${response.status} ${response.statusText}`)
      }

      const data: EmbeddingResponse = await response.json()
      
      return {
        vectors: data.data[0].embedding,
        dimensions: data.data[0].embedding.length,
        model: data.model,
        text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      console.error('Embedding generation failed:', error)
      throw error
    }
  }

  // Helper method to calculate cosine similarity between two vectors
  calculateCosineSimilarity(vectorA: number[], vectorB: number[]): number {
    if (vectorA.length !== vectorB.length) {
      throw new Error('Vectors must have the same length')
    }

    const dotProduct = vectorA.reduce((sum, a, i) => sum + a * vectorB[i], 0)
    const magnitudeA = Math.sqrt(vectorA.reduce((sum, a) => sum + a * a, 0))
    const magnitudeB = Math.sqrt(vectorB.reduce((sum, b) => sum + b * b, 0))

    return dotProduct / (magnitudeA * magnitudeB)
  }

  // Helper method to get vector statistics
  getVectorStats(vectors: number[]): {
    mean: number
    std: number
    min: number
    max: number
    norm: number
  } {
    const mean = vectors.reduce((sum, val) => sum + val, 0) / vectors.length
    const variance = vectors.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / vectors.length
    const std = Math.sqrt(variance)
    const min = Math.min(...vectors)
    const max = Math.max(...vectors)
    const norm = Math.sqrt(vectors.reduce((sum, val) => sum + val * val, 0))

    return { mean, std, min, max, norm }
  }
}
