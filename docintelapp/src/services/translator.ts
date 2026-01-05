import { getAzureConfig } from './config'

export interface TranslationResult {
  translatedText: string
  detectedLanguage: string
  detectedLanguageCode: string
  confidence: number
  targetLanguage: string
}

export interface TranslatorResponse {
  detectedLanguage?: {
    language: string
    score: number
  }
  translations: Array<{
    text: string
    to: string
  }>
}

const mockTranslationData: TranslationResult = {
  translatedText: "Hello, this is a test document. It contains important information about the document intelligence project. OCR technology can extract text from images and scanned documents with high accuracy.",
  detectedLanguage: "Spanish",
  detectedLanguageCode: "es",
  confidence: 0.98,
  targetLanguage: "en"
}

export class TranslatorService {
  private config = getAzureConfig()

  async translateText(text: string, targetLanguage: string = 'en'): Promise<TranslationResult> {
    if (this.config.useMockData) {
      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 1500))
      return mockTranslationData
    }

    try {
      const response = await fetch(
        `${this.config.translator.endpoint}/translate?api-version=3.0&to=${targetLanguage}`,
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': this.config.translator.key,
            'Ocp-Apim-Subscription-Region': this.config.translator.region,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify([{ text }])
        }
      )

      if (!response.ok) {
        throw new Error(`Translator API error: ${response.status} ${response.statusText}`)
      }

      const result: TranslatorResponse[] = await response.json()
      return this.parseTranslatorResponse(result[0], targetLanguage)
    } catch (error) {
      console.error('Translator API error:', error)
      throw error
    }
  }

  async detectLanguage(text: string): Promise<{ language: string; languageCode: string; confidence: number }> {
    if (this.config.useMockData) {
      return {
        language: "Spanish",
        languageCode: "es",
        confidence: 0.98
      }
    }

    try {
      const response = await fetch(
        `${this.config.translator.endpoint}/detect?api-version=3.0`,
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': this.config.translator.key,
            'Ocp-Apim-Subscription-Region': this.config.translator.region,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify([{ text }])
        }
      )

      if (!response.ok) {
        throw new Error(`Language detection API error: ${response.status} ${response.statusText}`)
      }

      const result = await response.json()
      const detection = result[0]
      
      return {
        language: this.getLanguageName(detection.language),
        languageCode: detection.language,
        confidence: detection.score
      }
    } catch (error) {
      console.error('Language detection API error:', error)
      throw error
    }
  }

  private parseTranslatorResponse(response: TranslatorResponse, targetLanguage: string): TranslationResult {
    const translation = response.translations[0]
    const detectedLanguage = response.detectedLanguage
    
    return {
      translatedText: translation.text,
      detectedLanguage: detectedLanguage ? this.getLanguageName(detectedLanguage.language) : 'Unknown',
      detectedLanguageCode: detectedLanguage?.language || 'unknown',
      confidence: detectedLanguage?.score || 0.5,
      targetLanguage
    }
  }

  private getLanguageName(languageCode: string): string {
    const languageMap: { [key: string]: string } = {
      'en': 'English',
      'es': 'Spanish',
      'fr': 'French',
      'de': 'German',
      'it': 'Italian',
      'pt': 'Portuguese',
      'ru': 'Russian',
      'ja': 'Japanese',
      'ko': 'Korean',
      'zh': 'Chinese',
      'ar': 'Arabic',
      'hi': 'Hindi',
      'th': 'Thai',
      'vi': 'Vietnamese',
      'nl': 'Dutch',
      'sv': 'Swedish',
      'da': 'Danish',
      'no': 'Norwegian',
      'fi': 'Finnish',
      'pl': 'Polish',
      'cs': 'Czech',
      'sk': 'Slovak',
      'hu': 'Hungarian',
      'ro': 'Romanian',
      'bg': 'Bulgarian',
      'hr': 'Croatian',
      'sr': 'Serbian',
      'sl': 'Slovenian',
      'et': 'Estonian',
      'lv': 'Latvian',
      'lt': 'Lithuanian',
      'uk': 'Ukrainian',
      'be': 'Belarusian',
      'mk': 'Macedonian',
      'sq': 'Albanian',
      'mt': 'Maltese',
      'ga': 'Irish',
      'cy': 'Welsh',
      'eu': 'Basque',
      'ca': 'Catalan',
      'gl': 'Galician',
      'is': 'Icelandic',
      'ms': 'Malay',
      'id': 'Indonesian',
      'tl': 'Filipino',
      'sw': 'Swahili',
      'af': 'Afrikaans',
      'zu': 'Zulu',
      'xh': 'Xhosa',
      'st': 'Sesotho',
      'nso': 'Sesotho sa Leboa',
      'tn': 'Setswana',
      'ss': 'Siswati',
      'ts': 'Xitsonga',
      've': 'Tshivenda',
      'nr': 'isiNdebele',
    }
    
    return languageMap[languageCode] || languageCode.toUpperCase()
  }
}
