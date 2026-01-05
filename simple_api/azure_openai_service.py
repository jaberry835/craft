import logging
from typing import Optional, List
from azure.identity import DefaultAzureCredential, AzureCliCredential, ChainedTokenCredential
from azure.core.exceptions import ClientAuthenticationError
from openai import AzureOpenAI
from config import settings
import json
import random
import re
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

class AzureOpenAIService:
    """Service class for interacting with Azure OpenAI GPT-4 model"""
    
    def __init__(self):
        self.client = None
        self._initialize_client()
    
    def _initialize_client(self):
        """Initialize Azure OpenAI client with proper authentication"""
        try:
            # Check if we have valid Azure OpenAI configuration
            logger.info(f"Azure OpenAI Endpoint: {settings.azure_openai_endpoint}")
            logger.info(f"Azure OpenAI API Key configured: {bool(settings.azure_openai_api_key and settings.azure_openai_api_key != 'your-api-key-here')}")
            
            if not settings.azure_openai_endpoint or settings.azure_openai_endpoint == "https://your-resource-name.openai.azure.com/":
                logger.warning("Azure OpenAI endpoint not configured. Using mock mode for development.")
                self.client = None
                return
            
            # Use managed identity in Azure, fallback to Azure CLI for local development
            credential = ChainedTokenCredential(
                DefaultAzureCredential(),
                AzureCliCredential()
            )
            
            # Initialize Azure OpenAI client
            if settings.azure_openai_api_key and settings.azure_openai_api_key != "your-api-key-here":
                # Use API key if provided
                logger.info("Using API key authentication")
                self.client = AzureOpenAI(
                    api_key=settings.azure_openai_api_key,
                    api_version=settings.azure_openai_api_version,
                    azure_endpoint=settings.azure_openai_endpoint
                )
            else:
                # Use managed identity
                logger.info("Using managed identity authentication")
                token = credential.get_token("https://cognitiveservices.azure.com/.default")
                self.client = AzureOpenAI(
                    api_key=token.token,
                    api_version=settings.azure_openai_api_version,
                    azure_endpoint=settings.azure_openai_endpoint
                )
            
            logger.info("Azure OpenAI client initialized successfully")
            
        except ClientAuthenticationError as e:
            logger.error(f"Authentication failed: {e}")
            logger.warning("Falling back to mock mode for development")
            self.client = None
        except Exception as e:
            logger.error(f"Failed to initialize Azure OpenAI client: {e}")
            logger.warning("Falling back to mock mode for development")
            self.client = None
    
    def _parse_json_with_fallback(self, content: str, identifier: str, operation: str) -> Optional[dict]:
        """Parse JSON with multiple fallback strategies to extract as much data as possible"""
        
        # Strategy 1: Try direct JSON parsing
        try:
            return json.loads(content)
        except json.JSONDecodeError as e:
            logger.warning(f"⚠️ Direct JSON parsing failed for {operation} ({identifier}): {e}")
        
        # Strategy 2: Try to find JSON block within the content
        try:
            # Look for JSON block between ```json and ``` or just { and }
            import re
            
            # Pattern 1: JSON code block
            json_pattern = r'```(?:json)?\s*(\{.*?\})\s*```'
            match = re.search(json_pattern, content, re.DOTALL)
            if match:
                logger.info(f"📝 Found JSON in code block for {operation} ({identifier})")
                return json.loads(match.group(1))
            
            # Pattern 2: First complete JSON object
            json_pattern = r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}'
            match = re.search(json_pattern, content, re.DOTALL)
            if match:
                logger.info(f"📝 Found JSON object for {operation} ({identifier})")
                return json.loads(match.group(0))
                
        except (json.JSONDecodeError, AttributeError) as e:
            logger.warning(f"⚠️ JSON extraction failed for {operation} ({identifier}): {e}")
        
        # Strategy 3: Try to extract partial information using regex patterns
        try:
            logger.info(f"🔧 Attempting partial data extraction for {operation} ({identifier})")
            
            if "company" in operation.lower():
                return self._extract_company_info_from_text(content, identifier, operation)
            elif "device" in operation.lower():
                return self._extract_device_info_from_text(content, identifier, operation)
            elif "summary" in operation.lower():
                return self._extract_summary_info_from_text(content, identifier, operation)
                
        except Exception as e:
            logger.warning(f"⚠️ Partial extraction failed for {operation} ({identifier}): {e}")
        
        logger.error(f"❌ All parsing strategies failed for {operation} ({identifier})")
        return None
    
    def _extract_company_info_from_text(self, content: str, ip_address: str, operation: str) -> dict:
        """Extract company information from unstructured text"""
        import re
        
        # Extract company name
        name_patterns = [
            r'"name":\s*"([^"]+)"',
            r"'name':\s*'([^']+)'",
            r"Company[:\s]+([^\n,]+)",
            r"Name[:\s]+([^\n,]+)"
        ]
        
        company_name = "Unknown Company"
        for pattern in name_patterns:
            match = re.search(pattern, content, re.IGNORECASE)
            if match:
                company_name = match.group(1).strip()
                break
        
        # Extract industry
        industry_patterns = [
            r'"industry":\s*"([^"]+)"',
            r"'industry':\s*'([^']+)'",
            r"Industry[:\s]+([^\n,]+)"
        ]
        
        industry = "Technology"
        for pattern in industry_patterns:
            match = re.search(pattern, content, re.IGNORECASE)
            if match:
                industry = match.group(1).strip()
                break
        
        # Extract country/city
        country_patterns = [
            r'"country":\s*"([^"]+)"',
            r"'country':\s*'([^']+)'",
            r"Country[:\s]+([^\n,]+)"
        ]
        
        country = "Canada"
        for pattern in country_patterns:
            match = re.search(pattern, content, re.IGNORECASE)
            if match:
                country = match.group(1).strip()
                break
        
        city_patterns = [
            r'"city":\s*"([^"]+)"',
            r"'city':\s*'([^']+)'",
            r"City[:\s]+([^\n,]+)"
        ]
        
        city = "Toronto"
        for pattern in city_patterns:
            match = re.search(pattern, content, re.IGNORECASE)
            if match:
                city = match.group(1).strip()
                break
        
        # Extract IP addresses
        ip_pattern = r'\b(?:\d{1,3}\.){3}\d{1,3}\b'
        found_ips = re.findall(ip_pattern, content)
        associated_ips = [ip for ip in found_ips if ip != ip_address][:4]  # Limit to 4
        
        if not associated_ips:
            associated_ips = [
                f"192.168.{random.randint(1, 254)}.{random.randint(1, 254)}",
                f"10.0.{random.randint(1, 254)}.{random.randint(1, 254)}"
            ]
        
        logger.info(f"🔧 Extracted partial company info for IP {ip_address}: {company_name} in {city}, {country}")
        
        return {
            "company": {
                "name": company_name,
                "description": f"A {industry.lower()} company based in {city}, {country}",
                "industry": industry,
                "founded_year": random.randint(2000, 2020),
                "headquarters": f"{city}, {country}"
            },
            "associated_ips": associated_ips,
            "location": {
                "address": f"{random.randint(1, 999)} Business Street",
                "city": city,
                "country": country,
                "postal_code": f"{random.randint(10000, 99999)}",
                "coordinates": f"{random.uniform(-90, 90):.6f}, {random.uniform(-180, 180):.6f}"
            },
            "confidence_score": 0.75  # Lower confidence for extracted data
        }
    
    def _extract_device_info_from_text(self, content: str, company_name: str, operation: str) -> dict:
        """Extract device information from unstructured text"""
        import re
        
        # Extract device information using patterns
        device_pattern = r'(?:server|router|workstation|firewall|switch|printer|storage)'
        devices_mentioned = re.findall(device_pattern, content, re.IGNORECASE)
        
        # Extract IP addresses
        ip_pattern = r'\b(?:\d{1,3}\.){3}\d{1,3}\b'
        found_ips = re.findall(ip_pattern, content)
        
        # Create devices based on found information
        devices = []
        device_types = ["server", "router", "workstation", "firewall", "switch"]
        num_devices = max(len(devices_mentioned), len(found_ips), 5)
        
        for i in range(min(num_devices, 8)):
            device_type = devices_mentioned[i] if i < len(devices_mentioned) else random.choice(device_types)
            ip_addr = found_ips[i] if i < len(found_ips) else f"192.168.{random.randint(1, 254)}.{random.randint(1, 254)}"
            
            devices.append({
                "ip_address": ip_addr,
                "device_type": device_type.lower(),
                "hostname": f"{device_type[:3].lower()}-{random.choice(['web', 'db', 'app'])}-{i+1:02d}",
                "location": random.choice(["Data Center A", "Office Floor 1", "Remote Branch"]),
                "last_seen": (datetime.now() - timedelta(minutes=random.randint(1, 1440))).isoformat() + "Z"
            })
        
        logger.info(f"🔧 Extracted partial device info for {company_name}: {len(devices)} devices")
        
        return {
            "total_devices": len(devices),
            "devices": devices,
            "network_summary": f"Extracted network information for {company_name} showing {len(devices)} devices with mixed infrastructure components."
        }
    
    def _extract_summary_info_from_text(self, content: str, company_name: str, operation: str) -> dict:
        """Extract company summary from unstructured text"""
        import re
        
        # Extract industry
        industry_patterns = [
            r'"industry":\s*"([^"]+)"',
            r"Industry[:\s]+([^\n,]+)",
            r"sector[:\s]+([^\n,]+)"
        ]
        
        industry = "Technology"
        for pattern in industry_patterns:
            match = re.search(pattern, content, re.IGNORECASE)
            if match:
                industry = match.group(1).strip()
                break
        
        # Extract country/city
        location_pattern = r'(?:based in|located in|headquarters in)\s+([^,\n]+),?\s*([^,\n]+)'
        location_match = re.search(location_pattern, content, re.IGNORECASE)
        
        if location_match:
            city = location_match.group(1).strip()
            country = location_match.group(2).strip()
        else:
            city = "London"
            country = "United Kingdom"
        
        # Extract business summary (look for longer text blocks)
        summary_lines = [line.strip() for line in content.split('\n') if len(line.strip()) > 50]
        business_summary = summary_lines[0] if summary_lines else f"{company_name} is a leading {industry.lower()} company."
        
        # Extract facts (look for bullet points or numbered items)
        fact_pattern = r'[-•*]\s*([^\n]+)|^\d+\.\s*([^\n]+)'
        facts = []
        for match in re.finditer(fact_pattern, content, re.MULTILINE):
            fact = match.group(1) or match.group(2)
            if fact and len(fact.strip()) > 10:
                facts.append(fact.strip())
        
        if not facts:
            facts = [
                f"Leading {industry.lower()} company",
                f"Headquartered in {city}, {country}",
                "Strong focus on innovation",
                "Global presence and operations"
            ]
        
        logger.info(f"🔧 Extracted partial summary for {company_name}: {industry} company in {city}, {country}")
        
        return {
            "company": {
                "name": company_name,
                "description": f"A leading {industry.lower()} company",
                "industry": industry,
                "founded_year": random.randint(1990, 2020),
                "headquarters": f"{city}, {country}"
            },
            "location": {
                "address": f"{random.randint(1, 999)} Innovation Drive",
                "city": city,
                "country": country,
                "postal_code": f"{random.randint(10000, 99999)}",
                "coordinates": f"{random.uniform(-90, 90):.6f}, {random.uniform(-180, 180):.6f}"
            },
            "business_summary": business_summary,
            "key_facts": facts[:7],  # Limit to 7 facts
            "recent_news": [
                f"{company_name} announces strategic expansion",
                f"Company reports strong quarterly results",
                f"New partnership announced in {industry.lower()} sector"
            ]
        }
    
    def _get_mock_ip_company_response(self, ip_address: str) -> dict:
        """Generate mock response for IP company info when Azure OpenAI is not available"""
        
        companies = [
            {"name": "TechNova Solutions", "industry": "Software Development", "country": "Canada", "city": "Toronto"},
            {"name": "Digital Dynamics Ltd", "industry": "Cloud Computing", "country": "United Kingdom", "city": "London"},
            {"name": "InnovateTech GmbH", "industry": "AI Research", "country": "Germany", "city": "Berlin"},
            {"name": "NextGen Systems", "industry": "Cybersecurity", "country": "Australia", "city": "Sydney"},
            {"name": "CloudWorks Inc", "industry": "Data Analytics", "country": "Netherlands", "city": "Amsterdam"},
        ]
        
        company = random.choice(companies)
        
        return {
            "company": {
                "name": company["name"],
                "description": f"A leading {company['industry'].lower()} company based in {company['city']}, {company['country']}",
                "industry": company["industry"],
                "founded_year": random.randint(2000, 2020),
                "headquarters": f"{company['city']}, {company['country']}"
            },
            "associated_ips": [
                f"192.168.{random.randint(1, 254)}.{random.randint(1, 254)}",
                f"10.0.{random.randint(1, 254)}.{random.randint(1, 254)}",
                f"172.16.{random.randint(1, 254)}.{random.randint(1, 254)}",
                f"203.{random.randint(1, 254)}.{random.randint(1, 254)}.{random.randint(1, 254)}"
            ],
            "location": {
                "address": f"{random.randint(1, 999)} Tech Street",
                "city": company["city"],
                "country": company["country"],
                "postal_code": f"{random.randint(10000, 99999)}",
                "coordinates": f"{random.uniform(-90, 90):.6f}, {random.uniform(-180, 180):.6f}"
            },
            "confidence_score": round(random.uniform(0.7, 0.95), 2)
        }
    
    def _get_mock_company_devices_response(self, company_name: str) -> dict:
        """Generate mock response for company devices when Azure OpenAI is not available"""
        
        device_types = ["server", "router", "workstation", "firewall", "switch", "printer", "storage"]
        locations = ["Data Center A", "Office Floor 1", "Office Floor 2", "Remote Branch", "Cloud Infrastructure"]
        
        devices = []
        num_devices = random.randint(5, 10)
        
        for i in range(num_devices):
            device_type = random.choice(device_types)
            devices.append({
                "ip_address": f"192.168.{random.randint(1, 254)}.{random.randint(1, 254)}",
                "device_type": device_type,
                "hostname": f"{device_type[:3]}-{random.choice(['web', 'db', 'app', 'srv'])}-{i+1:02d}",
                "location": random.choice(locations),
                "last_seen": (datetime.now() - timedelta(minutes=random.randint(1, 1440))).isoformat() + "Z"
            })
        
        return {
            "total_devices": num_devices,
            "devices": devices,
            "network_summary": f"Network infrastructure for {company_name} consists of {num_devices} devices across multiple locations with redundant connectivity and security measures in place."
        }
    
    def _get_mock_company_summary_response(self, company_name: str) -> dict:
        """Generate mock response for company summary when Azure OpenAI is not available"""
        
        industries = ["Technology", "Healthcare", "Finance", "Manufacturing", "Retail", "Education"]
        countries = ["Canada", "United Kingdom", "Germany", "Australia", "Netherlands", "France", "Japan", "Sweden"]
        
        industry = random.choice(industries)
        country = random.choice(countries)
        cities = {
            "Canada": ["Toronto", "Vancouver", "Montreal"],
            "United Kingdom": ["London", "Manchester", "Edinburgh"],
            "Germany": ["Berlin", "Munich", "Hamburg"],
            "Australia": ["Sydney", "Melbourne", "Brisbane"],
            "Netherlands": ["Amsterdam", "Rotterdam", "Utrecht"],
            "France": ["Paris", "Lyon", "Marseille"],
            "Japan": ["Tokyo", "Osaka", "Kyoto"],
            "Sweden": ["Stockholm", "Gothenburg", "Malmö"]
        }
        city = random.choice(cities[country])
        
        return {
            "company": {
                "name": company_name,
                "description": f"A leading {industry.lower()} company specializing in innovative solutions",
                "industry": industry,
                "founded_year": random.randint(1990, 2020),
                "headquarters": f"{city}, {country}"
            },
            "location": {
                "address": f"{random.randint(1, 999)} Innovation Drive",
                "city": city,
                "country": country,
                "postal_code": f"{random.randint(10000, 99999)}",
                "coordinates": f"{random.uniform(-90, 90):.6f}, {random.uniform(-180, 180):.6f}"
            },
            "business_summary": f"{company_name} is a prominent {industry.lower()} company founded in {random.randint(1990, 2020)} and headquartered in {city}, {country}. The company has established itself as a leader in the {industry.lower()} sector through innovative solutions and exceptional customer service. With a focus on cutting-edge technology and sustainable practices, {company_name} continues to expand its global presence while maintaining its commitment to quality and excellence.",
            "key_facts": [
                f"Founded in {random.randint(1990, 2020)} in {city}, {country}",
                f"Employs over {random.randint(100, 5000)} people worldwide",
                f"Operates in {random.randint(5, 25)} countries",
                f"Annual revenue of ${random.randint(10, 500)} million",
                f"Awarded '{industry} Company of the Year' multiple times",
                f"Committed to sustainable business practices",
                f"Investing heavily in R&D and innovation"
            ],
            "recent_news": [
                f"{company_name} announces new partnership with international {industry.lower()} leader",
                f"Company expands operations to new markets in Asia-Pacific region",
                f"{company_name} launches innovative new product line",
                f"Quarterly earnings exceed expectations by 15%",
                f"Company receives sustainability certification for green practices"
            ]
        }
    
    async def generate_ip_company_info(self, ip_address: str) -> dict:
        """Generate fictional company information for a given IP address"""
        prompt = f"""
        Generate fictional information for a company that might be associated with the IP address {ip_address}.
        
        Requirements:
        - The company MUST be located outside the United States
        - Create a realistic but fictional company name
        - Generate 3-5 additional fictional IPv4 addresses associated with this company
        - Provide detailed company information including industry, founding year, headquarters location
        - Include a physical address with city and country (non-US)
        - Generate a confidence score between 0.7-0.95
        
        Return the response in JSON format with the following structure:
        {{
            "company": {{
                "name": "Company Name",
                "description": "Brief company description",
                "industry": "Industry sector",
                "founded_year": 2010,
                "headquarters": "City, Country"
            }},
            "associated_ips": ["192.168.1.1", "10.0.0.1", "172.16.0.1"],
            "location": {{
                "address": "Street address",
                "city": "City name",
                "country": "Country name (non-US)",
                "postal_code": "Postal code",
                "coordinates": "Latitude, Longitude"
            }},
            "confidence_score": 0.85
        }}
        """
        
        try:
            if self.client is not None:
                logger.info(f"🤖 Using Azure OpenAI LLM for IP company info: {ip_address}")
                logger.debug(f"Using model: {settings.azure_openai_deployment_name}")
                
                response = self.client.chat.completions.create(
                    model=settings.azure_openai_deployment_name,
                    messages=[
                        {"role": "system", "content": "You are an expert at generating realistic fictional company information. Always ensure companies are located outside the United States."},
                        {"role": "user", "content": prompt}
                    ],
                    temperature=0.7,
                    max_tokens=1000
                )
                
                content = response.choices[0].message.content
                logger.info(f"✅ Azure OpenAI LLM response received for IP {ip_address}")
                logger.debug(f"Response content length: {len(content) if content else 0}")
                logger.debug(f"Response content preview: {content[:200] if content else 'None'}...")
                
                # Parse JSON response with fault tolerance
                if content and content.strip():
                    parsed_response = self._parse_json_with_fallback(content, ip_address, "IP company info")
                    if parsed_response:
                        logger.info(f"✅ Successfully parsed Azure OpenAI LLM response for IP {ip_address}")
                        return parsed_response
                    else:
                        logger.warning("⚠️ Could not parse any valid data from Azure OpenAI LLM response, falling back to mock")
                        return self._get_mock_ip_company_response(ip_address)
                else:
                    logger.warning("⚠️ Empty response from Azure OpenAI LLM, falling back to mock response")
                    return self._get_mock_ip_company_response(ip_address)
            else:
                logger.info(f"🎭 Using MOCK response for IP company info: {ip_address} (Azure OpenAI not available)")
                return self._get_mock_ip_company_response(ip_address)
            
        except json.JSONDecodeError as e:
            # This shouldn't happen anymore since we moved to _parse_json_with_fallback
            logger.error(f"❌ Unexpected JSON parsing error for IP {ip_address}: {e}")
            logger.warning("🎭 Falling back to MOCK response due to JSON parsing error")
            return self._get_mock_ip_company_response(ip_address)
        except Exception as e:
            logger.error(f"❌ Error calling Azure OpenAI LLM for IP {ip_address}: {type(e).__name__}: {e}")
            
            # Try to extract any partial information from the error context if available
            if hasattr(e, 'response') and hasattr(e.response, 'text'):
                try:
                    partial_response = self._parse_json_with_fallback(e.response.text, ip_address, "IP company info (error recovery)")
                    if partial_response:
                        logger.info(f"🔧 Recovered partial data from error response for IP {ip_address}")
                        return partial_response
                except:
                    pass
            
            logger.warning("🎭 Falling back to MOCK response due to API error")
            return self._get_mock_ip_company_response(ip_address)
    
    async def generate_company_devices(self, company_name: str) -> dict:
        """Generate fictional device information for a given company"""
        prompt = f"""
        Generate fictional network device information for the company "{company_name}".
        
        Requirements:
        - Generate 5-10 fictional devices with unique IPv4 addresses
        - Include various device types (servers, routers, workstations, firewalls, etc.)
        - Each device should have a realistic hostname
        - Include physical locations for devices
        - Generate recent timestamps for "last_seen"
        - Provide a network summary
        
        Return the response in JSON format with the following structure:
        {{
            "total_devices": 7,
            "devices": [
                {{
                    "ip_address": "192.168.1.100",
                    "device_type": "server",
                    "hostname": "srv-web-01",
                    "location": "Data Center A",
                    "last_seen": "2024-12-15T14:30:00Z"
                }}
            ],
            "network_summary": "Company network infrastructure summary"
        }}
        """
        
        try:
            if self.client is not None:
                logger.info(f"🤖 Using Azure OpenAI LLM for company devices: {company_name}")
                response = self.client.chat.completions.create(
                    model=settings.azure_openai_deployment_name,
                    messages=[
                        {"role": "system", "content": "You are an expert at generating realistic fictional network infrastructure information."},
                        {"role": "user", "content": prompt}
                    ],
                    temperature=0.7,
                    max_tokens=1200
                )
                
                content = response.choices[0].message.content
                logger.info(f"✅ Azure OpenAI LLM response received for company devices: {company_name}")
                
                # Parse JSON response with fault tolerance
                if content and content.strip():
                    parsed_response = self._parse_json_with_fallback(content, company_name, "company devices")
                    if parsed_response:
                        logger.info(f"✅ Successfully parsed Azure OpenAI LLM response for company devices: {company_name}")
                        return parsed_response
                    else:
                        logger.warning("⚠️ Could not parse any valid data from Azure OpenAI LLM response, falling back to mock")
                        return self._get_mock_company_devices_response(company_name)
                else:
                    logger.warning("⚠️ Empty response from Azure OpenAI LLM, falling back to mock response")
                    return self._get_mock_company_devices_response(company_name)
            else:
                logger.info(f"🎭 Using MOCK response for company devices: {company_name} (Azure OpenAI not available)")
                return self._get_mock_company_devices_response(company_name)
            
        except json.JSONDecodeError as e:
            # This shouldn't happen anymore since we moved to _parse_json_with_fallback
            logger.error(f"❌ Unexpected JSON parsing error for company devices {company_name}: {e}")
            logger.warning("🎭 Falling back to MOCK response due to JSON parsing error")
            return self._get_mock_company_devices_response(company_name)
        except Exception as e:
            logger.error(f"❌ Error calling Azure OpenAI LLM for company devices {company_name}: {type(e).__name__}: {e}")
            logger.warning("🎭 Falling back to MOCK response due to API error")
            return self._get_mock_company_devices_response(company_name)
    
    async def generate_company_summary(self, company_name: str) -> dict:
        """Generate fictional company summary and location information"""
        prompt = f"""
        Generate a comprehensive fictional summary for the company "{company_name}".
        
        Requirements:
        - Create detailed company information (name, description, industry, founding year, headquarters)
        - Company MUST be located outside the United States
        - Generate a detailed business summary (200-300 words)
        - Include 5-7 key facts about the company
        - Create 3-5 fictional recent news items
        - Provide complete location information with address, city, country, postal code
        
        Return the response in JSON format with the following structure:
        {{
            "company": {{
                "name": "Company Name",
                "description": "Brief company description",
                "industry": "Industry sector",
                "founded_year": 2010,
                "headquarters": "City, Country"
            }},
            "location": {{
                "address": "Street address",
                "city": "City name",
                "country": "Country name (non-US)",
                "postal_code": "Postal code",
                "coordinates": "Latitude, Longitude"
            }},
            "business_summary": "Detailed business summary...",
            "key_facts": ["Fact 1", "Fact 2", "Fact 3"],
            "recent_news": ["News item 1", "News item 2", "News item 3"]
        }}
        """
        
        try:
            if self.client is not None:
                logger.info(f"🤖 Using Azure OpenAI LLM for company summary: {company_name}")
                response = self.client.chat.completions.create(
                    model=settings.azure_openai_deployment_name,
                    messages=[
                        {"role": "system", "content": "You are an expert at generating comprehensive fictional company profiles. Always ensure companies are located outside the United States."},
                        {"role": "user", "content": prompt}
                    ],
                    temperature=0.7,
                    max_tokens=1500
                )
                
                content = response.choices[0].message.content
                logger.info(f"✅ Azure OpenAI LLM response received for company summary: {company_name}")
                
                # Parse JSON response with fault tolerance
                if content and content.strip():
                    parsed_response = self._parse_json_with_fallback(content, company_name, "company summary")
                    if parsed_response:
                        logger.info(f"✅ Successfully parsed Azure OpenAI LLM response for company summary: {company_name}")
                        return parsed_response
                    else:
                        logger.warning("⚠️ Could not parse any valid data from Azure OpenAI LLM response, falling back to mock")
                        return self._get_mock_company_summary_response(company_name)
                else:
                    logger.warning("⚠️ Empty response from Azure OpenAI LLM, falling back to mock response")
                    return self._get_mock_company_summary_response(company_name)
            else:
                logger.info(f"🎭 Using MOCK response for company summary: {company_name} (Azure OpenAI not available)")
                return self._get_mock_company_summary_response(company_name)
            
        except json.JSONDecodeError as e:
            # This shouldn't happen anymore since we moved to _parse_json_with_fallback
            logger.error(f"❌ Unexpected JSON parsing error for company summary {company_name}: {e}")
            logger.warning("🎭 Falling back to MOCK response due to JSON parsing error")
            return self._get_mock_company_summary_response(company_name)
        except Exception as e:
            logger.error(f"❌ Error calling Azure OpenAI LLM for company summary {company_name}: {type(e).__name__}: {e}")
            logger.warning("🎭 Falling back to MOCK response due to API error")
            return self._get_mock_company_summary_response(company_name)

# Global service instance
azure_openai_service = AzureOpenAIService()
