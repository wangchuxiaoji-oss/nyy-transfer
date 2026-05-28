"""v1 API 路由。"""

from fastapi import APIRouter

from app.api.v1.admin import router as admin_router
from app.api.v1.auth import router as auth_router
from app.api.v1.file_requests import router as file_requests_router
from app.api.v1.health import router as health_router
from app.api.v1.my_shares import router as my_shares_router
from app.api.v1.shares import router as shares_router
from app.api.v1.uploads import router as uploads_router

api_v1_router = APIRouter()
api_v1_router.include_router(health_router)
api_v1_router.include_router(auth_router)
api_v1_router.include_router(admin_router)
api_v1_router.include_router(file_requests_router)
api_v1_router.include_router(my_shares_router)
api_v1_router.include_router(uploads_router)
api_v1_router.include_router(shares_router)

__all__ = ["api_v1_router"]
