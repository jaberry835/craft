import {
    Message,
    PayloadData,
    updatePayload,
    UpdatePayloadOptions
  } from './payload-helper';
  import { Injectable } from '@angular/core';
  import { environment } from 'src/environments/environment';
  
  // Original payload
  const originalPayload: PayloadData = {
    "messages": [
      {
        "role": "user",
        "content": "tell me about some news from the dataset provided"
      }
    ],
    "temperature": 0.7,
    "top_p": 0.95,
    "max_tokens": 800,
    "stop": null,
    "stream": true,
    "frequency_penalty": 0,
    "presence_penalty": 0,
    "data_sources": [
      {
        "type": "azure_search",
        "parameters": {
          "endpoint": environment.azureSearchEndpoint,
          "index_name": "runtestidx",
          "strictness": 3,
          "top_n_documents": 5,
          "in_scope": false,
          "semantic_configuration": "default",
          "query_type": "vector_semantic_hybrid",
          "embedding_dependency": {
            "type": "deployment_name",
            "deployment_name": "text-embedding-ada-002"
          },
          "fields_mapping": {},
          "authentication": {
            "type": "api_key",
            "key": environment.azureSearchKey
          }
        }
      }
    ]
  }
  
  // Define new messages and update parameters.
  const newMessages: Message[] = [
    { role: "user", content: "what's the weather today?" },
    { role: "system", content: "Here's the forecast for you." }
  ];
  
  const options: UpdatePayloadOptions = {
    messages: newMessages,
    top_n_documents: 3, // Change the top document count.
    strictness: 2,
    stream: false      // Change the strictness threshold.
  };
  
  const updatedPayload = updatePayload(originalPayload, options);
  
  console.log("Updated Payload:", updatedPayload);
  