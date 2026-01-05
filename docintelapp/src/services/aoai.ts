import { getAzureConfig } from './config'

export interface AOAIAnalysisResult {
  summary: string
  context: string
  translatedAndFormatted: string
}

export class AOAIService {
  private static async makeRequest(prompt: string, ocrText: string): Promise<string> {
    const config = getAzureConfig()
    
    if (!config.aoai.endpoint || !config.aoai.key) {
      throw new Error('Azure OpenAI configuration is missing. Please check your environment variables.')
    }

    const response = await fetch(`${config.aoai.endpoint}/openai/deployments/${config.aoai.deploymentName}/chat/completions?api-version=2024-02-15-preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': config.aoai.key,
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: 'You are an expert document analysis assistant. Provide clear, concise, and helpful responses.'
          },
          {
            role: 'user',
            content: `${prompt}\n\nDocument text:\n${ocrText}`
          }
        ],
        max_tokens: 1000,
        temperature: 0.3,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Azure OpenAI API error: ${response.status} - ${errorText}`)
    }

    const data = await response.json()
    return data.choices[0]?.message?.content || 'No response generated'
  }

  static async summarizeDocument(ocrText: string): Promise<string> {
    const prompt = `Please provide a concise summary of this document. Focus on the main points and key information.`
    return this.makeRequest(prompt, ocrText)
  }

  static async provideContext(ocrText: string): Promise<string> {
    const prompt = `Analyze this document and provide additional context, background information, or insights that would help someone understand it better. Consider the document type, purpose, and any relevant industry or domain knowledge.`
    return this.makeRequest(prompt, ocrText)
  }

  static async translateAndFormat(ocrText: string): Promise<string> {
    const prompt = `Please translate this document to English (if it's not already in English) and format it in a clean, professional manner. Improve readability while preserving all the important information and maintaining the document's structure.`
    return this.makeRequest(prompt, ocrText)
  }
}
