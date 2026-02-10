"""Main image processing pipeline for indexing."""

import asyncio
import hashlib
import os
from pathlib import Path
from datetime import datetime
import structlog
import aiofiles
from PIL import Image
import io

from .config import Settings, get_settings
from .models import ImageDocument
from .analyzers import ComputerVisionAnalyzer, DocumentIntelligenceAnalyzer, FaceAnalyzer
from .embeddings import TextEmbeddingGenerator, ImageEmbeddingGenerator
from .search import SearchIndexManager
from .storage import BlobStorageClient

logger = structlog.get_logger()

# Supported image extensions
SUPPORTED_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff'}


class ImageIndexer:
    """Main pipeline for analyzing and indexing images."""
    
    def __init__(self, settings: Settings | None = None):
        """Initialize the indexer with all components."""
        self.settings = settings or get_settings()
        
        # Initialize analyzers
        self.cv_analyzer = ComputerVisionAnalyzer(self.settings)
        self.doc_analyzer = DocumentIntelligenceAnalyzer(self.settings)
        self.face_analyzer = FaceAnalyzer(self.settings)
        
        # Initialize embedding generators
        self.text_embedder = TextEmbeddingGenerator(self.settings)
        self.image_embedder = ImageEmbeddingGenerator(self.settings)
        
        # Initialize search index manager
        self.search_manager = SearchIndexManager(self.settings)
        
        self.logger = logger.bind(component="image_indexer")
    
    def _generate_document_id(self, file_path: str) -> str:
        """Generate a unique document ID from file path."""
        return hashlib.md5(file_path.encode()).hexdigest()
    
    def _get_content_type(self, file_path: str) -> str:
        """Get MIME type from file extension."""
        ext = Path(file_path).suffix.lower()
        mime_types = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.bmp': 'image/bmp',
            '.webp': 'image/webp',
            '.tiff': 'image/tiff'
        }
        return mime_types.get(ext, 'application/octet-stream')
    
    async def _read_image(self, file_path: str) -> bytes:
        """Read image file asynchronously."""
        async with aiofiles.open(file_path, 'rb') as f:
            return await f.read()
    
    async def process_image(self, file_path: str, file_url: str | None = None) -> ImageDocument:
        """
        Process a single image through the full analysis pipeline.
        
        Args:
            file_path: Path to the image file
            file_url: Optional URL where the image is hosted
            
        Returns:
            Fully populated ImageDocument
        """
        self.logger.info("Processing image", file_path=file_path)
        
        # Read image
        image_data = await self._read_image(file_path)
        file_stat = os.stat(file_path)
        
        # Get image dimensions
        img = Image.open(io.BytesIO(image_data))
        width, height = img.size
        
        # Run analysis tasks in parallel
        cv_task = self.cv_analyzer.analyze_image(image_data)
        doc_task = self.doc_analyzer.extract_text(image_data)
        face_task = self.face_analyzer.detect_faces(image_data)
        image_embed_task = self.image_embedder.generate_embedding(image_data)
        
        # Wait for all analysis tasks
        cv_result, doc_result, face_result, image_vector = await asyncio.gather(
            cv_task, doc_task, face_task, image_embed_task,
            return_exceptions=True
        )
        
        # Handle exceptions
        if isinstance(cv_result, Exception):
            self.logger.error("CV analysis failed", error=str(cv_result))
            cv_result = None
        if isinstance(doc_result, Exception):
            self.logger.error("Document analysis failed", error=str(doc_result))
            doc_result = None
        if isinstance(face_result, Exception):
            self.logger.error("Face analysis failed", error=str(face_result))
            face_result = None
        if isinstance(image_vector, Exception):
            self.logger.error("Image embedding failed", error=str(image_vector))
            image_vector = None
        
        # Extract values from results
        caption = cv_result.caption if cv_result else None
        caption_confidence = cv_result.caption_confidence if cv_result else None
        dense_captions = cv_result.dense_captions if cv_result else []
        tags = cv_result.tags if cv_result else []
        objects = [obj.name for obj in cv_result.objects] if cv_result else []
        
        extracted_text = doc_result.extracted_text if doc_result else None
        has_text = bool(extracted_text and extracted_text.strip())
        
        face_count = face_result.face_count if face_result else 0
        has_faces = face_count > 0
        face_details = []
        if face_result and face_result.faces:
            face_details = [
                {
                    "face_id": f.face_id,
                    "persisted_face_id": f.persisted_face_id,
                    "person_id": f.person_id,
                    "person_name": f.person_name,
                    "confidence": f.confidence,
                    "age": f.age,
                    "emotion": f.emotion,
                    "bounding_box": {
                        "x": f.bounding_box.x,
                        "y": f.bounding_box.y,
                        "width": f.bounding_box.width,
                        "height": f.bounding_box.height
                    } if f.bounding_box else None
                }
                for f in face_result.faces
            ]
        
        # Build rich description for text embedding
        rich_description = self.text_embedder.build_rich_description(
            caption=caption,
            dense_captions=dense_captions,
            tags=tags,
            objects=objects,
            extracted_text=extracted_text,
            face_count=face_count
        )
        
        # Generate text embedding
        description_vector = await self.text_embedder.generate_embedding(rich_description)
        
        # Extract unique person IDs for searchability
        person_ids = list(set(
            fd["person_id"] for fd in face_details 
            if fd.get("person_id")
        ))
        
        # Extract unique persisted face IDs for searchability
        persisted_face_ids = list(set(
            fd["persisted_face_id"] for fd in face_details 
            if fd.get("persisted_face_id")
        ))
        
        # Create document
        document = ImageDocument(
            id=self._generate_document_id(file_path),
            filename=Path(file_path).name,
            file_path=file_path,
            file_url=file_url,
            file_size=file_stat.st_size,
            content_type=self._get_content_type(file_path),
            caption=caption,
            caption_confidence=caption_confidence,
            dense_captions=dense_captions,
            tags=tags,
            objects=objects,
            extracted_text=extracted_text,
            has_text=has_text,
            face_count=face_count,
            has_faces=has_faces,
            face_details=face_details,
            person_ids=person_ids,
            persisted_face_ids=persisted_face_ids,
            rich_description=rich_description,
            description_vector=description_vector,
            image_vector=image_vector,
            indexed_at=datetime.utcnow(),
            width=width,
            height=height
        )
        
        self.logger.info(
            "Image processed",
            filename=document.filename,
            has_caption=bool(caption),
            tag_count=len(tags),
            has_text=has_text,
            face_count=face_count
        )
        
        return document
    
    async def index_directory(
        self,
        directory_path: str,
        recursive: bool = True,
        base_url: str | None = None
    ) -> dict:
        """
        Index all images in a directory.
        
        Args:
            directory_path: Path to the directory
            recursive: Whether to process subdirectories
            base_url: Base URL for constructing file URLs
            
        Returns:
            Summary of indexing results
        """
        self.logger.info("Indexing directory", path=directory_path, recursive=recursive)
        
        # Ensure index exists
        await self.search_manager.create_or_update_index()
        
        # Find all image files
        image_files = []
        path = Path(directory_path)
        
        if recursive:
            for ext in SUPPORTED_EXTENSIONS:
                image_files.extend(path.rglob(f"*{ext}"))
        else:
            for ext in SUPPORTED_EXTENSIONS:
                image_files.extend(path.glob(f"*{ext}"))
        
        self.logger.info("Found images to index", count=len(image_files))
        
        # Process in batches
        results = {"processed": 0, "uploaded": 0, "failed": 0, "errors": []}
        batch = []
        
        for image_path in image_files:
            try:
                file_url = None
                if base_url:
                    relative_path = image_path.relative_to(path)
                    file_url = f"{base_url.rstrip('/')}/{relative_path}"
                
                document = await self.process_image(str(image_path), file_url)
                batch.append(document)
                results["processed"] += 1
                
                # Upload batch when full
                if len(batch) >= self.settings.batch_size:
                    upload_result = await self.search_manager.upload_documents(batch)
                    results["uploaded"] += upload_result["uploaded"]
                    results["failed"] += upload_result["failed"]
                    batch = []
                    
            except Exception as e:
                self.logger.error("Failed to process image", path=str(image_path), error=str(e))
                results["failed"] += 1
                results["errors"].append({"path": str(image_path), "error": str(e)})
        
        # Upload remaining batch
        if batch:
            upload_result = await self.search_manager.upload_documents(batch)
            results["uploaded"] += upload_result["uploaded"]
            results["failed"] += upload_result["failed"]
        
        self.logger.info(
            "Directory indexing complete",
            processed=results["processed"],
            uploaded=results["uploaded"],
            failed=results["failed"]
        )
        
        return results
    
    async def index_blob_container(
        self,
        container_name: str | None = None,
        prefix: str | None = None,
        max_images: int | None = None
    ) -> dict:
        """
        Index all images from an Azure Blob Storage container.
        
        Args:
            container_name: Container name (uses AZURE_STORAGE_CONTAINER if not provided)
            prefix: Optional path prefix to filter blobs
            max_images: Maximum number of images to process (None for all)
            
        Returns:
            Summary of indexing results
        """
        container = container_name or self.settings.azure_storage_container
        self.logger.info("Indexing blob container", container=container, prefix=prefix, max_images=max_images)
        
        # Ensure index exists
        await self.search_manager.create_or_update_index()
        
        # Initialize blob client
        async with BlobStorageClient(self.settings) as blob_client:
            # List all image blobs
            blobs = await blob_client.list_blobs(
                container_name=container,
                prefix=prefix,
                extensions=SUPPORTED_EXTENSIONS
            )
            
            # Apply limit if specified
            if max_images is not None:
                blobs = blobs[:max_images]
            
            self.logger.info("Found images to index", count=len(blobs))
            
            # Process in batches
            results = {"processed": 0, "uploaded": 0, "failed": 0, "errors": []}
            batch = []
            
            for blob_info in blobs:
                try:
                    # Download blob content
                    image_data = await blob_client.download_blob(
                        blob_info["name"],
                        container_name=container
                    )
                    
                    # Process the image
                    document = await self.process_image_data(
                        image_data=image_data,
                        blob_name=blob_info["name"],
                        blob_url=blob_info["url"],
                        container_name=container
                    )
                    batch.append(document)
                    results["processed"] += 1
                    
                    # Upload batch when full
                    if len(batch) >= self.settings.batch_size:
                        upload_result = await self.search_manager.upload_documents(batch)
                        results["uploaded"] += upload_result["uploaded"]
                        results["failed"] += upload_result["failed"]
                        batch = []
                        
                except Exception as e:
                    self.logger.error("Failed to process blob", blob=blob_info["name"], error=str(e))
                    results["failed"] += 1
                    results["errors"].append({"path": blob_info["name"], "error": str(e)})
            
            # Upload remaining batch
            if batch:
                upload_result = await self.search_manager.upload_documents(batch)
                results["uploaded"] += upload_result["uploaded"]
                results["failed"] += upload_result["failed"]
        
        self.logger.info(
            "Blob container indexing complete",
            processed=results["processed"],
            uploaded=results["uploaded"],
            failed=results["failed"]
        )
        
        return results
    
    async def process_image_data(
        self,
        image_data: bytes,
        blob_name: str,
        blob_url: str,
        container_name: str
    ) -> ImageDocument:
        """
        Process image data from blob storage through the full analysis pipeline.
        
        Args:
            image_data: Raw image bytes
            blob_name: Name/path of the blob
            blob_url: Full URL to the blob
            container_name: Container name
            
        Returns:
            Fully populated ImageDocument
        """
        self.logger.info("Processing blob image", blob_name=blob_name)
        
        # Get image dimensions
        img = Image.open(io.BytesIO(image_data))
        width, height = img.size
        
        # Step 1: Run Computer Vision first to determine if we need OCR
        cv_result = None
        try:
            cv_result = await self.cv_analyzer.analyze_image(image_data)
        except Exception as e:
            self.logger.error("CV analysis failed", error=str(e))
        
        # Extract CV values
        caption = cv_result.caption if cv_result else None
        caption_confidence = cv_result.caption_confidence if cv_result else None
        dense_captions = cv_result.dense_captions if cv_result else []
        tags = cv_result.tags if cv_result else []
        objects = [obj.name for obj in cv_result.objects] if cv_result else []
        
        # Step 2: Check if image likely contains text (based on CV tags/objects)
        text_indicators = {'text', 'document', 'letter', 'receipt', 'sign', 'menu', 
                          'poster', 'book', 'newspaper', 'magazine', 'paper', 'note',
                          'handwriting', 'screenshot', 'whiteboard', 'blackboard'}
        tags_lower = {t.lower() for t in tags}
        objects_lower = {o.lower() for o in objects}
        
        likely_has_text = bool(text_indicators & (tags_lower | objects_lower))
        
        # Step 3: Check if image likely contains faces (based on CV tags/objects)
        face_indicators = {'person', 'people', 'face', 'man', 'woman', 'boy', 'girl',
                          'child', 'adult', 'human', 'portrait', 'selfie', 'crowd'}
        likely_has_faces = bool(face_indicators & (tags_lower | objects_lower))
        
        # Step 4: Only run Document Intelligence if likely has text
        doc_result = None
        if likely_has_text:
            self.logger.info("Text indicators detected, running Document Intelligence", 
                          indicators=list(text_indicators & (tags_lower | objects_lower)))
            try:
                doc_result = await self.doc_analyzer.extract_text(image_data)
            except Exception as e:
                self.logger.error("Document analysis failed", error=str(e))
        else:
            self.logger.debug("No text indicators, skipping Document Intelligence")
        
        # Step 5: Run Face API if likely has faces OR if force-enabled in settings
        face_result = None
        should_run_face_api = likely_has_faces or self.settings.enable_face_detection
        if should_run_face_api:
            if likely_has_faces:
                self.logger.info("Face indicators detected, running Face API",
                              indicators=list(face_indicators & (tags_lower | objects_lower)))
            else:
                self.logger.info("Face detection enabled in settings, running Face API")
            try:
                # Use persistent face detection if enabled (two-pass approach)
                if self.settings.use_persistent_faces:
                    doc_id = self._generate_document_id(blob_url)
                    face_result = await self.face_analyzer.detect_and_persist(image_data, doc_id)
                else:
                    face_result = await self.face_analyzer.detect_faces(image_data)
            except Exception as e:
                self.logger.error("Face analysis failed", error=str(e))
        else:
            self.logger.debug("No face indicators and face detection disabled, skipping Face API")
        
        # Step 6: Run image embedding (if enabled)
        image_vector = None
        try:
            image_vector = await self.image_embedder.generate_embedding(image_data)
        except Exception as e:
            self.logger.error("Image embedding failed", error=str(e))
        
        extracted_text = doc_result.extracted_text if doc_result else None
        has_text = bool(extracted_text and extracted_text.strip())
        
        face_count = face_result.face_count if face_result else 0
        has_faces = face_count > 0
        face_details = []
        if face_result and face_result.faces:
            face_details = [
                {
                    "face_id": f.face_id,
                    "persisted_face_id": f.persisted_face_id,
                    "person_id": f.person_id,
                    "person_name": f.person_name,
                    "confidence": f.confidence,
                    "age": f.age,
                    "emotion": f.emotion,
                    "bounding_box": {
                        "x": f.bounding_box.x,
                        "y": f.bounding_box.y,
                        "width": f.bounding_box.width,
                        "height": f.bounding_box.height
                    } if f.bounding_box else None
                }
                for f in face_result.faces
            ]
        
        # Build rich description for text embedding
        rich_description = self.text_embedder.build_rich_description(
            caption=caption,
            dense_captions=dense_captions,
            tags=tags,
            objects=objects,
            extracted_text=extracted_text,
            face_count=face_count
        )
        
        # Generate text embedding
        description_vector = await self.text_embedder.generate_embedding(rich_description)
        
        # Extract unique person IDs for searchability
        person_ids = list(set(
            fd["person_id"] for fd in face_details 
            if fd.get("person_id")
        ))
        
        # Extract unique persisted face IDs for searchability
        persisted_face_ids = list(set(
            fd["persisted_face_id"] for fd in face_details 
            if fd.get("persisted_face_id")
        ))
        
        # Create document - use blob URL as the unique identifier basis
        document = ImageDocument(
            id=self._generate_document_id(blob_url),
            filename=blob_name.rsplit('/', 1)[-1],  # Get just the filename
            file_path=f"{container_name}/{blob_name}",
            file_url=blob_url,
            file_size=len(image_data),
            content_type=self._get_content_type(blob_name),
            caption=caption,
            caption_confidence=caption_confidence,
            dense_captions=dense_captions,
            tags=tags,
            objects=objects,
            extracted_text=extracted_text,
            has_text=has_text,
            face_count=face_count,
            has_faces=has_faces,
            face_details=face_details,
            person_ids=person_ids,
            persisted_face_ids=persisted_face_ids,
            rich_description=rich_description,
            description_vector=description_vector,
            image_vector=image_vector,
            indexed_at=datetime.utcnow(),
            width=width,
            height=height,
            metadata={"container": container_name, "blob_name": blob_name}
        )
        
        self.logger.info(
            "Blob image processed",
            filename=document.filename,
            has_caption=bool(caption),
            tag_count=len(tags),
            has_text=has_text,
            face_count=face_count
        )
        
        return document

    async def finalize_faces(self, container_name: str | None = None) -> dict:
        """
        PASS 2: Cluster faces and assign persons.
        
        This should be run after all images have been indexed with detect_and_persist.
        It clusters similar faces and creates Person identities, then updates
        all indexed documents with the person_id mappings.
        
        Returns:
            Summary of clustering results
        """
        container = container_name or self.settings.azure_storage_container
        self.logger.info("Finalizing faces - Pass 2 clustering", container=container)
        
        # Get clustering stats first
        stats = await self.face_analyzer.get_clustering_stats()
        self.logger.info("Face storage stats", 
                        faces_in_list=stats["faces_in_list"],
                        persons_in_group=stats["persons_in_group"])
        
        if stats["faces_in_list"] == 0:
            self.logger.warning("No faces in FaceList to cluster")
            return {"clusters": 0, "faces_assigned": 0, "documents_updated": 0}
        
        # Create function to fetch image data by document ID
        async def get_image_by_doc_id(doc_id: str) -> bytes | None:
            """Fetch image data from search index and blob storage."""
            try:
                # Search for the document to get its blob path
                async with BlobStorageClient(self.settings) as blob_client:
                    # We need to find the document by ID
                    # Search index stores file_path as "container/blob_name"
                    from azure.search.documents.aio import SearchClient
                    from azure.core.credentials import AzureKeyCredential
                    from azure.identity.aio import DefaultAzureCredential
                    
                    if self.settings.azure_search_key:
                        credential = AzureKeyCredential(self.settings.azure_search_key)
                    else:
                        credential = DefaultAzureCredential()
                    
                    async with SearchClient(
                        endpoint=self.settings.azure_search_endpoint,
                        index_name=self.settings.azure_search_index_name,
                        credential=credential
                    ) as search_client:
                        doc = await search_client.get_document(key=doc_id)
                        file_path = doc.get("file_path", "")
                        
                        # Parse container and blob name
                        if "/" in file_path:
                            parts = file_path.split("/", 1)
                            blob_container = parts[0]
                            blob_name = parts[1]
                        else:
                            blob_container = container
                            blob_name = file_path
                        
                        # Download the image
                        return await blob_client.download_blob(blob_name, blob_container)
            except Exception as e:
                self.logger.error("Failed to fetch image for clustering", doc_id=doc_id, error=str(e))
                return None
        
        # Step 1: Cluster faces using FindSimilar
        self.logger.info("Clustering faces...")
        clusters = await self.face_analyzer.cluster_faces_with_redetection(
            get_image_func=get_image_by_doc_id,
            similarity_threshold=0.5
        )
        
        if not clusters:
            self.logger.warning("No clusters formed")
            return {"clusters": 0, "faces_assigned": 0, "documents_updated": 0}
        
        # Step 2: Create Persons for each cluster
        self.logger.info("Assigning persons to clusters...", cluster_count=len(clusters))
        face_to_person = await self.face_analyzer.assign_persons_from_clusters(clusters)
        
        # Step 3: Update indexed documents with person_ids
        self.logger.info("Updating indexed documents with person IDs...")
        
        # Build mapping: doc_id -> { person_ids: set, face_person_map: {persisted_face_id: person_id} }
        doc_updates: dict[str, dict] = {}
        for cluster_faces in clusters.values():
            for persisted_face_id, doc_id in cluster_faces:
                person_id = face_to_person.get(persisted_face_id)
                if person_id:
                    if doc_id not in doc_updates:
                        doc_updates[doc_id] = {"person_ids": set(), "face_person_map": {}}
                    doc_updates[doc_id]["person_ids"].add(person_id)
                    doc_updates[doc_id]["face_person_map"][persisted_face_id] = person_id
        
        # Update documents in search index
        updated_count = 0
        from azure.search.documents.aio import SearchClient
        from azure.core.credentials import AzureKeyCredential
        from azure.identity.aio import DefaultAzureCredential
        import json
        
        if self.settings.azure_search_key:
            credential = AzureKeyCredential(self.settings.azure_search_key)
        else:
            credential = DefaultAzureCredential()
        
        async with SearchClient(
            endpoint=self.settings.azure_search_endpoint,
            index_name=self.settings.azure_search_index_name,
            credential=credential
        ) as search_client:
            for doc_id, update_info in doc_updates.items():
                try:
                    # Fetch current document to get face_details
                    doc = await search_client.get_document(key=doc_id)
                    current_face_details = doc.get("face_details", [])
                    
                    # Update each face's person_id in face_details
                    updated_face_details = []
                    face_person_map = update_info["face_person_map"]
                    
                    for face_json in current_face_details:
                        try:
                            face_data = json.loads(face_json) if isinstance(face_json, str) else face_json
                            face_id = face_data.get("persisted_face_id")
                            if face_id and face_id in face_person_map:
                                face_data["person_id"] = face_person_map[face_id]
                            updated_face_details.append(json.dumps(face_data))
                        except (json.JSONDecodeError, TypeError):
                            updated_face_details.append(face_json)
                    
                    # Merge update - update both person_ids and face_details
                    await search_client.merge_documents([{
                        "id": doc_id,
                        "person_ids": list(update_info["person_ids"]),
                        "face_details": updated_face_details
                    }])
                    updated_count += 1
                    self.logger.debug("Updated document with person IDs", doc_id=doc_id, 
                                      person_count=len(update_info["person_ids"]))
                except Exception as e:
                    self.logger.error("Failed to update document", doc_id=doc_id, error=str(e))
        
        results = {
            "clusters": len(clusters),
            "faces_assigned": len(face_to_person),
            "documents_updated": updated_count
        }
        
        self.logger.info("Face finalization complete", **results)
        return results


def main():
    """Main entry point for CLI usage."""
    import typer
    from rich.console import Console
    from rich.progress import Progress
    from enum import Enum
    
    app = typer.Typer(help="Azure Snap Seek Image Indexer - Index images to Azure AI Search")
    console = Console()
    
    def run_async(coro):
        """Helper to run async code from sync context."""
        return asyncio.run(coro)
    
    class IndexMode(str, Enum):
        """Index creation mode."""
        create_if_missing = "create-if-missing"  # Default: create only if doesn't exist
        update = "update"                         # Create or update schema
        recreate = "recreate"                     # Delete and recreate (clears all data)
        clear = "clear"                           # Clear documents but keep index
    
    @app.command()
    def index(
        source: str = typer.Argument(..., help="Directory containing images to index"),
        recursive: bool = typer.Option(True, help="Process subdirectories"),
        base_url: str = typer.Option(None, help="Base URL for image files"),
        index_mode: IndexMode = typer.Option(
            IndexMode.create_if_missing,
            "--index-mode", "-m",
            help="How to handle existing index"
        )
    ):
        """Index images from a directory into Azure AI Search."""
        console.print(f"[bold blue]Starting image indexing from: {source}[/bold blue]")
        console.print(f"[dim]Index mode: {index_mode.value}[/dim]")
        
        async def run_indexing():
            indexer = ImageIndexer()
            
            # Handle index based on mode
            if index_mode == IndexMode.recreate:
                console.print("[yellow]Recreating index (all existing data will be deleted)...[/yellow]")
                await indexer.search_manager.recreate_index()
            elif index_mode == IndexMode.clear:
                console.print("[yellow]Clearing existing documents...[/yellow]")
                deleted = await indexer.search_manager.clear_all_documents()
                console.print(f"[dim]Deleted {deleted} documents[/dim]")
                await indexer.search_manager.create_or_update_index()
            elif index_mode == IndexMode.update:
                await indexer.search_manager.create_or_update_index()
            else:  # create_if_missing
                created = await indexer.search_manager.create_index_if_not_exists()
                if created:
                    console.print("[green]Created new search index[/green]")
                else:
                    console.print("[dim]Using existing index[/dim]")
            
            return await indexer.index_directory(source, recursive, base_url)
        
        with Progress() as progress:
            task = progress.add_task("Indexing images...", total=None)
            results = run_async(run_indexing())
            progress.update(task, completed=True)
        
        console.print(f"\n[bold green]Indexing Complete![/bold green]")
        console.print(f"  Processed: {results['processed']}")
        console.print(f"  Uploaded:  {results['uploaded']}")
        console.print(f"  Failed:    {results['failed']}")
        
        if results['errors']:
            console.print("\n[bold red]Errors:[/bold red]")
            for err in results['errors'][:10]:
                console.print(f"  {err['path']}: {err['error']}")
    
    @app.command()
    def index_blob(
        container: str = typer.Argument(None, help="Container name (uses AZURE_STORAGE_CONTAINER if not provided)"),
        prefix: str = typer.Option(None, "--prefix", "-p", help="Filter blobs by path prefix"),
        limit: int = typer.Option(None, "--limit", "-n", help="Maximum number of images to index (for testing)"),
        index_mode: IndexMode = typer.Option(
            IndexMode.create_if_missing,
            "--index-mode", "-m",
            help="How to handle existing index"
        )
    ):
        """Index images from Azure Blob Storage container."""
        async def run_indexing():
            indexer = ImageIndexer()
            container_name = container or indexer.settings.azure_storage_container
            
            console.print(f"[bold blue]Starting blob indexing from container: {container_name}[/bold blue]")
            if prefix:
                console.print(f"[dim]Prefix filter: {prefix}[/dim]")
            if limit:
                console.print(f"[dim]Limit: {limit} images[/dim]")
            console.print(f"[dim]Index mode: {index_mode.value}[/dim]")
            
            # Handle index based on mode
            if index_mode == IndexMode.recreate:
                console.print("[yellow]Recreating index (all existing data will be deleted)...[/yellow]")
                await indexer.search_manager.recreate_index()
            elif index_mode == IndexMode.clear:
                console.print("[yellow]Clearing existing documents...[/yellow]")
                deleted = await indexer.search_manager.clear_all_documents()
                console.print(f"[dim]Deleted {deleted} documents[/dim]")
                await indexer.search_manager.create_or_update_index()
            elif index_mode == IndexMode.update:
                await indexer.search_manager.create_or_update_index()
            else:  # create_if_missing
                created = await indexer.search_manager.create_index_if_not_exists()
                if created:
                    console.print("[green]Created new search index[/green]")
                else:
                    console.print("[dim]Using existing index[/dim]")
            
            return await indexer.index_blob_container(container_name, prefix, max_images=limit)
        
        with Progress() as progress:
            task = progress.add_task("Indexing blob images...", total=None)
            results = run_async(run_indexing())
            progress.update(task, completed=True)
        
        console.print(f"\n[bold green]Blob Indexing Complete![/bold green]")
        console.print(f"  Processed: {results['processed']}")
        console.print(f"  Uploaded:  {results['uploaded']}")
        console.print(f"  Failed:    {results['failed']}")
        
        if results['errors']:
            console.print("\n[bold red]Errors:[/bold red]")
            for err in results['errors'][:10]:
                console.print(f"  {err['path']}: {err['error']}")
    
    @app.command()
    def create_index(
        force: bool = typer.Option(False, "--force", "-f", help="Recreate index if it exists (deletes all data)")
    ):
        """Create the search index."""
        async def run():
            indexer = ImageIndexer()
            
            if force:
                console.print("[yellow]Force recreating index...[/yellow]")
                await indexer.search_manager.recreate_index()
                console.print("[bold green]Index recreated successfully![/bold green]")
            else:
                created = await indexer.search_manager.create_index_if_not_exists()
                if created:
                    console.print("[bold green]Index created successfully![/bold green]")
                else:
                    console.print("[yellow]Index already exists. Use --force to recreate.[/yellow]")
        
        run_async(run())
    
    @app.command()
    def delete_index(
        confirm: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation")
    ):
        """Delete the search index and all its data."""
        if not confirm:
            confirm = typer.confirm("Are you sure you want to delete the index? This cannot be undone.")
        
        if not confirm:
            console.print("[dim]Cancelled[/dim]")
            return
        
        async def run():
            indexer = ImageIndexer()
            deleted = await indexer.search_manager.delete_index()
            if deleted:
                console.print("[bold green]Index deleted successfully![/bold green]")
            else:
                console.print("[yellow]Index did not exist[/yellow]")
        
        run_async(run())
    
    @app.command()
    def clear_index(
        confirm: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation")
    ):
        """Clear all documents from the index (keeps index schema)."""
        if not confirm:
            confirm = typer.confirm("Are you sure you want to clear all documents?")
        
        if not confirm:
            console.print("[dim]Cancelled[/dim]")
            return
        
        async def run():
            indexer = ImageIndexer()
            count = await indexer.search_manager.clear_all_documents()
            console.print(f"[bold green]Cleared {count} documents from index![/bold green]")
        
        run_async(run())
    
    @app.command()
    def finalize_faces(
        container: str = typer.Option(None, "--container", "-c", help="Azure Blob container name"),
    ):
        """Run Pass 2: Cluster faces and assign person IDs.
        
        This command should be run after indexing images with face detection.
        It clusters similar faces using FindSimilar and creates Person identities,
        then updates all indexed documents with the person_id mappings.
        """
        async def run():
            indexer = ImageIndexer()
            
            console.print("[bold cyan]Starting face finalization (Pass 2)...[/bold cyan]")
            console.print()
            
            # Get initial stats
            stats = await indexer.face_analyzer.get_clustering_stats()
            console.print(f"  Faces in FaceList: {stats['faces_in_list']}")
            console.print(f"  Existing Persons: {stats['persons_in_group']}")
            console.print()
            
            if stats['faces_in_list'] == 0:
                console.print("[yellow]No faces found in FaceList. Run indexing first with face detection enabled.[/yellow]")
                return
            
            results = await indexer.finalize_faces(container_name=container)
            
            console.print()
            console.print("[bold green]Face finalization complete![/bold green]")
            console.print(f"  Clusters formed: {results['clusters']}")
            console.print(f"  Faces assigned: {results['faces_assigned']}")
            console.print(f"  Documents updated: {results['documents_updated']}")
        
        run_async(run())
    
    @app.command()
    def face_stats():
        """Show face detection and clustering statistics."""
        async def run():
            indexer = ImageIndexer()
            stats = await indexer.face_analyzer.get_clustering_stats()
            
            console.print("[bold cyan]Face Storage Statistics[/bold cyan]")
            console.print(f"  FaceList ID: {stats['face_list_id']}")
            console.print(f"  Faces stored: {stats['faces_in_list']}")
            console.print()
            console.print(f"  PersonGroup ID: {stats['person_group_id']}")
            console.print(f"  Persons created: {stats['persons_in_group']}")
        
        run_async(run())

    @app.command()
    def status():
        """Show index status and document count."""
        async def run():
            indexer = ImageIndexer()
            
            exists = await indexer.search_manager.index_exists()
            
            if exists:
                count = await indexer.search_manager.get_document_count()
                console.print(f"[bold green]Index exists[/bold green]")
                console.print(f"  Name: {indexer.settings.azure_search_index_name}")
                console.print(f"  Documents: {count}")
            else:
                console.print(f"[yellow]Index does not exist[/yellow]")
                console.print(f"  Name: {indexer.settings.azure_search_index_name}")
        
        run_async(run())
    
    app()


if __name__ == "__main__":
    main()
