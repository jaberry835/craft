"""Person management and face-based search endpoints."""

import re
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query, Request
from pydantic import BaseModel, Field
import structlog

from ..config import Settings, get_settings
from ..services.person_service import PersonService, get_person_service
from ..services.search_service import SearchService, get_search_service
from ..services.face_match_service import FaceMatchService, get_face_match_service
from ..models import SearchRequest

logger = structlog.get_logger()

router = APIRouter(prefix="/api/v1/persons", tags=["persons"])

# Constants
UUID_PATTERN = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.IGNORECASE)
MAX_UPLOAD_SIZE = 10 * 1024 * 1024  # 10MB


async def validate_file_size(request: Request, max_size: int = MAX_UPLOAD_SIZE):
    """
    Validate file upload size before reading the entire content.

    Checks Content-Length header if present, otherwise validates during streaming.
    """
    content_length = request.headers.get("content-length")
    if content_length:
        content_length = int(content_length)
        if content_length > max_size:
            raise HTTPException(
                status_code=413,
                detail=f"File too large. Maximum size is {max_size / (1024 * 1024):.1f}MB"
            )


class PersonResponse(BaseModel):
    """Response model for a person."""
    person_id: str
    name: str | None
    user_data: str | None = None
    face_count: int = 0
    image_count: int = 0


class PersonListResponse(BaseModel):
    """Response model for list of persons."""
    persons: list[PersonResponse]
    total_count: int


class UpdatePersonRequest(BaseModel):
    """Request model for updating a person."""
    name: str = Field(..., min_length=1, max_length=100, description="Person's name")


class FindByFaceResponse(BaseModel):
    """Response model for find-by-face search."""
    matched_persisted_face_ids: list[str]
    matched_document_ids: list[str]
    confidence_scores: dict[str, float]
    total_matches: int


@router.get("", response_model=PersonListResponse)
async def list_persons(
    search: str | None = Query(None, description="Search by name or ID"),
    settings: Settings = Depends(get_settings)
):
    """List all known persons, optionally filtered by name or ID."""
    person_service = get_person_service(settings)
    search_service = get_search_service(settings)
    face_match_service = get_face_match_service(settings)
    
    persons = await person_service.list_persons()
    
    # Merge persons from local faces index (deepface embeddings)
    if face_match_service.enabled:
        local_persons = face_match_service.list_unique_persons()
        # Build a set of existing person_ids from Face API
        existing_ids = {p.get("person_id") for p in persons}
        for lp in local_persons:
            if lp["person_id"] not in existing_ids:
                persons.append({
                    "person_id": lp["person_id"],
                    "name": lp.get("person_name"),
                    "user_data": None,
                    "persisted_face_ids": [],
                    "face_count_local": lp.get("face_count", 0),
                })
    
    # Filter by search term if provided
    if search:
        search_lower = search.lower()
        persons = [
            p for p in persons
            if (p.get("name") and search_lower in p["name"].lower()) or
               (p.get("person_id") and search_lower in p["person_id"].lower()) or
               any(search_lower in fid.lower() for fid in p.get("persisted_face_ids", []))
        ]
        
        # If search looks like a UUID and no persons found, search by persisted_face_id in images
        if not persons and UUID_PATTERN.match(search):
            logger.info("Searching for face ID in images", face_id=search)
            face_matches = await search_service.find_images_by_face_id(search)
            logger.info("Face search result", match_count=len(face_matches), matches=face_matches)
            if face_matches:
                # If we found images with this face, return a synthetic person entry
                # representing this face (even if not yet in PersonGroup)
                first_match = face_matches[0]
                person_id = first_match.get("person_id")
                
                if person_id:
                    # Face is linked to a person - fetch that person
                    person = await person_service.get_person(person_id)
                    if person:
                        persons = [person]
                else:
                    # Face exists in images but not linked to a PersonGroup person
                    # Return a synthetic entry for this unassigned face
                    result_persons = [PersonResponse(
                        person_id=search,  # Use the face ID as identifier
                        name=f"Unassigned Face",
                        user_data=f"persisted_face_id:{search}",
                        face_count=1,
                        image_count=len(face_matches)
                    )]
                    return PersonListResponse(
                        persons=result_persons,
                        total_count=len(result_persons)
                    )
    
    # Enrich with image counts from search index
    result_persons = []
    for p in persons:
        person_id = p.get("person_id")
        
        # Query search index for images containing this person
        image_count = 0
        if person_id:
            try:
                search_result = await search_service.search(SearchRequest(
                    query="*",
                    person_ids=[person_id],
                    top=1
                ))
                image_count = search_result.total_count
            except Exception:
                pass
        
        result_persons.append(PersonResponse(
            person_id=person_id,
            name=p.get("name"),
            user_data=p.get("user_data"),
            face_count=len(p.get("persisted_face_ids", [])),
            image_count=image_count
        ))
    
    return PersonListResponse(
        persons=result_persons,
        total_count=len(result_persons)
    )


@router.get("/{person_id}", response_model=PersonResponse)
async def get_person(
    person_id: str,
    settings: Settings = Depends(get_settings)
):
    """Get a specific person by ID."""
    person_service = get_person_service(settings)
    search_service = get_search_service(settings)
    
    person = await person_service.get_person(person_id)
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")
    
    # Get image count
    image_count = 0
    try:
        search_result = await search_service.search(SearchRequest(
            query="*",
            person_ids=[person_id],
            top=1
        ))
        image_count = search_result.total_count
    except Exception:
        pass
    
    return PersonResponse(
        person_id=person["person_id"],
        name=person.get("name"),
        user_data=person.get("user_data"),
        face_count=len(person.get("persisted_face_ids", [])),
        image_count=image_count
    )


@router.patch("/{person_id}")
async def update_person(
    person_id: str,
    request: UpdatePersonRequest,
    settings: Settings = Depends(get_settings)
):
    """Update a person's name."""
    person_service = get_person_service(settings)
    search_service = get_search_service(settings)
    
    # Update in Face API
    success = await person_service.update_person_name(person_id, request.name)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to update person in Face API")
    
    # Update face_details in all documents containing this person
    try:
        # Update each document's face_details with the new name
        updated_count = await search_service.update_person_name_in_documents(
            person_id=person_id,
            person_name=request.name
        )
        
        logger.info("Updated person name in documents", 
                   person_id=person_id, 
                   name=request.name,
                   documents_updated=updated_count)
        
    except Exception as e:
        logger.warning("Failed to update documents", error=str(e))
        # Don't fail the request - Face API was updated successfully
    
    return {"status": "success", "person_id": person_id, "name": request.name}


@router.get("/{person_id}/images")
async def get_person_images(
    person_id: str,
    top: int = Query(50, ge=1, le=100),
    skip: int = Query(0, ge=0),
    settings: Settings = Depends(get_settings)
):
    """Get all images containing a specific person or face."""
    search_service = get_search_service(settings)
    
    # First try searching by person_id
    result = await search_service.search(SearchRequest(
        query="*",
        person_ids=[person_id],
        top=top,
        skip=skip
    ))
    
    # If no results and the ID looks like a UUID, try searching by persisted_face_id
    if result.total_count == 0 and UUID_PATTERN.match(person_id):
        face_matches = await search_service.find_images_by_face_id(person_id)
        if face_matches:
            # Fetch full ImageResult objects
            doc_ids = [m["id"] for m in face_matches]
            results = await search_service.get_images_by_ids(doc_ids[:top])
            return {
                "results": results,
                "total_count": len(face_matches),
                "person_id": person_id
            }
    
    return {
        "results": result.results,
        "total_count": result.total_count,
        "person_id": person_id
    }


@router.post("/find-by-face", response_model=FindByFaceResponse)
async def find_by_face(
    request: Request,
    image: UploadFile = File(..., description="Image containing a face to search for"),
    threshold: float = Query(0.5, ge=0.0, le=1.0, description="Minimum similarity threshold"),
    settings: Settings = Depends(get_settings)
):
    """
    Upload an image and find all photos containing the same person.

    Uses local deepface embeddings + Azure AI Search vector search when enabled,
    falling back to the Azure Face API FaceList approach otherwise.
    """
    # Validate file size before reading
    await validate_file_size(request, MAX_UPLOAD_SIZE)

    image_data = await image.read()
    if len(image_data) > MAX_UPLOAD_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"Image too large (max {MAX_UPLOAD_SIZE / (1024 * 1024):.1f}MB)"
        )

    # --- Local face matching (deepface + vector search) ---
    face_match_service = get_face_match_service(settings)
    if face_match_service.enabled:
        matches = face_match_service.find_images_by_face(
            image_data, top=100, threshold=threshold
        )
        if not matches and not matches:  # also try when empty
            raise HTTPException(
                status_code=400,
                detail="No face detected in the uploaded image. Please upload an image with a clear face."
            )
        # Deduplicate by image_id
        seen_image_ids: set[str] = set()
        matched_doc_ids: list[str] = []
        confidence_scores: dict[str, float] = {}
        matched_pf_ids: list[str] = []
        for m in matches:
            matched_pf_ids.append(m["id"])
            img_id = m.get("image_id")
            if img_id and img_id not in seen_image_ids:
                seen_image_ids.add(img_id)
                matched_doc_ids.append(img_id)
                confidence_scores[img_id] = m["score"]

        return FindByFaceResponse(
            matched_persisted_face_ids=matched_pf_ids,
            matched_document_ids=matched_doc_ids,
            confidence_scores=confidence_scores,
            total_matches=len(matched_doc_ids),
        )

    # --- Fallback: Azure Face API ---
    person_service = get_person_service(settings)

    face_id = await person_service.detect_face(image_data)
    if not face_id:
        raise HTTPException(
            status_code=400,
            detail="No face detected in the uploaded image. Please upload an image with a clear face."
        )

    similar_faces = await person_service.find_similar_faces(
        face_id=face_id,
        threshold=threshold
    )

    if not similar_faces:
        return FindByFaceResponse(
            matched_persisted_face_ids=[],
            matched_document_ids=[],
            confidence_scores={},
            total_matches=0
        )

    face_metadata = await person_service.get_face_list_metadata()
    face_to_doc = {f["persisted_face_id"]: f["document_id"] for f in face_metadata}

    matched_doc_ids_set: set[str] = set()
    confidence_scores_fb: dict[str, float] = {}
    matched_pf_ids_fb: list[str] = []

    for match in similar_faces:
        pf_id = match["persisted_face_id"]
        matched_pf_ids_fb.append(pf_id)
        doc_id = face_to_doc.get(pf_id)
        if doc_id:
            matched_doc_ids_set.add(doc_id)
            if doc_id not in confidence_scores_fb or match["confidence"] > confidence_scores_fb[doc_id]:
                confidence_scores_fb[doc_id] = match["confidence"]

    return FindByFaceResponse(
        matched_persisted_face_ids=matched_pf_ids_fb,
        matched_document_ids=list(matched_doc_ids_set),
        confidence_scores=confidence_scores_fb,
        total_matches=len(matched_doc_ids_set)
    )


@router.post("/find-by-face/images")
async def find_images_by_face(
    request: Request,
    image: UploadFile = File(..., description="Image containing a face to search for"),
    threshold: float = Query(0.5, ge=0.0, le=1.0, description="Minimum similarity threshold"),
    top: int = Query(50, ge=1, le=100),
    settings: Settings = Depends(get_settings)
):
    """
    Upload an image and get the actual image results containing the same person.

    Uses local deepface embeddings + Azure AI Search vector search when enabled,
    falling back to the Azure Face API FaceList approach otherwise.
    """
    # Validate file size before reading
    await validate_file_size(request, MAX_UPLOAD_SIZE)

    search_service = get_search_service(settings)

    image_data = await image.read()
    if len(image_data) > MAX_UPLOAD_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"Image too large (max {MAX_UPLOAD_SIZE / (1024 * 1024):.1f}MB)"
        )

    # --- Local face matching (deepface + vector search) ---
    face_match_service = get_face_match_service(settings)
    if face_match_service.enabled:
        matches = face_match_service.find_images_by_face(
            image_data, top=top * 2, threshold=threshold
        )
        if not matches:
            return {
                "results": [],
                "total_count": 0,
                "message": "No face detected or no matching faces found"
            }

        # Deduplicate image_ids and build confidence map
        seen: set[str] = set()
        doc_ids: list[str] = []
        confidence_map: dict[str, float] = {}
        for m in matches:
            img_id = m.get("image_id")
            if img_id and img_id not in seen:
                seen.add(img_id)
                doc_ids.append(img_id)
                confidence_map[img_id] = m["score"]

        if not doc_ids:
            return {
                "results": [],
                "total_count": 0,
                "message": "Matching faces found but no linked images"
            }

        images = await search_service.get_images_by_ids(doc_ids[:top])
        for img in images:
            img.score = confidence_map.get(img.id, 0.0)
        images.sort(key=lambda x: x.score or 0, reverse=True)

        return {
            "results": images,
            "total_count": len(images),
            "matched_faces": len(matches),
        }

    # --- Fallback: Azure Face API ---
    person_service = get_person_service(settings)

    face_id = await person_service.detect_face(image_data)
    if not face_id:
        raise HTTPException(
            status_code=400,
            detail="No face detected in the uploaded image"
        )

    similar_faces = await person_service.find_similar_faces(
        face_id=face_id,
        threshold=threshold
    )

    if not similar_faces:
        return {
            "results": [],
            "total_count": 0,
            "message": "No matching faces found in the collection"
        }

    face_metadata = await person_service.get_face_list_metadata()
    face_to_doc = {f["persisted_face_id"]: f["document_id"] for f in face_metadata}

    doc_ids = list(set(
        face_to_doc.get(m["persisted_face_id"])
        for m in similar_faces
        if face_to_doc.get(m["persisted_face_id"])
    ))

    if not doc_ids:
        return {
            "results": [],
            "total_count": 0,
            "message": "Matching faces found but documents not indexed"
        }

    images = await search_service.get_images_by_ids(doc_ids[:top])

    confidence_map = {}
    for match in similar_faces:
        doc_id = face_to_doc.get(match["persisted_face_id"])
        if doc_id and (doc_id not in confidence_map or match["confidence"] > confidence_map[doc_id]):
            confidence_map[doc_id] = match["confidence"]

    for img in images:
        img.score = confidence_map.get(img.id, 0.0)

    images.sort(key=lambda x: x.score or 0, reverse=True)

    return {
        "results": images,
        "total_count": len(images),
        "matched_faces": len(similar_faces)
    }
