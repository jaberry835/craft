from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Any
import logging

from azure_openai_service import azure_openai_service
from models import (
    IPAddressRequest, CompanyNameRequest, IPCompanyResponse, 
    CompanyIPResponse, CompanySummaryResponse, APIResponse, ErrorResponse
)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
# Create FastAPI instance
app = FastAPI(
    title="Simple Echo API",
    description="A simple API with echo functionality and Swagger support",
    version="1.0.0"
)

# Pydantic model for the echo request
class EchoRequest(BaseModel):
    message: str

# Pydantic model for the echo response
class EchoResponse(BaseModel):
    echo: str
    original_message: str

@app.get("/")
async def root():
    """
    Root endpoint that returns a welcome message.
    """
    return {"message": "Welcome to the Simple Echo API! Visit /docs for Swagger UI."}

@app.post("/echo", response_model=EchoResponse)
async def echo(request: EchoRequest):
    """
    Echo endpoint that returns the input message.
    
    - **message**: The message to echo back
    """
    return EchoResponse(
        echo=request.message,
        original_message=request.message
    )

@app.get("/echo/{message}")
async def echo_get(message: str):
    """
    Simple GET echo endpoint that returns the message from the URL path.
    
    - **message**: The message to echo back (from URL path)
    """
    return {
        "echo": message,
        "original_message": message,
        "method": "GET"
    }

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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
