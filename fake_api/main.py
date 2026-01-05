from fastapi import FastAPI, HTTPException, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
import logging
from datetime import datetime
from typing import Union
import os
import sys
from pathlib import Path

from config import settings
from models import (
    IPAddressRequest, CompanyNameRequest, IPCompanyResponse, 
    CompanyIPResponse, CompanySummaryResponse, APIResponse, ErrorResponse
)
from azure_openai_service import azure_openai_service
from swagger_config import setup_swagger_ui

# Add the project root to the Python path
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.log_level),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager"""
    logger.info("Starting Fictional Information API")
    yield
    logger.info("Shutting down Fictional Information API")

# Initialize FastAPI app
app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="API that provides fictional information about companies and IP addresses using Azure OpenAI GPT-4",
    lifespan=lifespan
)

# Setup Swagger UI
setup_swagger_ui(app)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Exception handlers
@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc):
    return JSONResponse(
        status_code=exc.status_code,
        content=ErrorResponse(
            message=str(exc.detail),
            error_code=f"HTTP_{exc.status_code}"
        ).dict()
    )

@app.exception_handler(Exception)
async def general_exception_handler(request, exc):
    logger.error(f"Unhandled exception: {exc}")
    return JSONResponse(
        status_code=500,
        content=ErrorResponse(
            message="Internal server error",
            error_code="INTERNAL_ERROR"
        ).dict()
    )

# Health check endpoint
@app.get("/health", response_model=APIResponse)
async def health_check():
    """Health check endpoint"""
    return APIResponse(
        message="API is healthy",
        data={"status": "healthy", "timestamp": datetime.now()}
    )

# API Endpoints

@app.get("/api/v1/ip-company/{ip_address}", response_model=IPCompanyResponse)
async def get_ip_company_info(ip_address: str):
    """
    Get fictional company information for a given IP address (GET method)
    
    Returns fictional company details, associated IP addresses, and location information.
    All companies are located outside the United States.
    """
    try:
        # Validate IP address format
        request_data = IPAddressRequest(ip_address=ip_address)
        
        # Generate fictional company information
        company_data = await azure_openai_service.generate_ip_company_info(ip_address)
        
        response = IPCompanyResponse(
            original_ip=ip_address,
            company=company_data["company"],
            associated_ips=company_data["associated_ips"],
            location=company_data["location"],
            confidence_score=company_data["confidence_score"]
        )
        
        logger.info(f"Generated company info for IP: {ip_address}")
        return response
        
    except ValueError as e:
        logger.error(f"Validation error for IP {ip_address}: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error processing IP {ip_address}: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate company information")

@app.post("/api/v1/ip-company", response_model=IPCompanyResponse)
async def post_ip_company_info(request: IPAddressRequest):
    """
    Get fictional company information for a given IP address (POST method)
    
    Returns fictional company details, associated IP addresses, and location information.
    All companies are located outside the United States.
    """
    try:
        # Generate fictional company information
        company_data = await azure_openai_service.generate_ip_company_info(request.ip_address)
        
        response = IPCompanyResponse(
            original_ip=request.ip_address,
            company=company_data["company"],
            associated_ips=company_data["associated_ips"],
            location=company_data["location"],
            confidence_score=company_data["confidence_score"]
        )
        
        logger.info(f"Generated company info for IP: {request.ip_address}")
        return response
        
    except Exception as e:
        logger.error(f"Error processing IP {request.ip_address}: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate company information")

@app.get("/api/v1/company-devices/{company_name}", response_model=CompanyIPResponse)
async def get_company_devices(company_name: str):
    """
    Get fictional IP addresses and device details for a given company (GET method)
    
    Returns a list of fictional devices with IP addresses, device types, hostnames, and locations.
    """
    try:
        # Validate company name
        request_data = CompanyNameRequest(company_name=company_name)
        
        # Generate fictional device information
        device_data = await azure_openai_service.generate_company_devices(company_name)
        
        response = CompanyIPResponse(
            company_name=company_name,
            total_devices=device_data["total_devices"],
            devices=device_data["devices"],
            network_summary=device_data["network_summary"]
        )
        
        logger.info(f"Generated device info for company: {company_name}")
        return response
        
    except ValueError as e:
        logger.error(f"Validation error for company {company_name}: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error processing company {company_name}: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate device information")

@app.post("/api/v1/company-devices", response_model=CompanyIPResponse)
async def post_company_devices(request: CompanyNameRequest):
    """
    Get fictional IP addresses and device details for a given company (POST method)
    
    Returns a list of fictional devices with IP addresses, device types, hostnames, and locations.
    """
    try:
        # Generate fictional device information
        device_data = await azure_openai_service.generate_company_devices(request.company_name)
        
        response = CompanyIPResponse(
            company_name=request.company_name,
            total_devices=device_data["total_devices"],
            devices=device_data["devices"],
            network_summary=device_data["network_summary"]
        )
        
        logger.info(f"Generated device info for company: {request.company_name}")
        return response
        
    except Exception as e:
        logger.error(f"Error processing company {request.company_name}: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate device information")

@app.get("/api/v1/company-summary/{company_name}", response_model=CompanySummaryResponse)
async def get_company_summary(company_name: str):
    """
    Get comprehensive fictional summary for a given company (GET method)
    
    Returns detailed company information, location details, business summary, 
    key facts, and recent news items.
    """
    try:
        # Validate company name
        request_data = CompanyNameRequest(company_name=company_name)
        
        # Generate fictional company summary
        summary_data = await azure_openai_service.generate_company_summary(company_name)
        
        response = CompanySummaryResponse(
            company=summary_data["company"],
            location=summary_data["location"],
            business_summary=summary_data["business_summary"],
            key_facts=summary_data["key_facts"],
            recent_news=summary_data["recent_news"]
        )
        
        logger.info(f"Generated company summary for: {company_name}")
        return response
        
    except ValueError as e:
        logger.error(f"Validation error for company {company_name}: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error processing company {company_name}: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate company summary")

@app.post("/api/v1/company-summary", response_model=CompanySummaryResponse)
async def post_company_summary(request: CompanyNameRequest):
    """
    Get comprehensive fictional summary for a given company (POST method)
    
    Returns detailed company information, location details, business summary, 
    key facts, and recent news items.
    """
    try:
        # Generate fictional company summary
        summary_data = await azure_openai_service.generate_company_summary(request.company_name)
        
        response = CompanySummaryResponse(
            company=summary_data["company"],
            location=summary_data["location"],
            business_summary=summary_data["business_summary"],
            key_facts=summary_data["key_facts"],
            recent_news=summary_data["recent_news"]
        )
        
        logger.info(f"Generated company summary for: {request.company_name}")
        return response
        
    except Exception as e:
        logger.error(f"Error processing company {request.company_name}: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate company summary")

def setup_environment():
    """Setup environment variables and configuration"""
    env_file = project_root / ".env"

    if not env_file.exists():
        print("⚠️  .env file not found. Please create one based on .env.example")
        print("📋 Copy .env.example to .env and update with your Azure OpenAI credentials")
        return False

    return True

def check_dependencies():
    """Check if all required dependencies are installed"""
    try:
        import fastapi
        import uvicorn
        import azure.identity
        import openai
        import pydantic
        print("✅ All dependencies are installed")
        return True
    except ImportError as e:
        print(f"❌ Missing dependency: {e}")
        print("🔧 Please install dependencies with: pip install -r requirements.txt")
        return False

if __name__ == "__main__":
    print("🚀 Starting Fictional Information API...")
    print("=" * 50)

    # Check environment
    if not setup_environment():
        sys.exit(1)

    # Check dependencies
    if not check_dependencies():
        sys.exit(1)

    # Start the server
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=settings.debug,
        log_level=settings.log_level.lower()
    )
