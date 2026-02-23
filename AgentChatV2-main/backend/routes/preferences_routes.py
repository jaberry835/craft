"""
User Preferences API Routes
Handles per-user settings like theme.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Request, HTTPException

from models import UserPreferences
from services.cosmos_service import cosmos_service
from auth.middleware import get_current_user
from observability import get_logger

router = APIRouter(prefix="/api/user", tags=["user-preferences"])
logger = get_logger(__name__)


@router.get("/preferences", response_model=UserPreferences)
async def get_preferences(request: Request):
    """Get the current user's preferences."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    prefs = await cosmos_service.get_user_preferences(user.user_id)
    if prefs:
        return UserPreferences(
            id=prefs.get("id"),
            user_id=prefs.get("user_id"),
            theme=prefs.get("theme", "dark"),
            updated_at=prefs.get("updated_at"),
        )
    # Return defaults if no prefs saved yet
    return UserPreferences(id=user.user_id, user_id=user.user_id)


@router.put("/preferences", response_model=UserPreferences)
async def update_preferences(request: Request, prefs: UserPreferences):
    """Update the current user's preferences."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Validate theme value
    if prefs.theme not in ("dark", "light"):
        raise HTTPException(status_code=400, detail="Theme must be 'dark' or 'light'")

    saved = await cosmos_service.save_user_preferences(user.user_id, {
        "theme": prefs.theme,
    })

    return UserPreferences(
        id=saved.get("id"),
        user_id=saved.get("user_id"),
        theme=saved.get("theme", "dark"),
        updated_at=saved.get("updated_at"),
    )
