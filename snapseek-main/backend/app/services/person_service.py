"""Service for managing persons and face-based search."""

import httpx
import structlog
from typing import Any

from ..config import Settings, get_azure_credential

logger = structlog.get_logger()


class PersonService:
    """Service for Azure Face API person management and face search."""
    
    def __init__(self, settings: Settings):
        self.settings = settings
        self.logger = logger.bind(component="person_service")
        self.enabled = bool(settings.azure_face_endpoint)
        self.credential = None
        self.api_key = None
        
        if self.enabled:
            credential = get_azure_credential()
            if credential:
                self.credential = credential
                self.logger.info("Person service using identity-based authentication")
            elif settings.azure_face_key:
                self.api_key = settings.azure_face_key
                self.logger.info("Person service using key-based authentication")
            else:
                self.logger.warning("Face API not configured - no credentials")
                self.enabled = False
        
        if self.enabled:
            endpoint = settings.azure_face_endpoint.rstrip('/')
            self.person_group_url = f"{endpoint}/face/v1.0/persongroups/{settings.azure_face_person_group_id}"
            self.face_list_url = f"{endpoint}/face/v1.0/facelists/{settings.azure_face_list_id}"
            self.detect_url = f"{endpoint}/face/v1.0/detect"
            self.find_similar_url = f"{endpoint}/face/v1.0/findsimilars"
    
    async def _get_headers(self, content_type: str = "application/json") -> dict:
        """Get authorization headers for API requests."""
        headers = {"Content-Type": content_type}
        
        if self.api_key:
            headers["Ocp-Apim-Subscription-Key"] = self.api_key
        elif self.credential:
            token = self.credential.get_token("https://cognitiveservices.azure.com/.default")
            headers["Authorization"] = f"Bearer {token.token}"
        
        return headers
    
    async def list_persons(self) -> list[dict[str, Any]]:
        """List all persons in the PersonGroup."""
        if not self.enabled:
            return []
        
        try:
            headers = await self._get_headers()
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(
                    f"{self.person_group_url}/persons",
                    headers=headers
                )
                
                if response.status_code == 200:
                    persons = response.json()
                    return [
                        {
                            "person_id": p.get("personId"),
                            "name": p.get("name"),
                            "user_data": p.get("userData"),
                            "persisted_face_ids": p.get("persistedFaceIds", [])
                        }
                        for p in persons
                    ]
                else:
                    self.logger.error("Failed to list persons", status=response.status_code)
                    return []
                    
        except Exception as e:
            self.logger.error("Error listing persons", error=str(e))
            return []
    
    async def get_person(self, person_id: str) -> dict[str, Any] | None:
        """Get a specific person by ID."""
        if not self.enabled:
            return None
        
        try:
            headers = await self._get_headers()
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(
                    f"{self.person_group_url}/persons/{person_id}",
                    headers=headers
                )
                
                if response.status_code == 200:
                    p = response.json()
                    return {
                        "person_id": p.get("personId"),
                        "name": p.get("name"),
                        "user_data": p.get("userData"),
                        "persisted_face_ids": p.get("persistedFaceIds", [])
                    }
                return None
                    
        except Exception as e:
            self.logger.error("Error getting person", error=str(e))
            return None
    
    async def update_person_name(self, person_id: str, name: str) -> bool:
        """Update a person's name in Azure Face API."""
        if not self.enabled:
            return False
        
        try:
            headers = await self._get_headers()
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.patch(
                    f"{self.person_group_url}/persons/{person_id}",
                    headers=headers,
                    json={"name": name}
                )
                
                if response.status_code == 200:
                    self.logger.info("Updated person name", person_id=person_id, name=name)
                    return True
                else:
                    self.logger.error("Failed to update person", 
                                    status=response.status_code, 
                                    body=response.text[:200])
                    return False
                    
        except Exception as e:
            self.logger.error("Error updating person", error=str(e))
            return False
    
    async def detect_face(self, image_data: bytes) -> str | None:
        """Detect a face in an image and return temporary faceId."""
        if not self.enabled:
            return None
        
        try:
            headers = await self._get_headers("application/octet-stream")
            params = {
                "returnFaceId": "true",
                "recognitionModel": "recognition_04",
                "detectionModel": "detection_03",
            }
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    self.detect_url,
                    headers=headers,
                    params=params,
                    content=image_data
                )
                
                if response.status_code == 200:
                    faces = response.json()
                    if faces:
                        # Return the first detected face
                        return faces[0].get("faceId")
                return None
                    
        except Exception as e:
            self.logger.error("Face detection failed", error=str(e))
            return None
    
    async def find_similar_faces(self, face_id: str, 
                                  max_results: int = 100,
                                  threshold: float = 0.5) -> list[dict]:
        """Find similar faces in the FaceList."""
        if not self.enabled:
            return []
        
        try:
            headers = await self._get_headers()
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    self.find_similar_url,
                    headers=headers,
                    json={
                        "faceId": face_id,
                        "faceListId": self.settings.azure_face_list_id,
                        "maxNumOfCandidatesReturned": max_results,
                        "mode": "matchPerson"
                    }
                )
                
                if response.status_code == 200:
                    results = []
                    for item in response.json():
                        if item.get("confidence", 0) >= threshold:
                            results.append({
                                "persisted_face_id": item["persistedFaceId"],
                                "confidence": item["confidence"]
                            })
                    return results
                else:
                    self.logger.error("Find similar failed", 
                                    status=response.status_code,
                                    body=response.text[:200])
                    return []
                    
        except Exception as e:
            self.logger.error("Find similar error", error=str(e))
            return []
    
    async def get_face_list_metadata(self) -> list[dict]:
        """Get all faces in the FaceList with their userData (doc_id|face_index)."""
        if not self.enabled:
            return []
        
        try:
            headers = await self._get_headers()
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(self.face_list_url, headers=headers)
                
                if response.status_code == 200:
                    data = response.json()
                    faces = []
                    for face in data.get("persistedFaces", []):
                        user_data = face.get("userData", "")
                        doc_id = None
                        if "|" in user_data:
                            doc_id = user_data.rsplit("|", 1)[0]
                        faces.append({
                            "persisted_face_id": face.get("persistedFaceId"),
                            "document_id": doc_id
                        })
                    return faces
                return []
                    
        except Exception as e:
            self.logger.error("Failed to get face list", error=str(e))
            return []


# Singleton instance
_person_service: PersonService | None = None


def get_person_service(settings: Settings) -> PersonService:
    """Get or create singleton PersonService instance."""
    global _person_service
    if _person_service is None:
        _person_service = PersonService(settings)
    return _person_service
