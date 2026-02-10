"""Azure Face API analyzer for face detection and identification.

Implements a two-pass approach for accurate face clustering:
- Pass 1: Detect faces and store in FaceList (persistent, no expiration)
- Pass 2: Cluster similar faces, create Persons, update documents
"""

import structlog
import httpx
import uuid
import asyncio
from dataclasses import dataclass
from tenacity import retry, stop_after_attempt, wait_exponential

from ..config import Settings, get_azure_credential
from ..models import FaceAnalysisResult, DetectedFace, BoundingBox

logger = structlog.get_logger()


@dataclass
class StoredFace:
    """A face stored in the FaceList with metadata."""
    persisted_face_id: str
    document_id: str
    face_index: int
    bounding_box: dict


class FaceAnalyzer:
    """Analyzer using Azure Face API with two-pass clustering for accurate identification.
    
    Two-Pass Approach:
    1. detect_and_persist(): Detect faces, add to FaceList → returns persistedFaceId
    2. cluster_and_assign_persons(): Cluster faces using FindSimilar, create Persons
    
    This ensures zero duplicate Persons regardless of image processing order.
    """
    
    def __init__(self, settings: Settings):
        """Initialize the Face API client."""
        self.settings = settings
        self.logger = logger.bind(component="face_api")
        self.enabled = bool(settings.azure_face_endpoint)
        self.credential = None
        self.api_key = None
        self.person_group_id = settings.azure_face_person_group_id
        self.face_list_id = settings.azure_face_list_id
        self._face_list_initialized = False
        self._person_group_initialized = False
        
        if self.enabled:
            credential = get_azure_credential()
            if credential:
                self.credential = credential
                self.logger.info("Face API using identity-based authentication")
            elif settings.azure_face_key:
                self.api_key = settings.azure_face_key
                self.logger.info("Face API using key-based authentication")
            else:
                self.logger.warning("Face API not configured - no credentials available")
                self.enabled = False
        
        if self.enabled:
            endpoint = settings.azure_face_endpoint.rstrip('/')
            self.detect_url = f"{endpoint}/face/v1.0/detect"
            self.face_list_url = f"{endpoint}/face/v1.0/facelists/{self.face_list_id}"
            self.person_group_url = f"{endpoint}/face/v1.0/persongroups/{self.person_group_id}"
            self.identify_url = f"{endpoint}/face/v1.0/identify"
            self.find_similar_url = f"{endpoint}/face/v1.0/findsimilars"
    
    async def _get_headers(self, content_type: str = "application/octet-stream") -> dict:
        """Get authorization headers for API requests."""
        headers = {"Content-Type": content_type}
        
        if self.api_key:
            headers["Ocp-Apim-Subscription-Key"] = self.api_key
        elif self.credential:
            token = self.credential.get_token("https://cognitiveservices.azure.com/.default")
            headers["Authorization"] = f"Bearer {token.token}"
        
        return headers

    # =========================================================================
    # FaceList Management (for Pass 1 - persistent face storage)
    # =========================================================================

    async def ensure_face_list_exists(self) -> bool:
        """Ensure the FaceList exists, create if needed."""
        if self._face_list_initialized:
            return True
            
        try:
            headers = await self._get_headers("application/json")
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(self.face_list_url, headers=headers)
                
                if response.status_code == 200:
                    self.logger.info("FaceList exists", face_list_id=self.face_list_id)
                    self._face_list_initialized = True
                    return True
                elif response.status_code == 404:
                    self.logger.info("Creating FaceList", face_list_id=self.face_list_id)
                    create_response = await client.put(
                        self.face_list_url,
                        headers=headers,
                        json={
                            "name": "Azure Snap Seek Face Collection",
                            "userData": "Persistent face storage for two-pass clustering",
                            "recognitionModel": "recognition_04"
                        }
                    )
                    
                    if create_response.status_code == 200:
                        self.logger.info("FaceList created successfully")
                        self._face_list_initialized = True
                        return True
                    else:
                        self.logger.error("Failed to create FaceList", 
                                        status=create_response.status_code, 
                                        body=create_response.text[:500])
                        return False
                else:
                    self.logger.error("Failed to check FaceList", 
                                    status=response.status_code)
                    return False
                    
        except Exception as e:
            self.logger.error("FaceList initialization failed", error=str(e))
            return False

    async def add_face_to_list(self, image_data: bytes, target_face: dict,
                                user_data: str | None = None) -> str | None:
        """Add a face to the FaceList for persistent storage."""
        try:
            headers = await self._get_headers("application/octet-stream")
            
            params = {
                "detectionModel": "detection_03",
                "targetFace": f"{target_face['left']},{target_face['top']},{target_face['width']},{target_face['height']}"
            }
            if user_data:
                params["userData"] = user_data
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{self.face_list_url}/persistedFaces",
                    headers=headers,
                    params=params,
                    content=image_data
                )
                
                if response.status_code == 200:
                    persisted_face_id = response.json().get("persistedFaceId")
                    self.logger.debug("Added face to FaceList", persisted_face_id=persisted_face_id)
                    return persisted_face_id
                else:
                    self.logger.error("Failed to add face to FaceList",
                                    status=response.status_code,
                                    body=response.text[:500])
                    return None
                    
        except Exception as e:
            self.logger.error("Add face to FaceList failed", error=str(e))
            return None

    async def list_faces_in_face_list(self) -> list[dict]:
        """List all faces in the FaceList."""
        try:
            headers = await self._get_headers("application/json")
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(self.face_list_url, headers=headers)
                
                if response.status_code == 200:
                    data = response.json()
                    return data.get("persistedFaces", [])
                return []
                
        except Exception as e:
            self.logger.error("Failed to list faces", error=str(e))
            return []

    async def delete_face_list(self) -> bool:
        """Delete the entire FaceList."""
        try:
            headers = await self._get_headers("application/json")
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.delete(self.face_list_url, headers=headers)
                
                if response.status_code == 200:
                    self.logger.info("FaceList deleted", face_list_id=self.face_list_id)
                    self._face_list_initialized = False
                    return True
                return False
                
        except Exception as e:
            self.logger.error("Failed to delete FaceList", error=str(e))
            return False

    # =========================================================================
    # PersonGroup Management (for Pass 2 - final person assignment)
    # =========================================================================

    async def ensure_person_group_exists(self) -> bool:
        """Ensure the PersonGroup exists, create if needed."""
        if self._person_group_initialized:
            return True
            
        try:
            headers = await self._get_headers("application/json")
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(self.person_group_url, headers=headers)
                
                if response.status_code == 200:
                    self.logger.info("PersonGroup exists", person_group_id=self.person_group_id)
                    self._person_group_initialized = True
                    return True
                elif response.status_code == 404:
                    self.logger.info("Creating PersonGroup", person_group_id=self.person_group_id)
                    create_response = await client.put(
                        self.person_group_url,
                        headers=headers,
                        json={
                            "name": "Azure Snap Seek Persons",
                            "userData": "Clustered face identities",
                            "recognitionModel": "recognition_04"
                        }
                    )
                    
                    if create_response.status_code == 200:
                        self.logger.info("PersonGroup created successfully")
                        self._person_group_initialized = True
                        return True
                    return False
                return False
                    
        except Exception as e:
            self.logger.error("PersonGroup initialization failed", error=str(e))
            return False

    async def _create_person(self, name: str | None = None) -> str | None:
        """Create a new Person in the PersonGroup."""
        try:
            headers = await self._get_headers("application/json")
            person_name = name or f"Person-{str(uuid.uuid4())[:8]}"
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{self.person_group_url}/persons",
                    headers=headers,
                    json={"name": person_name}
                )
                
                if response.status_code == 200:
                    person_id = response.json().get("personId")
                    self.logger.info("Created Person", person_id=person_id)
                    return person_id
                return None
                    
        except Exception as e:
            self.logger.error("Person creation failed", error=str(e))
            return None

    async def _train_person_group(self) -> bool:
        """Train the PersonGroup after adding faces."""
        try:
            headers = await self._get_headers("application/json")
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{self.person_group_url}/train",
                    headers=headers
                )
                
                if response.status_code == 202:
                    self.logger.info("PersonGroup training started")
                    return True
                return False
                    
        except Exception as e:
            self.logger.error("PersonGroup training failed", error=str(e))
            return False

    async def _wait_for_training(self, timeout: int = 120) -> bool:
        """Wait for PersonGroup training to complete."""
        try:
            headers = await self._get_headers("application/json")
            
            for _ in range(timeout // 2):
                async with httpx.AsyncClient(timeout=30.0) as client:
                    response = await client.get(
                        f"{self.person_group_url}/training",
                        headers=headers
                    )
                    
                    if response.status_code == 200:
                        status = response.json().get("status")
                        if status == "succeeded":
                            self.logger.info("PersonGroup training completed")
                            return True
                        elif status == "failed":
                            self.logger.error("PersonGroup training failed")
                            return False
                
                await asyncio.sleep(2)
            
            self.logger.warning("PersonGroup training timeout")
            return False
                
        except Exception as e:
            self.logger.error("Training wait failed", error=str(e))
            return False

    # =========================================================================
    # Pass 1: Detect and Persist Faces
    # =========================================================================

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    async def detect_and_persist(self, image_data: bytes, document_id: str) -> FaceAnalysisResult:
        """
        PASS 1: Detect faces and store in FaceList for later clustering.
        
        This does NOT create Persons or attempt identification.
        Faces are stored with persistedFaceId that never expires.
        """
        if not self.enabled:
            return FaceAnalysisResult(faces=[], face_count=0)
        
        self.logger.info("Pass 1: Detecting and persisting faces", document_id=document_id)
        
        try:
            await self.ensure_face_list_exists()
            
            headers = await self._get_headers()
            params = {
                "returnFaceId": "true",
                "returnFaceLandmarks": "false",
                "recognitionModel": "recognition_04",
                "detectionModel": "detection_03",
            }
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    self.detect_url,
                    headers=headers,
                    params=params,
                    content=image_data,
                )
                
                if response.status_code != 200:
                    self.logger.error("Face detection failed", status=response.status_code)
                    return FaceAnalysisResult(faces=[], face_count=0)
                
                detected_faces = response.json()
            
            if not detected_faces:
                return FaceAnalysisResult(faces=[], face_count=0)
            
            faces = []
            for idx, face in enumerate(detected_faces):
                rect = face.get("faceRectangle", {})
                bbox = BoundingBox(
                    x=rect.get("left", 0),
                    y=rect.get("top", 0),
                    width=rect.get("width", 0),
                    height=rect.get("height", 0)
                )
                
                # Store doc reference with face
                user_data = f"{document_id}|{idx}"
                persisted_face_id = await self.add_face_to_list(
                    image_data,
                    rect,
                    user_data=user_data
                )
                
                faces.append(DetectedFace(
                    face_id=face.get("faceId"),
                    persisted_face_id=persisted_face_id,
                    person_id=None,
                    person_name=None,
                    confidence=None,
                    age=None,
                    emotion=None,
                    bounding_box=bbox
                ))
            
            self.logger.info("Pass 1 complete", 
                          document_id=document_id,
                          face_count=len(faces))
            
            return FaceAnalysisResult(faces=faces, face_count=len(faces))
            
        except Exception as e:
            self.logger.error("Face detection/persistence failed", error=str(e))
            return FaceAnalysisResult(faces=[], face_count=0)

    # =========================================================================
    # Pass 2: Cluster Faces and Assign Persons
    # =========================================================================

    async def find_similar_faces(self, face_id: str, 
                                  max_results: int = 100, 
                                  threshold: float = 0.5) -> list[tuple[str, float]]:
        """Find faces similar to the given face in the FaceList."""
        try:
            headers = await self._get_headers("application/json")
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    self.find_similar_url,
                    headers=headers,
                    json={
                        "faceId": face_id,
                        "faceListId": self.face_list_id,
                        "maxNumOfCandidatesReturned": max_results,
                        "mode": "matchPerson"
                    }
                )
                
                if response.status_code == 200:
                    results = []
                    for item in response.json():
                        if item.get("confidence", 0) >= threshold:
                            results.append((item["persistedFaceId"], item["confidence"]))
                    return results
                else:
                    self.logger.error("Find similar failed", status=response.status_code)
                    return []
                    
        except Exception as e:
            self.logger.error("Find similar error", error=str(e))
            return []

    async def cluster_faces_with_redetection(self, 
                                              get_image_func,
                                              similarity_threshold: float = 0.5
                                              ) -> dict[str, list[tuple[str, str]]]:
        """
        PASS 2, Step 1: Cluster faces using re-detection for FindSimilar.
        
        Args:
            get_image_func: Async function(doc_id) -> image_bytes
            similarity_threshold: Minimum similarity to group faces
            
        Returns:
            Dict mapping cluster_id to list of (persistedFaceId, doc_id) tuples
        """
        self.logger.info("Pass 2: Clustering faces")
        
        faces = await self.list_faces_in_face_list()
        if not faces:
            return {}
        
        # Parse userData: "doc_id|face_index"
        face_docs: dict[str, tuple[str, int]] = {}
        docs_to_process: dict[str, list[str]] = {}
        
        for face in faces:
            pf_id = face.get("persistedFaceId")
            user_data = face.get("userData", "")
            if "|" in user_data:
                doc_id, face_idx = user_data.rsplit("|", 1)
                face_docs[pf_id] = (doc_id, int(face_idx))
                if doc_id not in docs_to_process:
                    docs_to_process[doc_id] = []
                docs_to_process[doc_id].append(pf_id)
        
        self.logger.info("Documents to process", count=len(docs_to_process))
        
        assigned = set()
        clusters: dict[str, list[tuple[str, str]]] = {}
        
        for doc_id, pf_ids in docs_to_process.items():
            try:
                image_data = await get_image_func(doc_id)
                if not image_data:
                    continue
            except Exception as e:
                self.logger.warning("Could not get image", doc_id=doc_id, error=str(e))
                continue
            
            # Re-detect to get temporary faceIds
            headers = await self._get_headers()
            params = {
                "returnFaceId": "true",
                "recognitionModel": "recognition_04",
                "detectionModel": "detection_03",
            }
            
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    response = await client.post(
                        self.detect_url,
                        headers=headers,
                        params=params,
                        content=image_data,
                    )
                    
                    if response.status_code != 200:
                        continue
                    
                    detected = response.json()
            except Exception:
                continue
            
            for idx, det_face in enumerate(detected):
                temp_face_id = det_face.get("faceId")
                if not temp_face_id:
                    continue
                
                # Find matching persistedFaceId by index
                matching_pf_id = None
                for pf_id in pf_ids:
                    if face_docs.get(pf_id, (None, -1))[1] == idx:
                        matching_pf_id = pf_id
                        break
                
                if not matching_pf_id or matching_pf_id in assigned:
                    continue
                
                # Find similar faces
                similar = await self.find_similar_faces(
                    temp_face_id, 
                    threshold=similarity_threshold
                )
                
                cluster_id = str(uuid.uuid4())
                cluster_faces = [(matching_pf_id, doc_id)]
                assigned.add(matching_pf_id)
                
                for sim_pf_id, confidence in similar:
                    if sim_pf_id not in assigned and sim_pf_id in face_docs:
                        sim_doc_id = face_docs[sim_pf_id][0]
                        cluster_faces.append((sim_pf_id, sim_doc_id))
                        assigned.add(sim_pf_id)
                
                if cluster_faces:
                    clusters[cluster_id] = cluster_faces
        
        self.logger.info("Clustering complete", 
                        cluster_count=len(clusters),
                        assigned_faces=len(assigned))
        return clusters

    async def assign_persons_from_clusters(self, 
                                           clusters: dict[str, list[tuple[str, str]]]
                                           ) -> dict[str, str]:
        """
        PASS 2, Step 2: Create Persons for each cluster.
        
        Returns:
            Dict mapping persistedFaceId to person_id
        """
        self.logger.info("Assigning persons", cluster_count=len(clusters))
        
        await self.ensure_person_group_exists()
        
        face_to_person: dict[str, str] = {}
        
        for cluster_id, faces in clusters.items():
            person_name = f"Person-{cluster_id[:8]}"
            person_id = await self._create_person(person_name)
            if not person_id:
                continue
            
            for pf_id, doc_id in faces:
                face_to_person[pf_id] = person_id
        
        if face_to_person:
            await self._train_person_group()
            await self._wait_for_training(timeout=60)
        
        self.logger.info("Person assignment complete",
                        persons_created=len(clusters),
                        faces_assigned=len(face_to_person))
        
        return face_to_person

    # =========================================================================
    # Simple Detection (no persistence)
    # =========================================================================

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    async def detect_faces(self, image_data: bytes, persist: bool = False) -> FaceAnalysisResult:
        """Simple face detection without persistence."""
        if not self.enabled:
            return FaceAnalysisResult(faces=[], face_count=0)
        
        try:
            headers = await self._get_headers()
            params = {
                "returnFaceId": "true",
                "returnFaceLandmarks": "false",
                "recognitionModel": "recognition_04",
                "detectionModel": "detection_03",
            }
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    self.detect_url,
                    headers=headers,
                    params=params,
                    content=image_data,
                )
                
                if response.status_code != 200:
                    return FaceAnalysisResult(faces=[], face_count=0)
                
                detected_faces = response.json()
            
            faces = []
            for face in detected_faces:
                rect = face.get("faceRectangle", {})
                bbox = BoundingBox(
                    x=rect.get("left", 0),
                    y=rect.get("top", 0),
                    width=rect.get("width", 0),
                    height=rect.get("height", 0)
                )
                
                faces.append(DetectedFace(
                    face_id=face.get("faceId"),
                    bounding_box=bbox
                ))
            
            return FaceAnalysisResult(faces=faces, face_count=len(faces))
            
        except Exception as e:
            self.logger.error("Face detection failed", error=str(e))
            return FaceAnalysisResult(faces=[], face_count=0)

    async def list_persons(self) -> list[dict]:
        """List all Persons in the PersonGroup."""
        try:
            headers = await self._get_headers("application/json")
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(
                    f"{self.person_group_url}/persons",
                    headers=headers
                )
                
                if response.status_code == 200:
                    return response.json()
                return []
                
        except Exception as e:
            self.logger.error("Failed to list Persons", error=str(e))
            return []

    async def get_clustering_stats(self) -> dict:
        """Get statistics about face storage."""
        faces = await self.list_faces_in_face_list()
        persons = await self.list_persons()
        
        return {
            "faces_in_list": len(faces),
            "persons_in_group": len(persons),
            "face_list_id": self.face_list_id,
            "person_group_id": self.person_group_id
        }
