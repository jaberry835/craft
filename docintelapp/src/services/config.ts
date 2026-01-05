export interface AzureConfig {
  documentIntelligence: {
    endpoint: string
    key: string
  }
  translator: {
    endpoint: string
    key: string
    region: string
  }
  aoai: {
    endpoint: string
    key: string
    deploymentName: string
    embeddingDeploymentName: string
  }
  useMockData: boolean
  apiTimeout: number
}

export const getAzureConfig = (): AzureConfig => {
  return {
    documentIntelligence: {
      endpoint: import.meta.env.VITE_AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || '',
      key: import.meta.env.VITE_AZURE_DOCUMENT_INTELLIGENCE_KEY || ''
    },
    translator: {
      endpoint: import.meta.env.VITE_AZURE_TRANSLATOR_ENDPOINT || 'https://api.cognitive.microsofttranslator.com/',
      key: import.meta.env.VITE_AZURE_TRANSLATOR_KEY || '',
      region: import.meta.env.VITE_AZURE_TRANSLATOR_REGION || ''
    },
    aoai: {
      endpoint: import.meta.env.VITE_AZURE_AOAI_ENDPOINT || '',
      key: import.meta.env.VITE_AZURE_AOAI_KEY || '',
      deploymentName: import.meta.env.VITE_AZURE_AOAI_DEPLOYMENT_NAME || 'gpt-4',
      embeddingDeploymentName: import.meta.env.VITE_AZURE_AOAI_EMBEDDING_DEPLOYMENT_NAME || 'text-embedding-3-small'
    },
    useMockData: import.meta.env.VITE_USE_MOCK_DATA === 'true',
    apiTimeout: parseInt(import.meta.env.VITE_API_TIMEOUT || '30000')
  }
}

export const validateConfig = (): { valid: boolean; errors: string[] } => {
  const config = getAzureConfig()
  const errors: string[] = []

  if (!config.useMockData) {
    if (!config.documentIntelligence.endpoint) {
      errors.push('Document Intelligence endpoint is required')
    }
    if (!config.documentIntelligence.key) {
      errors.push('Document Intelligence key is required')
    }
    if (!config.translator.endpoint) {
      errors.push('Translator endpoint is required')
    }
    if (!config.translator.key) {
      errors.push('Translator key is required')
    }
    if (!config.translator.region) {
      errors.push('Translator region is required')
    }
    if (!config.aoai.endpoint) {
      errors.push('Azure OpenAI endpoint is required')
    }
    if (!config.aoai.key) {
      errors.push('Azure OpenAI key is required')
    }
    if (!config.aoai.deploymentName) {
      errors.push('Azure OpenAI deployment name is required')
    }
  }

  return {
    valid: errors.length === 0,
    errors
  }
}
