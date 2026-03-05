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
MD5_PATTERN = re.compile(r'^[0-9a-f]{32}$', re.IGNORECASE)  # face doc IDs from deepface indexer
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
        
        # If no matches yet, search faces index by person_name
        if not persons and face_match_service.enabled:
            name_hits = face_match_service.search_faces_by_name(search, top=50)
            if name_hits:
                # Group by person_name to build synthetic person entries
                seen_names: dict[str, dict] = {}
                for hit in name_hits:
                    pname = hit.get("person_name") or ""
                    if pname not in seen_names:
                        seen_names[pname] = {
                            "face_doc_id": hit["id"],
                            "image_ids": set(),
                            "count": 0,
                        }
                    seen_names[pname]["count"] += 1
                    if hit.get("image_id"):
                        seen_names[pname]["image_ids"].add(hit["image_id"])
                
                result_persons = []
                for pname, info in seen_names.items():
                    result_persons.append(PersonResponse(
                        person_id=info["face_doc_id"],
                        name=pname,
                        user_data=f"face_doc_id:{info['face_doc_id']}",
                        face_count=info["count"],
                        image_count=len(info["image_ids"]),
                    ))
                return PersonListResponse(
                    persons=result_persons,
                    total_count=len(result_persons),
                )

        # If search looks like a face doc ID (md5 hash) or UUID, try face lookup
        if not persons and (MD5_PATTERN.match(search) or UUID_PATTERN.match(search)):
            logger.info("Searching for face ID", face_id=search)
            
            # Try local faces index first (deepface face doc IDs are md5 hashes)
            if face_match_service.enabled:
                face_doc = face_match_service.get_face_document(search)
                if face_doc:
                    # Found a face doc — return a synthetic person entry for it
                    similar = face_match_service.find_similar_by_face_doc_id(search, top=50, threshold=0.75)
                    unique_image_ids = set()
                    for m in similar:
                        img_id = m.get("image_id")
                        if img_id:
                            unique_image_ids.add(img_id)
                    
                    result_persons = [PersonResponse(
                        person_id=search,
                        name=face_doc.get("person_name") or "Unassigned Face",
                        user_data=f"face_doc_id:{search}",
                        face_count=len(similar),
                        image_count=len(unique_image_ids)
                    )]
                    return PersonListResponse(
                        persons=result_persons,
                        total_count=len(result_persons)
                    )
            
            # Fallback: search by persisted_face_id in the images index
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
    face_match_service = get_face_match_service(settings)
    
    person = await person_service.get_person(person_id)
    
    if not person:
        # Try face doc ID lookup (deepface md5 hashes)
        if face_match_service.enabled and MD5_PATTERN.match(person_id):
            face_doc = face_match_service.get_face_document(person_id)
            if face_doc:
                similar = face_match_service.find_similar_by_face_doc_id(person_id, top=50, threshold=0.75)
                unique_image_ids = {m.get("image_id") for m in similar if m.get("image_id")}
                return PersonResponse(
                    person_id=person_id,
                    name=face_doc.get("person_name") or "Unassigned Face",
                    user_data=f"face_doc_id:{person_id}",
                    face_count=len(similar),
                    image_count=len(unique_image_ids)
                )
        
        # Try persisted_face_id lookup in images index
        if UUID_PATTERN.match(person_id) or MD5_PATTERN.match(person_id):
            face_matches = await search_service.find_images_by_face_id(person_id)
            if face_matches:
                first_match = face_matches[0]
                linked_person_id = first_match.get("person_id")
                if linked_person_id:
                    person = await person_service.get_person(linked_person_id)
                if not person:
                    return PersonResponse(
                        person_id=person_id,
                        name="Unassigned Face",
                        user_data=f"persisted_face_id:{person_id}",
                        face_count=1,
                        image_count=len(face_matches)
                    )
        
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
    """Update a person's name.

    Works for both Face API UUIDs and deepface md5 face-doc IDs.
    For md5 IDs the name is propagated to the entire similar-face cluster
    in the faces index so that subsequent name searches find them all.
    """
    face_match_service = get_face_match_service(settings)
    search_service = get_search_service(settings)
    person_service = get_person_service(settings)

    face_ids_updated: list[str] = []

    # --- Deepface path: md5 face doc ID --------------------------------
    if MD5_PATTERN.match(person_id) and face_match_service.enabled:
        face_ids_updated = face_match_service.name_face_cluster(
            face_doc_id=person_id,
            name=request.name,
        )
        if not face_ids_updated:
            raise HTTPException(status_code=404, detail="Face document not found")

        logger.info("Named face cluster via deepface",
                   person_id=person_id,
                   name=request.name,
                   faces_updated=len(face_ids_updated))

        # Propagate person_names to the main image index
        # Look up face docs to collect their image_ids
        try:
            image_ids: list[str] = []
            for fid in face_ids_updated:
                fdoc = face_match_service.faces_client.get_document(
                    key=fid, selected_fields=["image_id"]
                )
                img_id = fdoc.get("image_id")
                if img_id:
                    image_ids.append(img_id)
            if image_ids:
                await search_service.add_person_name_to_images(image_ids, request.name)
        except Exception as e:
            logger.warning("Failed to propagate person_names to images", error=str(e))

    # --- Face API UUID path -------------------------------------------
    elif UUID_PATTERN.match(person_id):
        success = await person_service.update_person_name(person_id, request.name)
        if not success:
            logger.warning("Face API person update failed (may not exist)",
                          person_id=person_id)

        # Also update any matching face docs in the faces index
        if face_match_service.enabled:
            face_match_service.update_person_name_in_faces(person_id, request.name)

    # --- Fallback: try faces index directly ----------------------------
    else:
        if face_match_service.enabled:
            face_match_service.update_person_name_in_faces(person_id, request.name)

    # Update face_details.person_name in all image documents
    try:
        updated_count = await search_service.update_person_name_in_documents(
            person_id=person_id,
            person_name=request.name
        )
        logger.info("Updated person name in image documents",
                   person_id=person_id,
                   name=request.name,
                   documents_updated=updated_count)
    except Exception as e:
        logger.warning("Failed to update image documents", error=str(e))

    return {"status": "success", "person_id": person_id, "name": request.name}


@router.get("/{person_id}/images")
async def get_person_images(
    person_id: str,
    top: int = Query(50, ge=1, le=100),
    skip: int = Query(0, ge=0),
    threshold: float = Query(0.70, ge=0.0, le=1.0, description="Minimum similarity score (0-1)"),
    settings: Settings = Depends(get_settings)
):
    """Get all images containing a specific person or face."""
    search_service = get_search_service(settings)
    face_match_service = get_face_match_service(settings)
    
    # Helper to build vector-similarity response with scores as percentages
    def _build_face_match_response(
        similar: list[dict],
        images: list,
        person_id: str,
    ) -> dict:
        """Normalise scores to 0-100% relative to the best match and return."""
        # The top match (self) has score ~1.0 = 100%
        max_score = max((m["score"] for m in similar), default=1.0)
        confidence_map: dict[str, float] = {}
        seen: set[str] = set()
        ordered_ids: list[str] = []
        for m in similar:
            img_id = m.get("image_id")
            if img_id and img_id not in seen:
                seen.add(img_id)
                ordered_ids.append(img_id)
                # Store best score per image and normalise: base face = 100%
                raw = m["score"]
                pct = (raw / max_score) if max_score else 0.0
                if img_id not in confidence_map or pct > confidence_map[img_id]:
                    confidence_map[img_id] = pct

        for img in images:
            img.score = confidence_map.get(img.id, 0.0)
        images.sort(key=lambda x: x.score or 0, reverse=True)
        return {
            "results": images,
            "total_count": len(ordered_ids),
            "person_id": person_id,
        }

    # If this looks like a face doc ID (md5), try vector similarity search first
    if MD5_PATTERN.match(person_id) and face_match_service.enabled:
        similar = face_match_service.find_similar_by_face_doc_id(person_id, top=top * 2, threshold=threshold)
        if similar:
            doc_ids = list(dict.fromkeys(m.get("image_id") for m in similar if m.get("image_id")))
            if doc_ids:
                images = await search_service.get_images_by_ids(doc_ids[:top])
                return _build_face_match_response(similar, images, person_id)
    
    # Try searching by person_id in the images index
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
            doc_ids = [m["id"] for m in face_matches]
            results = await search_service.get_images_by_ids(doc_ids[:top])
            return {
                "results": results,
                "total_count": len(face_matches),
                "person_id": person_id
            }
    
    # If still no results and we have face matching, try the face doc lookup as fallback
    if result.total_count == 0 and face_match_service.enabled:
        face_doc = face_match_service.get_face_document(person_id)
        if face_doc:
            similar = face_match_service.find_similar_by_face_doc_id(person_id, top=top * 2, threshold=threshold)
            if similar:
                doc_ids_list = list(dict.fromkeys(m.get("image_id") for m in similar if m.get("image_id")))
                if doc_ids_list:
                    images = await search_service.get_images_by_ids(doc_ids_list[:top])
                    return _build_face_match_response(similar, images, person_id)
    
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
