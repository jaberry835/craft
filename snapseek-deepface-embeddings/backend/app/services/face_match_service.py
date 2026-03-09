"""Service for local face matching using face embeddings + Azure AI Search vector search."""

import io
import threading
from typing import Any

import numpy as np
import structlog
from PIL import Image
from azure.search.documents import SearchClient
from azure.search.documents.models import VectorizedQuery

from ..config import Settings, get_search_credential

logger = structlog.get_logger()

# Module-level singleton
_face_match_service: "FaceMatchService | None" = None
_face_match_service_lock = threading.Lock()


class FaceMatchService:
    """
    Embeds a query face image using dlib (face_recognition) or DeepFace,
    then performs a vector search against the ``snapseek-faces`` index.
    """

    def __init__(self, settings: Settings):
        self.settings = settings
        self.backend = settings.face_embedding_backend.lower()
        self.model_name = settings.deepface_model_name
        self.logger = logger.bind(component="face_match_service", backend=self.backend)
        self.enabled = settings.enable_local_face_matching
        self._model_loaded = False

        if self.enabled:
            credential = get_search_credential(settings)
            self.faces_client = SearchClient(
                endpoint=settings.azure_search_endpoint,
                index_name=settings.azure_search_faces_index_name,
                credential=credential,
            )
            self.logger.info(
                "FaceMatchService initialised",
                index=settings.azure_search_faces_index_name,
                backend=self.backend,
            )

    # ------------------------------------------------------------------
    # Lazy-load the face model
    # ------------------------------------------------------------------
    def _ensure_model(self) -> None:
        if self._model_loaded:
            return
        try:
            if self.backend == "dlib":
                import face_recognition  # noqa: F401
                self._model_loaded = True
                self.logger.info("face_recognition (dlib) ready for backend")
            else:
                from deepface import DeepFace
                dummy = np.zeros((48, 48, 3), dtype=np.uint8)
                DeepFace.represent(
                    img_path=dummy,
                    model_name=self.model_name,
                    enforce_detection=False,
                    detector_backend="skip",
                )
                self._model_loaded = True
                self.logger.info("DeepFace model loaded for backend", model=self.model_name)
        except Exception as e:
            self.logger.warning("Failed to pre-load face model", error=str(e))

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def generate_embedding(self, image_data: bytes) -> list[float] | None:
        """
        Generate a face embedding from *image_data*.

        Returns the embedding vector for the most prominent face,
        or ``None`` if no face is detected.
        """
        if not self.enabled:
            return None

        self._ensure_model()
        img_array = self._bytes_to_numpy(image_data)

        if self.backend == "dlib":
            return self._embed_dlib(img_array)
        return self._embed_deepface(img_array)

    def _embed_dlib(self, img_array: np.ndarray) -> list[float] | None:
        import face_recognition

        locations = face_recognition.face_locations(img_array, model="hog")
        if not locations:
            return None
        encodings = face_recognition.face_encodings(img_array, known_face_locations=locations)
        if not encodings:
            return None
        # Return first (largest) face
        return encodings[0].tolist()

    def _embed_deepface(self, img_array: np.ndarray) -> list[float] | None:
        from deepface import DeepFace

        try:
            results = DeepFace.represent(
                img_path=img_array,
                model_name=self.model_name,
                enforce_detection=False,
                detector_backend="opencv",
            )
        except Exception as e:
            self.logger.error("DeepFace embedding failed", error=str(e))
            return None

        valid = [r for r in results if (r.get("face_confidence") or 0) >= 0.50]
        if not valid:
            return None
        best = max(valid, key=lambda r: r.get("face_confidence", 0))
        return best["embedding"]

    def find_similar_faces(
        self,
        embedding: list[float],
        top: int = 50,
        threshold: float = 0.75,
    ) -> list[dict[str, Any]]:
        """
        Search the faces index for vectors similar to *embedding*.

        Returns a list of dicts: ``{id, image_id, image_url, filename, person_id, person_name, score}``.
        """
        if not self.enabled:
            return []

        vector_query = VectorizedQuery(
            vector=embedding,
            k_nearest_neighbors=top,
            fields="face_embedding",
        )

        try:
            results = self.faces_client.search(
                search_text=None,
                vector_queries=[vector_query],
                top=top,
                select=["id", "image_id", "image_url", "filename", "person_id", "person_name", "confidence"],
            )

            matches: list[dict[str, Any]] = []
            for doc in results:
                score = doc.get("@search.score", 0)
                self.logger.debug("Face vector match", face_id=doc["id"], score=score, threshold=threshold)
                if score < threshold:
                    continue
                matches.append(
                    {
                        "id": doc["id"],
                        "image_id": doc.get("image_id"),
                        "image_url": doc.get("image_url"),
                        "filename": doc.get("filename"),
                        "person_id": doc.get("person_id"),
                        "person_name": doc.get("person_name"),
                        "score": score,
                    }
                )
            return matches

        except Exception as e:
            self.logger.error("Face vector search failed", error=str(e))
            return []

    def find_images_by_face(
        self,
        image_data: bytes,
        top: int = 50,
        threshold: float = 0.5,
    ) -> list[dict[str, Any]]:
        """
        High-level helper: embed query image and return similar faces.
        """
        embedding = self.generate_embedding(image_data)
        if embedding is None:
            return []
        return self.find_similar_faces(embedding, top=top, threshold=threshold)

    def get_face_document(self, face_doc_id: str) -> dict[str, Any] | None:
        """
        Retrieve a single face document by its ID from the faces index.

        Returns the document dict or ``None`` if not found.
        """
        if not self.enabled:
            return None
        try:
            doc = self.faces_client.get_document(key=face_doc_id)
            return dict(doc)
        except Exception as e:
            self.logger.warning("Face document not found", face_doc_id=face_doc_id, error=str(e))
            return None

    def find_similar_by_face_doc_id(
        self,
        face_doc_id: str,
        top: int = 50,
        threshold: float = 0.75,
    ) -> list[dict[str, Any]]:
        """
        Look up the embedding of *face_doc_id* and return similar faces.

        This is the backend for "click a face → find all similar faces".
        """
        doc = self.get_face_document(face_doc_id)
        if doc is None:
            self.logger.warning("Face doc not found for similarity search", face_doc_id=face_doc_id)
            return []

        embedding = doc.get("face_embedding")
        if not embedding:
            self.logger.warning("Face document has no embedding", face_doc_id=face_doc_id)
            return []

        self.logger.info("Finding similar faces by doc ID",
                        face_doc_id=face_doc_id,
                        embedding_len=len(embedding),
                        threshold=threshold)
        return self.find_similar_faces(embedding, top=top, threshold=threshold)

    def list_unique_persons(self) -> list[dict[str, Any]]:
        """
        List distinct persons from the faces index by aggregating
        ``person_id`` facets.

        Returns list of ``{person_id, person_name, face_count}``.
        """
        if not self.enabled:
            return []

        try:
            results = self.faces_client.search(
                search_text="*",
                facets=["person_id,count:1000"],
                top=0,
            )

            persons: list[dict[str, Any]] = []
            for facet in results.get_facets().get("person_id", []):
                pid = facet["value"]
                if not pid:
                    continue
                # Fetch one doc to get the person_name
                name_results = self.faces_client.search(
                    search_text="*",
                    filter=f"person_id eq '{pid}'",
                    select=["person_name"],
                    top=1,
                )
                person_name = None
                for d in name_results:
                    person_name = d.get("person_name")
                    break

                persons.append(
                    {
                        "person_id": pid,
                        "person_name": person_name,
                        "face_count": facet["count"],
                    }
                )
            return persons

        except Exception as e:
            self.logger.error("Failed to list persons from faces index", error=str(e))
            return []

    def update_person_name_in_faces(self, person_id: str, name: str) -> int:
        """
        Update ``person_name`` for all face docs matching *person_id*.

        Returns the number of documents updated.
        """
        if not self.enabled:
            return 0

        try:
            results = self.faces_client.search(
                search_text="*",
                filter=f"person_id eq '{person_id}'",
                select=["id"],
                top=1000,
            )

            docs_to_merge = [{"id": doc["id"], "person_name": name} for doc in results]
            if not docs_to_merge:
                return 0

            self.faces_client.merge_documents(documents=docs_to_merge)
            self.logger.info("Updated person name in faces index",
                           person_id=person_id, name=name, count=len(docs_to_merge))
            return len(docs_to_merge)

        except Exception as e:
            self.logger.error("Failed to update person name", error=str(e))
            return 0

    def name_face_cluster(
        self, face_doc_id: str, name: str, threshold: float = 0.75
    ) -> list[str]:
        """Name a face and all its similar faces in the faces index.

        1. Finds the base face doc.
        2. Vector-searches for all similar faces above *threshold*.
        3. Sets ``person_name`` = *name* on every match.

        Returns the list of face doc IDs that were updated.
        """
        if not self.enabled:
            return []

        similar = self.find_similar_by_face_doc_id(
            face_doc_id, top=200, threshold=threshold
        )
        if not similar:
            # At minimum update just the base doc
            try:
                self.faces_client.merge_documents(
                    documents=[{"id": face_doc_id, "person_name": name}]
                )
                return [face_doc_id]
            except Exception as e:
                self.logger.error("Failed to name base face", error=str(e))
                return []

        ids_updated: list[str] = []
        batch = []
        for m in similar:
            fid = m.get("id")
            if fid:
                batch.append({"id": fid, "person_name": name})
                ids_updated.append(fid)

        # Ensure the base face is included
        if face_doc_id not in ids_updated:
            batch.append({"id": face_doc_id, "person_name": name})
            ids_updated.append(face_doc_id)

        try:
            self.faces_client.merge_documents(documents=batch)
            self.logger.info(
                "Named face cluster",
                base_face=face_doc_id,
                name=name,
                count=len(ids_updated),
            )
        except Exception as e:
            self.logger.error("Failed to name cluster", error=str(e))

        return ids_updated

    def search_faces_by_name(self, name: str, top: int = 50) -> list[dict[str, Any]]:
        """Search the faces index by ``person_name``.

        Returns a list of dicts with face doc fields, de-duped to one
        representative per unique ``person_name``.
        """
        if not self.enabled:
            return []

        try:
            results = self.faces_client.search(
                search_text=name,
                search_fields=["person_name"],
                select=["id", "image_id", "image_url", "filename",
                        "person_id", "person_name", "confidence",
                        "bounding_box", "face_index"],
                top=top,
            )
            return [dict(doc) for doc in results]
        except Exception as e:
            self.logger.error("Failed to search faces by name", error=str(e))
            return []

    def assign_person_to_face(self, face_doc_id: str, person_id: str, person_name: str | None = None) -> bool:
        """Assign a person identity to a single face document."""
        if not self.enabled:
            return False

        try:
            update: dict[str, Any] = {"id": face_doc_id, "person_id": person_id}
            if person_name:
                update["person_name"] = person_name
            self.faces_client.merge_documents(documents=[update])
            return True
        except Exception as e:
            self.logger.error("Failed to assign person", error=str(e))
            return False

    def get_face_count(self) -> int:
        """Get total number of face documents."""
        if not self.enabled:
            return 0
        try:
            return self.faces_client.get_document_count()
        except Exception:
            return 0

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _bytes_to_numpy(image_data: bytes) -> np.ndarray:
        img = Image.open(io.BytesIO(image_data)).convert("RGB")
        return np.array(img)


def get_face_match_service(settings: Settings) -> FaceMatchService:
    """Get or create the singleton FaceMatchService."""
    global _face_match_service

    if _face_match_service is not None:
        return _face_match_service

    with _face_match_service_lock:
        if _face_match_service is not None:
            return _face_match_service
        _face_match_service = FaceMatchService(settings)
        return _face_match_service
