# Cloud Scan Inputs

Place immutable Azure scan exports here. Prefer structured JSON with collection metadata:

```json
{
  "collectedAt": "2026-01-01T00:00:00Z",
  "collectionMethod": "approved-tool-and-version",
  "scope": "/subscriptions/example",
  "data": {}
}
```

Redact secrets before import. A scan result is evidence of observed state at its collection time, not proof of continuous compliance.