// Define a simple Message interface.
export interface Message {
  role: 'user' | 'system' | string;
  content: string;
}

// The full payload interface.
export interface PayloadData {
  messages: Message[];
  temperature: number;
  top_p: number;
  max_tokens: number;
  stop: string | null;
  stream: boolean;
  frequency_penalty: number;
  presence_penalty: number;
  data_sources: DataSource[];
}

// Data source interface including its parameters.
export interface DataSource {
  type: string;
  parameters: DataSourceParameters;
}

export interface DataSourceParameters {
  endpoint: string;
  index_name: string;
  strictness: number;
  top_n_documents: number;
  in_scope: boolean;
  semantic_configuration: string;
  query_type: string;
  embedding_dependency: EmbeddingDependency;
  fields_mapping: Record<string, unknown>; // can be typed more specifically if needed
  authentication: Authentication;
}

export interface EmbeddingDependency {
  type: string;
  deployment_name: string;
}

export interface Authentication {
  type: string;
  key: string;
}

// Options for updating the payload.
export interface UpdatePayloadOptions {
  messages?: Message[];
  top_n_documents?: number;
  strictness?: number;
  stream: boolean;
}

/**
 * Updates the given payload according to the options provided.
 *
 * @param payload - The original payload data.
 * @param options - The options to update:
 *   - messages: New array of messages.
 *   - top_n_documents: New number to override in each data source's parameters.
 *   - strictness: New strictness value to override in each data source's parameters.
 * @returns A new PayloadData object with the updated values.
 */
export function updatePayload(
  payload: PayloadData,
  options: UpdatePayloadOptions
): PayloadData {
  // Create a shallow copy of the payload.
  const updatedPayload: PayloadData = { ...payload };

  // Override the messages array if provided.
  if (options.messages) {
    updatedPayload.messages = options.messages;
  }

  if (options.stream !== undefined) {
    updatedPayload.stream = options.stream;
  }

  // Update the parameters in each data source.
  updatedPayload.data_sources = updatedPayload.data_sources.map((ds) => {
    return {
      ...ds,
      parameters: {
        ...ds.parameters,
        // Only update if the options are provided; otherwise, keep the existing value.
        top_n_documents:
          options.top_n_documents !== undefined
            ? options.top_n_documents
            : ds.parameters.top_n_documents,
        strictness:
          options.strictness !== undefined
            ? options.strictness
            : ds.parameters.strictness
       
      }
    };
  });

  return updatedPayload;
}
