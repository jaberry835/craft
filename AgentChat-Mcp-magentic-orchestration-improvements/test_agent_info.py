import requests
import json

# Test the DocumentAgent directly
payload = {
    'jsonrpc': '2.0',
    'id': '1',
    'method': 'send_message',
    'params': {'task': 'list all documents'}
}

headers = {
    'X-Session-ID': 'test-session-123',
    'X-User-ID': 'test-user-456',
    'Content-Type': 'application/json'
}

try:
    response = requests.post('http://localhost:18081/a2a/message', 
                           json=payload, 
                           headers=headers,
                           timeout=30)
    print('Status:', response.status_code)
    print('Response:', response.json())
except Exception as e:
    print('Error:', e)