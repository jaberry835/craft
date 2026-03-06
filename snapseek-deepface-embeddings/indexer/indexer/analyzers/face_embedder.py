"""Local face detection and embedding using DeepFace (Facenet512)."""

import hashlib
import io
from typing import Any

import numpy as np
import structlog
from PIL import Image

from ..config import Settings
from ..models import BoundingBox, DetectedFace, FaceAnalysisResult, FaceDocument

logger = structlog.get_logger()


class FaceEmbedder:
    """Detect faces locally and generate 512-dim embeddings using DeepFace / Facenet512."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.model_name = settings.deepface_model_name  # e.g. "Facenet512"
        self.logger = logger.bind(component="face_embedder")
        self._model_loaded = False

    # ------------------------------------------------------------------
    # Lazy-load the DeepFace model so import time stays fast
    # ------------------------------------------------------------------
    def _ensure_model(self) -> None:
        """Pre-load the model weights on first call (avoids repeated cold starts)."""
        if self._model_loaded:
            return
        try:
            from deepface import DeepFace

            # Trigger weight download / caching by running a tiny dummy image
            dummy = np.zeros((48, 48, 3), dtype=np.uint8)
            DeepFace.represent(
                img_path=dummy,
                model_name=self.model_name,
                enforce_detection=False,
                detector_backend="skip",
            )
            self._model_loaded = True
            self.logger.info("DeepFace model loaded", model=self.model_name)
        except Exception as e:
            self.logger.warning("Failed to pre-load DeepFace model", error=str(e))

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def detect_faces(self, image_data: bytes) -> FaceAnalysisResult:
        """
        Detect faces in *image_data* using the configured DeepFace detector.

        Returns an ``FaceAnalysisResult`` with bounding-box information for
        every face found (no embeddings yet).
        """
        from deepface import DeepFace

        self._ensure_model()

        img_array = self._bytes_to_numpy(image_data)
        try:
            faces = DeepFace.extract_faces(
                img_path=img_array,
                detector_backend="opencv",
                enforce_detection=False,
                align=True,
            )
        except Exception as e:
            self.logger.error("DeepFace face detection failed", error=str(e))
            return FaceAnalysisResult(faces=[], face_count=0)

        detected: list[DetectedFace] = []
        for i, face_obj in enumerate(faces):
            # extract_faces returns confidence = 0 when no face is truly found
            conf = face_obj.get("confidence", 0)
            if conf is None or conf < 0.50:
                continue

            region = face_obj.get("facial_area", {})
            bbox = BoundingBox(
                x=region.get("x", 0),
                y=region.get("y", 0),
                width=region.get("w", 0),
                height=region.get("h", 0),
            )
            detected.append(
                DetectedFace(
                    face_id=f"local_{i}",
                    confidence=float(conf),
                    bounding_box=bbox,
                )
            )

        return FaceAnalysisResult(faces=detected, face_count=len(detected))

    def generate_embeddings(
        self, image_data: bytes
    ) -> list[dict[str, Any]]:
        """
        Detect all faces and return a list of dicts, each containing:
            - ``embedding``: list[float] (512-dim for Facenet512)
            - ``facial_area``: dict with x, y, w, h
            - ``confidence``: float
        """
        from deepface import DeepFace

        self._ensure_model()

        img_array = self._bytes_to_numpy(image_data)
        try:
            representations = DeepFace.represent(
                img_path=img_array,
                model_name=self.model_name,
                enforce_detection=False,
                detector_backend="opencv",
            )
        except Exception as e:
            self.logger.error("DeepFace embedding generation failed", error=str(e))
            return []

        results: list[dict[str, Any]] = []
        for rep in representations:
            conf = rep.get("face_confidence", 0)
            if conf is None or conf < 0.50:
                continue
            results.append(
                {
                    "embedding": rep["embedding"],
                    "facial_area": rep.get("facial_area", {}),
                    "confidence": float(conf),
                }
            )
        return results

    def generate_single_embedding(self, image_data: bytes) -> list[float] | None:
        """
        Generate a single embedding for the most prominent face in *image_data*.

        Used mainly by the backend to embed a query image for vector search.
        Returns ``None`` if no face is detected.
        """
        results = self.generate_embeddings(image_data)
        if not results:
            return None
        # Return the highest-confidence face
        best = max(results, key=lambda r: r["confidence"])
        return best["embedding"]

    def detect_and_embed(
        self,
        image_data: bytes,
        image_id: str,
        image_url: str | None = None,
        filename: str | None = None,
    ) -> tuple[FaceAnalysisResult, list[FaceDocument]]:
        """
        All-in-one: detect faces, compute embeddings, and build ``FaceDocument``s
        ready to be uploaded to the faces search index.

        This uses DeepFace's own face detector.  Prefer ``embed_faces()`` when
        Face API bounding boxes are available (more accurate locations).

        Returns:
            (face_analysis_result, list_of_face_documents)
        """
        embeddings = self.generate_embeddings(image_data)

        detected_faces: list[DetectedFace] = []
        face_docs: list[FaceDocument] = []

        for idx, emb_info in enumerate(embeddings):
            area = emb_info.get("facial_area", {})
            bbox = BoundingBox(
                x=area.get("x", 0),
                y=area.get("y", 0),
                width=area.get("w", 0),
                height=area.get("h", 0),
            )

            face_doc_id = hashlib.md5(
                f"{image_id}_face_{idx}".encode()
            ).hexdigest()

            detected_faces.append(
                DetectedFace(
                    face_id=f"local_{idx}",
                    persisted_face_id=face_doc_id,
                    confidence=emb_info["confidence"],
                    bounding_box=bbox,
                )
            )

            face_docs.append(
                FaceDocument(
                    id=face_doc_id,
                    image_id=image_id,
                    image_url=image_url,
                    filename=filename,
                    face_index=idx,
                    bounding_box={
                        "x": bbox.x,
                        "y": bbox.y,
                        "width": bbox.width,
                        "height": bbox.height,
                    },
                    confidence=emb_info["confidence"],
                    face_embedding=emb_info["embedding"],
                )
            )

        face_result = FaceAnalysisResult(
            faces=detected_faces,
            face_count=len(detected_faces),
        )
        return face_result, face_docs

    def embed_faces(
        self,
        image_data: bytes,
        face_regions: list[dict],
        image_id: str,
        image_url: str | None = None,
        filename: str | None = None,
        padding_pct: float = 0.30,
    ) -> list[FaceDocument]:
        """Generate embeddings for pre-detected face regions (e.g. from Face API).

        Each entry in *face_regions* must contain a ``bounding_box`` dict with
        keys ``x``, ``y``, ``width``, ``height``.

        The face is cropped from the full image with *padding_pct* extra margin
        (default 30 %) to give the recognition model surrounding context, then
        passed to DeepFace with ``detector_backend="skip"`` so it generates an
        embedding without re-detecting.

        Falls back to ``detect_and_embed()`` if no *face_regions* are supplied.

        Returns:
            A list of ``FaceDocument`` objects ready to upload.
        """
        if not face_regions:
            _, docs = self.detect_and_embed(
                image_data, image_id, image_url, filename
            )
            return docs

        from deepface import DeepFace

        self._ensure_model()

        full_img = Image.open(io.BytesIO(image_data)).convert("RGB")
        img_w, img_h = full_img.size

        face_docs: list[FaceDocument] = []

        for idx, region in enumerate(face_regions):
            bb = region.get("bounding_box") or {}
            x, y = bb.get("x", 0), bb.get("y", 0)
            w, h = bb.get("width", 0), bb.get("height", 0)
            if w <= 0 or h <= 0:
                continue

            # Add padding so the recognition model gets some context
            pad_x = int(w * padding_pct)
            pad_y = int(h * padding_pct)
            x1 = max(x - pad_x, 0)
            y1 = max(y - pad_y, 0)
            x2 = min(x + w + pad_x, img_w)
            y2 = min(y + h + pad_y, img_h)

            crop = full_img.crop((x1, y1, x2, y2))
            # Resize to a standard face-input size that Facenet512 expects
            crop = crop.resize((160, 160), Image.LANCZOS)
            crop_array = np.array(crop)

            try:
                reps = DeepFace.represent(
                    img_path=crop_array,
                    model_name=self.model_name,
                    enforce_detection=False,
                    detector_backend="skip",
                )
            except Exception as e:
                self.logger.warning(
                    "Embedding failed for face crop",
                    face_index=idx, error=str(e),
                )
                continue

            if not reps:
                continue

            embedding = reps[0]["embedding"]
            conf = reps[0].get("face_confidence", region.get("confidence", 0.0))
            # When detector_backend="skip", confidence may be 0; use Face API's
            if (conf is None or conf == 0) and region.get("confidence"):
                conf = region["confidence"]

            face_doc_id = hashlib.md5(
                f"{image_id}_face_{idx}".encode()
            ).hexdigest()

            face_docs.append(
                FaceDocument(
                    id=face_doc_id,
                    image_id=image_id,
                    image_url=image_url,
                    filename=filename,
                    face_index=idx,
                    bounding_box={"x": x, "y": y, "width": w, "height": h},
                    confidence=float(conf) if conf else None,
                    face_embedding=embedding,
                )
            )

            self.logger.debug(
                "Embedded face from Face API region",
                face_index=idx,
                bbox=f"{x},{y},{w},{h}",
            )

        if not face_docs:
            self.logger.warning(
                "No embeddings from Face API regions, falling back to detect_and_embed"
            )
            _, docs = self.detect_and_embed(
                image_data, image_id, image_url, filename
            )
            return docs

        return face_docs

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _bytes_to_numpy(image_data: bytes) -> np.ndarray:
        """Convert raw bytes to an RGB numpy array expected by DeepFace."""
        img = Image.open(io.BytesIO(image_data)).convert("RGB")
        return np.array(img)
