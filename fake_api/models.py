from pydantic import BaseModel, Field, validator
from typing import List, Optional
from datetime import datetime
import ipaddress

class IPAddressRequest(BaseModel):
    ip_address: str = Field(..., description="IPv4 address to get fictional company information for")
    
    @validator('ip_address')
    def validate_ip_address(cls, v):
        try:
            ipaddress.IPv4Address(v)
            return v
        except ipaddress.AddressValueError:
            raise ValueError('Invalid IPv4 address format')

class CompanyNameRequest(BaseModel):
    company_name: str = Field(..., min_length=1, max_length=255, description="Company name to get information for")

class DeviceInfo(BaseModel):
    ip_address: str = Field(..., description="IPv4 address of the device")
    device_type: str = Field(..., description="Type of device (e.g., server, router, workstation)")
    hostname: str = Field(..., description="Hostname of the device")
    location: str = Field(..., description="Physical location of the device")
    last_seen: datetime = Field(..., description="Last time the device was seen online")

class CompanyInfo(BaseModel):
    name: str = Field(..., description="Company name")
    description: str = Field(..., description="Company description")
    industry: str = Field(..., description="Industry sector")
    founded_year: int = Field(..., ge=1800, le=2024, description="Year company was founded")
    headquarters: str = Field(..., description="Headquarters location")
    
class LocationInfo(BaseModel):
    address: str = Field(..., description="Street address")
    city: str = Field(..., description="City")
    country: str = Field(..., description="Country (non-US)")
    postal_code: str = Field(..., description="Postal/ZIP code")
    coordinates: Optional[str] = Field(None, description="GPS coordinates")

class IPCompanyResponse(BaseModel):
    original_ip: str = Field(..., description="The original IP address provided")
    company: CompanyInfo = Field(..., description="Fictional company information")
    associated_ips: List[str] = Field(..., description="List of fictional IP addresses associated with the company")
    location: LocationInfo = Field(..., description="Company location information")
    confidence_score: float = Field(..., ge=0.0, le=1.0, description="Fictional confidence score for the association")

class CompanyIPResponse(BaseModel):
    company_name: str = Field(..., description="The company name provided")
    total_devices: int = Field(..., ge=0, description="Total number of devices found")
    devices: List[DeviceInfo] = Field(..., description="List of devices associated with the company")
    network_summary: str = Field(..., description="Summary of the company's network infrastructure")

class CompanySummaryResponse(BaseModel):
    company: CompanyInfo = Field(..., description="Detailed company information")
    location: LocationInfo = Field(..., description="Company location details")
    business_summary: str = Field(..., description="Detailed business summary")
    key_facts: List[str] = Field(..., description="Key facts about the company")
    recent_news: List[str] = Field(..., description="Fictional recent news items")

class APIResponse(BaseModel):
    success: bool = Field(True, description="Indicates if the request was successful")
    message: str = Field("Request processed successfully", description="Response message")
    timestamp: datetime = Field(default_factory=datetime.now, description="Response timestamp")
    data: Optional[dict] = Field(None, description="Response data")

class ErrorResponse(BaseModel):
    success: bool = Field(False, description="Indicates the request failed")
    message: str = Field(..., description="Error message")
    error_code: str = Field(..., description="Error code")
    timestamp: datetime = Field(default_factory=datetime.now, description="Error timestamp")
