"""Document management API routes."""

import os
import io
import asyncio
import threading
import time
import base64
import json
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, send_file, make_response
from werkzeug.utils import secure_filename
from werkzeug.datastructures import FileStorage
from urllib.parse import quote

try:
    from ..services.document_service import document_service
    from ..utils.logging import get_logger
except ImportError:
    from src.services.document_service import document_service
    from src.utils.logging import get_logger

logger = get_logger(__name__)

def run_async_in_thread(coro):
    """Run an async coroutine in the current thread's event loop."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            # If we're already in an event loop, use asyncio.create_task
            return asyncio.create_task(coro)
        else:
            return loop.run_until_complete(coro)
    except RuntimeError:
        # No event loop exists, create a new one
        return asyncio.run(coro)

# Create blueprint
document_bp = Blueprint('document', __name__, url_prefix='/api/document')


@document_bp.route('/upload', methods=['POST', 'OPTIONS'])
def upload_document():
    """Upload a document for processing and RAG"""
    if request.method == 'OPTIONS':
        # Handle CORS preflight request
        response = make_response()
        response.headers.add("Access-Control-Allow-Origin", "*")
        response.headers.add('Access-Control-Allow-Headers', "*")
        response.headers.add('Access-Control-Allow-Methods', "*")
        return response
        
    try:
        # Check if file is present
        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400
            
        file = request.files['file']
        if file.filename == '':
            return jsonify({'error': 'No file selected'}), 400
            
        # Get form data
        user_id = request.form.get('userId') or request.headers.get('x-user-token')
        session_id = request.form.get('sessionId')
        
        if not user_id:
            return jsonify({'error': 'User ID is required'}), 400
            
        if not session_id:
            return jsonify({'error': 'Session ID is required'}), 400
            
        logger.info(f"Upload request - File: {file.filename}, UserId: {user_id}, SessionId: {session_id}")
        
        # Validate file type
        allowed_extensions = {'.pdf', '.doc', '.docx', '.txt', '.md'}
        file_ext = os.path.splitext(file.filename)[1].lower()
        
        if file_ext not in allowed_extensions:
            return jsonify({'error': f'File type {file_ext} not supported. Allowed types: {", ".join(allowed_extensions)}'}), 400
            
        # Validate file size (max 10MB)
        max_file_size = 10 * 1024 * 1024
        file.seek(0, os.SEEK_END)
        file_size = file.tell()
        file.seek(0)
        
        if file_size > max_file_size:
            return jsonify({'error': 'File size exceeds 10MB limit'}), 400
        
        # Upload using Azure Document Service
        result = run_async_in_thread(
            document_service.upload_document(file.stream, file.filename, user_id, session_id)
        )
        
        if not result["success"]:
            return jsonify({'error': result["error"]}), 500
            
        document_id = result["document_id"]
        
        logger.info(f"Document uploaded successfully - DocumentId: {document_id}")
        
        # Start async processing with delay for Cosmos DB consistency
        def process_document_background():
            try:
                # Add delay for Cosmos DB consistency
                time.sleep(2)
                result = run_async_in_thread(
                    document_service.process_document(document_id)
                )
                if result["success"]:
                    logger.info(f"Document processed successfully: {document_id}, Chunks: {result.get('chunk_count', 0)}")
                else:
                    logger.error(f"Document processing failed: {document_id}, Error: {result.get('error', 'Unknown error')}")
            except Exception as e:
                logger.error(f"Error in background document processing: {e}")
        
        # Start background processing
        processing_thread = threading.Thread(target=process_document_background)
        processing_thread.daemon = True
        processing_thread.start()
        
        return jsonify({
            'documentId': document_id,
            'fileName': file.filename,
            'status': 'uploaded'
        })
        
    except Exception as e:
        logger.error(f"Error uploading document: {e}")
        return jsonify({'error': str(e)}), 500


@document_bp.route('', methods=['GET'],strict_slashes=False, defaults={'document_id': None})
@document_bp.route('/', methods=['GET'],strict_slashes=False, defaults={'document_id': None})
def get_documents(document_id):
    """Get documents for a session"""
    try:
        user_id = request.args.get('userId') or request.headers.get('x-user-token')
        session_id = request.args.get('sessionId')
        
        if not user_id:
            return jsonify({'error': 'User ID is required'}), 400
        
        # Get documents using Azure Document Service
        result = run_async_in_thread(
            document_service.get_user_documents(user_id, session_id)
        )
        
        # Check if we got a successful response
        if not result.get("success", False):
            logger.warning(f"Error getting documents: {result.get('error', 'Unknown error')}")
            return jsonify({'error': result.get('message', 'Error retrieving documents')}), 500
            
        # Get the documents list from the response
        documents = result.get("documents", [])
        
        # Documents are already dictionaries, so we can return them directly
        return jsonify(documents)
        
    except Exception as e:
        logger.error(f"Error getting documents: {e}", exc_info=True)
        return jsonify({'error': f"Error retrieving documents: {str(e)}"}), 500


@document_bp.route('/<document_id>/download', methods=['GET'])
def download_document(document_id):
    """Download a document"""
    try:
        user_id = request.args.get('userId') or request.headers.get('x-user-token')
        
        if not user_id:
            return jsonify({'error': 'User ID is required'}), 400
        
        if not document_id:
            return jsonify({'error': 'Document ID is required'}), 400
        
        # Download using Azure Document Service
        result = run_async_in_thread(
            document_service.download_document(document_id, user_id)
        )
        
        # Check for success
        if not isinstance(result, dict) or not result.get("success", False):
            error_msg = "Document not found or access denied"
            if isinstance(result, dict):
                error_msg = result.get("message", error_msg)
            logger.warning(f"Error downloading document: {error_msg}")
            return jsonify({'error': error_msg}), 404
        
        # Get content from base64
        content_b64 = result.get("content")
        if not content_b64:
            return jsonify({'error': 'No content in document'}), 404
            
        content = base64.b64decode(content_b64)
        file_name = result.get("file_name", "document")
        content_type = result.get("content_type", "application/octet-stream")
        
        # Return file content
        file_stream = io.BytesIO(content)
        file_stream.seek(0)
        
        # Properly encode filename for HTTP header
        safe_filename = quote(file_name.encode('utf-8'), safe='')
        
        response = send_file(
            file_stream,
            as_attachment=True,
            download_name=file_name,
            mimetype=content_type
        )
        
        # Set proper Content-Disposition header for filenames with special characters
        response.headers['Content-Disposition'] = f'attachment; filename="{file_name}"; filename*=UTF-8\'\'{safe_filename}'
        
        return response
        
    except ValueError as e:
        logger.warning(f"Document not found or access denied: {document_id}")
        return jsonify({'error': 'Document not found or access denied'}), 404
    except Exception as e:
        logger.error(f"Error downloading document: {document_id}, Error: {e}")
        return jsonify({'error': str(e)}), 500


@document_bp.route('/search', methods=['POST'])
def search_documents():
    """Search documents for RAG functionality"""
    try:
        data = request.get_json()
        query = data.get('query', '')
        user_id = data.get('userId') or request.headers.get('x-user-token')
        
        logger.info(f"Document search request: '{query}' for user: {user_id}")
        
        if not user_id:
            return jsonify({'error': 'User ID is required'}), 400
        
        if not query:
            return jsonify({'error': 'Query is required'}), 400
        
        # Search documents using Azure Document Service
        session_id = data.get('sessionId')
        max_results = data.get('maxResults', 5)
        
        search_result = run_async_in_thread(
            document_service.search_documents(query, user_id, session_id, max_results)
        )
        
        # Check if search was successful
        if not search_result.get("success", False):
            logger.warning(f"Search failed: {search_result.get('error', 'Unknown error')}")
            return jsonify({'error': search_result.get('message', 'Search failed')}), 500
            
        # Get chunks from the results
        chunks = search_result.get("results", [])
        
        # Convert to response format matching C# API
        results = []
        for chunk in chunks:
            # Check if chunk is a dictionary (it should be now)
            if isinstance(chunk, dict):
                results.append({
                    'chunkId': chunk.get('chunkId', ''),
                    'documentId': chunk.get('documentId', ''),
                    'content': chunk.get('content', ''),
                    'score': chunk.get('score', 0.0),
                    'chunkIndex': chunk.get('chunkIndex', 0),
                    'fileName': chunk.get('fileName', '')
                })
            elif hasattr(chunk, 'chunk_id'):  # Handle DocumentChunk objects
                results.append({
                    'chunkId': chunk.chunk_id,
                    'documentId': chunk.document_id,
                    'content': chunk.content,
                    'score': chunk.score,
                    'chunkIndex': chunk.chunk_index,
                    'fileName': chunk.file_name if hasattr(chunk, 'file_name') else ''
                })
            else:
                logger.warning(f"Unexpected chunk type: {type(chunk)}")
        
        return jsonify({
            'query': query,
            'results': results
        })
        
    except Exception as e:
        logger.error(f"Error in document search: {e}", exc_info=True)
        return jsonify({'error': f"Search error: {str(e)}"}), 500


@document_bp.route('/<document_id>', methods=['DELETE'])
def delete_document(document_id):
    """Delete a document"""
    try:
        user_id = request.args.get('userId') or request.headers.get('x-user-token')
        
        if not user_id:
            return jsonify({'error': 'User ID is required'}), 400
        
        if not document_id:
            return jsonify({'error': 'Document ID is required'}), 400
        
        # Delete using Azure Document Service - not implemented yet
        # For now, return a not implemented message
        return jsonify({
            'success': False,
            'error': 'Delete functionality not implemented',
            'message': 'Document deletion is not currently supported'
        }), 501
        
        return jsonify({
            'success': True,
            'message': f'Document {document_id} deleted successfully'
        })
        
    except Exception as e:
        logger.error(f"Error deleting document {document_id}: {e}")
        return jsonify({'error': str(e)}), 500
