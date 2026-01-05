#!/usr/bin/env python3
"""
Fictional Company Document Generator

This script generates fictional company documents using Azure OpenAI GPT-4o endpoint.
Creates financial reports, board of directors information, and key personnel data
in multiple languages and outputs them as PDF documents.

Author: AI Assistant
Date: 2025-07-29
"""

import os
import json
import asyncio
import logging
import re
from datetime import datetime
from typing import Dict, List, Optional
from dataclasses import dataclass
from pathlib import Path

# Azure OpenAI imports
from openai import AsyncAzureOpenAI
from azure.identity import DefaultAzureCredential, ManagedIdentityCredential
from azure.core.exceptions import AzureError

# Load environment variables
from dotenv import load_dotenv
load_dotenv()

# PDF generation imports
from reportlab.lib.pagesizes import letter, A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.pdfbase import pdfutils
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('document_generator.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

@dataclass
class CompanyData:
    """Data structure for company information"""
    name: str
    industry: str
    founded_year: int
    headquarters: str
    employees: int
    revenue: str
    ceo: str
    board_members: List[Dict[str, str]]
    key_personnel: List[Dict[str, str]]
    financial_data: Dict[str, any]

class AzureOpenAIClient:
    """Azure OpenAI client with API key authentication"""
    
    def __init__(self, endpoint: str, api_key: str, api_version: str = "2024-02-01"):
        self.endpoint = endpoint
        self.api_key = api_key
        self.api_version = api_version
        self.client = None
        self._initialize_client()
    
    def _initialize_client(self):
        """Initialize Azure OpenAI client with API key"""
        try:
            self.client = AsyncAzureOpenAI(
                azure_endpoint=self.endpoint,
                api_key=self.api_key,
                api_version=self.api_version
            )
            logger.info("Azure OpenAI client initialized successfully with API key")
            
        except Exception as e:
            logger.error(f"Failed to initialize Azure OpenAI client: {e}")
            raise
    
    async def generate_company_data(self, language: str, company_type: str) -> CompanyData:
        """Generate fictional company data using GPT-4o"""
        
        # Language-specific prompts
        language_instructions = {
            "chinese": "请用中文生成",
            "russian": "Пожалуйста, генерируйте на русском языке",
            "arabic": "يرجى التوليد باللغة العربية",
            "korean": "한국어로 생성해 주세요",
            "spanish": "Por favor, genere en español",
            "french": "Veuillez générer en français"
        }
        
        prompt = f"""
        {language_instructions.get(language, "Please generate in English")}
        
        Create a completely fictional company with the following details. 
        Make sure all names, numbers, and information are clearly fictional and do not represent any real company or person.
        
        Company Type: {company_type}
        
        Generate the following information in free-form text format:
        
        COMPANY OVERVIEW:
        - Company name (creative and fictional)
        - Industry sector
        - Year founded (between 1990-2020)
        - Headquarters location
        - Number of employees (realistic for company size)
        - Annual revenue (in local currency)
        
        CEO:
        - Full name (fictional and culturally appropriate)
        
        BOARD OF DIRECTORS:
        List 5-7 board members with their names, titles, and brief backgrounds
        
        KEY PERSONNEL:
        List 8-10 key personnel with their names, positions, and departments
        
        FINANCIAL DATA:
        - Quarterly revenues for last 4 quarters
        - Profit margins
        - Total assets
        - Total liabilities
        - Market capitalization
        
        Please use clear section headers and present the information in a readable format.
        All names must be fictional and culturally appropriate for the language.
        """
        
        try:
            response = await self.client.chat.completions.create(
                model="gpt-4o",  # Ensure you're using the correct deployment name
                messages=[
                    {"role": "system", "content": "You are an expert in creating detailed fictional company profiles. Always generate completely fictional information that cannot be confused with real companies or people. Format your responses with clear section headers and readable structure."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.8,
                max_tokens=4000
            )
            
            # Get the free-form text response
            content = response.choices[0].message.content
            
            # Parse the free-form text to extract key information
            company_data = self._parse_company_text(content, language)
            
            logger.info(f"Generated company data for {company_data.name} in {language}")
            return company_data
            
        except Exception as e:
            logger.error(f"Failed to generate company data: {e}")
            raise
    
    def _parse_company_text(self, text: str, language: str) -> CompanyData:
        """Parse free-form text response to extract company data"""
        
        # Initialize default values
        company_name = "Unknown Corporation"
        industry = "Technology"
        founded_year = 2000
        headquarters = "Unknown City"
        employees = 100
        revenue = "$1M"
        ceo = "John Doe"
        board_members = []
        key_personnel = []
        financial_data = {}
        
        try:
            lines = text.split('\n')
            current_section = None
            
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                
                # Detect section headers
                line_upper = line.upper()
                if 'COMPANY OVERVIEW' in line_upper or 'OVERVIEW' in line_upper:
                    current_section = 'overview'
                    continue
                elif 'CEO' in line_upper and 'BOARD' not in line_upper:
                    current_section = 'ceo'
                    continue
                elif 'BOARD' in line_upper:
                    current_section = 'board'
                    continue
                elif 'KEY PERSONNEL' in line_upper or 'PERSONNEL' in line_upper or 'STAFF' in line_upper:
                    current_section = 'personnel'
                    continue
                elif 'FINANCIAL' in line_upper or 'FINANCE' in line_upper:
                    current_section = 'financial'
                    continue
                
                # Parse content based on current section
                if current_section == 'overview':
                    if 'company name' in line.lower() or 'name:' in line.lower():
                        company_name = self._extract_value_after_colon(line) or company_name
                    elif 'industry' in line.lower():
                        industry = self._extract_value_after_colon(line) or industry
                    elif 'founded' in line.lower() or 'year' in line.lower():
                        year_text = self._extract_value_after_colon(line)
                        if year_text:
                            # Extract year from text
                            year_match = re.search(r'\b(19|20)\d{2}\b', year_text)
                            if year_match:
                                founded_year = int(year_match.group())
                    elif 'headquarters' in line.lower() or 'location' in line.lower():
                        headquarters = self._extract_value_after_colon(line) or headquarters
                    elif 'employees' in line.lower():
                        emp_text = self._extract_value_after_colon(line)
                        if emp_text:
                            # Extract number from text
                            emp_match = re.search(r'[\d,]+', emp_text.replace(',', ''))
                            if emp_match:
                                employees = int(emp_match.group().replace(',', ''))
                    elif 'revenue' in line.lower():
                        revenue = self._extract_value_after_colon(line) or revenue
                
                elif current_section == 'ceo':
                    if ':' in line:
                        ceo = self._extract_value_after_colon(line) or ceo
                    elif line and not line.startswith('-'):
                        ceo = line
                
                elif current_section == 'board':
                    if line.startswith('-') or line.startswith('•') or line.startswith('*'):
                        member_info = line.lstrip('-•* ').strip()
                        if member_info:
                            # Try to parse name and title
                            parts = member_info.split('-', 1)
                            if len(parts) >= 2:
                                name = parts[0].strip()
                                title_background = parts[1].strip()
                                title_parts = title_background.split(',', 1)
                                title = title_parts[0].strip()
                                background = title_parts[1].strip() if len(title_parts) > 1 else ""
                            else:
                                name = member_info
                                title = "Board Member"
                                background = ""
                            
                            board_members.append({
                                "name": name,
                                "title": title,
                                "background": background
                            })
                
                elif current_section == 'personnel':
                    if line.startswith('-') or line.startswith('•') or line.startswith('*'):
                        person_info = line.lstrip('-•* ').strip()
                        if person_info:
                            # Try to parse name, position, and department
                            parts = person_info.split('-', 1)
                            if len(parts) >= 2:
                                name = parts[0].strip()
                                pos_dept = parts[1].strip()
                                pos_parts = pos_dept.split(',', 1)
                                position = pos_parts[0].strip()
                                department = pos_parts[1].strip() if len(pos_parts) > 1 else "General"
                            else:
                                name = person_info
                                position = "Manager"
                                department = "General"
                            
                            key_personnel.append({
                                "name": name,
                                "position": position,
                                "department": department
                            })
                
                elif current_section == 'financial':
                    if ':' in line:
                        key = line.split(':', 1)[0].strip()
                        value = line.split(':', 1)[1].strip()
                        financial_data[key.lower().replace(' ', '_')] = value
            
            # Create and return CompanyData object
            return CompanyData(
                name=company_name,
                industry=industry,
                founded_year=founded_year,
                headquarters=headquarters,
                employees=employees,
                revenue=revenue,
                ceo=ceo,
                board_members=board_members,
                key_personnel=key_personnel,
                financial_data=financial_data
            )
            
        except Exception as e:
            logger.warning(f"Error parsing company text, using defaults: {e}")
            # Return default CompanyData if parsing fails
            return CompanyData(
                name=company_name,
                industry=industry,
                founded_year=founded_year,
                headquarters=headquarters,
                employees=employees,
                revenue=revenue,
                ceo=ceo,
                board_members=board_members,
                key_personnel=key_personnel,
                financial_data=financial_data
            )
    
    def _extract_value_after_colon(self, line: str) -> Optional[str]:
        """Extract value after colon in a line"""
        if ':' in line:
            return line.split(':', 1)[1].strip()
        return None

class PDFGenerator:
    """Generate PDF documents for company information"""
    
    def __init__(self, output_dir: str = "output"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True)
        self._setup_fonts()
    
    def _setup_fonts(self):
        """Setup fonts for multi-language support"""
        try:
            # Register fonts for different languages
            # Note: In production, you would download and register proper font files
            # For now, we'll use the default fonts
            self.styles = getSampleStyleSheet()
            
            # Create custom styles for different document sections
            self.styles.add(ParagraphStyle(
                name='CompanyHeader',
                parent=self.styles['Heading1'],
                fontSize=24,
                spaceAfter=30,
                textColor=colors.navy
            ))
            
            self.styles.add(ParagraphStyle(
                name='SectionHeader',
                parent=self.styles['Heading2'],
                fontSize=16,
                spaceAfter=12,
                textColor=colors.darkblue
            ))
            
        except Exception as e:
            logger.warning(f"Font setup warning: {e}")
    
    def create_financial_report(self, company: CompanyData, language: str) -> str:
        """Create a financial report PDF"""
        
        filename = f"financial_report_{company.name.replace(' ', '_')}_{language}.pdf"
        filepath = self.output_dir / filename
        
        try:
            doc = SimpleDocTemplate(str(filepath), pagesize=A4)
            story = []
            
            # Title
            title = Paragraph(f"Financial Report - {company.name}", self.styles['CompanyHeader'])
            story.append(title)
            story.append(Spacer(1, 20))
            
            # Company Overview
            overview_title = Paragraph("Company Overview", self.styles['SectionHeader'])
            story.append(overview_title)
            
            overview_data = [
                ["Industry:", company.industry],
                ["Founded:", str(company.founded_year)],
                ["Headquarters:", company.headquarters],
                ["Employees:", f"{company.employees:,}"],
                ["Annual Revenue:", company.revenue]
            ]
            
            overview_table = Table(overview_data, colWidths=[2*inch, 4*inch])
            overview_table.setStyle(TableStyle([
                ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
                ('FONTNAME', (1, 0), (1, -1), 'Helvetica'),
                ('FONTSIZE', (0, 0), (-1, -1), 12),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 12),
            ]))
            
            story.append(overview_table)
            story.append(Spacer(1, 30))
            
            # Financial Data
            if company.financial_data:
                financial_title = Paragraph("Financial Performance", self.styles['SectionHeader'])
                story.append(financial_title)
                
                # Create financial data table
                financial_items = []
                for key, value in company.financial_data.items():
                    financial_items.append([key.replace('_', ' ').title(), str(value)])
                
                if financial_items:
                    financial_table = Table(financial_items, colWidths=[3*inch, 3*inch])
                    financial_table.setStyle(TableStyle([
                        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                        ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
                        ('FONTNAME', (1, 0), (1, -1), 'Helvetica'),
                        ('FONTSIZE', (0, 0), (-1, -1), 11),
                        ('GRID', (0, 0), (-1, -1), 1, colors.black),
                        ('BACKGROUND', (0, 0), (-1, 0), colors.lightgrey),
                    ]))
                    story.append(financial_table)
            
            # Build PDF
            doc.build(story)
            logger.info(f"Created financial report: {filepath}")
            return str(filepath)
            
        except Exception as e:
            logger.error(f"Failed to create financial report: {e}")
            raise
    
    def create_board_report(self, company: CompanyData, language: str) -> str:
        """Create a board of directors report PDF"""
        
        filename = f"board_report_{company.name.replace(' ', '_')}_{language}.pdf"
        filepath = self.output_dir / filename
        
        try:
            doc = SimpleDocTemplate(str(filepath), pagesize=A4)
            story = []
            
            # Title
            title = Paragraph(f"Board of Directors - {company.name}", self.styles['CompanyHeader'])
            story.append(title)
            story.append(Spacer(1, 20))
            
            # CEO Information
            ceo_title = Paragraph("Chief Executive Officer", self.styles['SectionHeader'])
            story.append(ceo_title)
            ceo_info = Paragraph(f"<b>{company.ceo}</b>", self.styles['Normal'])
            story.append(ceo_info)
            story.append(Spacer(1, 20))
            
            # Board Members
            if company.board_members:
                board_title = Paragraph("Board Members", self.styles['SectionHeader'])
                story.append(board_title)
                
                board_data = [["Name", "Title", "Background"]]
                for member in company.board_members:
                    board_data.append([
                        member.get("name", ""),
                        member.get("title", ""),
                        member.get("background", "")
                    ])
                
                board_table = Table(board_data, colWidths=[2*inch, 2*inch, 2*inch])
                board_table.setStyle(TableStyle([
                    ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                    ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
                    ('FONTSIZE', (0, 0), (-1, -1), 10),
                    ('GRID', (0, 0), (-1, -1), 1, colors.black),
                    ('BACKGROUND', (0, 0), (-1, 0), colors.lightgrey),
                    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ]))
                story.append(board_table)
            
            # Build PDF
            doc.build(story)
            logger.info(f"Created board report: {filepath}")
            return str(filepath)
            
        except Exception as e:
            logger.error(f"Failed to create board report: {e}")
            raise
    
    def create_personnel_report(self, company: CompanyData, language: str) -> str:
        """Create a key personnel report PDF"""
        
        filename = f"personnel_report_{company.name.replace(' ', '_')}_{language}.pdf"
        filepath = self.output_dir / filename
        
        try:
            doc = SimpleDocTemplate(str(filepath), pagesize=A4)
            story = []
            
            # Title
            title = Paragraph(f"Key Personnel - {company.name}", self.styles['CompanyHeader'])
            story.append(title)
            story.append(Spacer(1, 20))
            
            # Key Personnel
            if company.key_personnel:
                personnel_title = Paragraph("Executive Team", self.styles['SectionHeader'])
                story.append(personnel_title)
                
                personnel_data = [["Name", "Position", "Department"]]
                for person in company.key_personnel:
                    personnel_data.append([
                        person.get("name", ""),
                        person.get("position", ""),
                        person.get("department", "")
                    ])
                
                personnel_table = Table(personnel_data, colWidths=[2*inch, 2.5*inch, 1.5*inch])
                personnel_table.setStyle(TableStyle([
                    ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                    ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
                    ('FONTSIZE', (0, 0), (-1, -1), 10),
                    ('GRID', (0, 0), (-1, -1), 1, colors.black),
                    ('BACKGROUND', (0, 0), (-1, 0), colors.lightgrey),
                    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ]))
                story.append(personnel_table)
            
            # Build PDF
            doc.build(story)
            logger.info(f"Created personnel report: {filepath}")
            return str(filepath)
            
        except Exception as e:
            logger.error(f"Failed to create personnel report: {e}")
            raise

class DocumentGenerator:
    """Main document generator orchestrator"""
    
    def __init__(self, azure_endpoint: str, api_key: str, output_dir: str = "output"):
        self.azure_client = AzureOpenAIClient(azure_endpoint, api_key)
        self.pdf_generator = PDFGenerator(output_dir)
        self.supported_languages = ["chinese", "russian", "arabic", "korean", "spanish", "french"]
        self.company_types = ["technology", "finance", "healthcare", "manufacturing", "retail"]
    
    async def generate_company_documents(self, language: str, company_type: str = None) -> Dict[str, str]:
        """Generate all documents for a fictional company"""
        
        if language not in self.supported_languages:
            raise ValueError(f"Language {language} not supported. Supported: {self.supported_languages}")
        
        if not company_type:
            company_type = "technology"  # Default
        
        try:
            # Generate company data
            logger.info(f"Generating company data for {language} {company_type} company")
            company_data = await self.azure_client.generate_company_data(language, company_type)
            
            # Generate PDF documents
            documents = {}
            
            logger.info("Creating financial report PDF")
            documents["financial"] = self.pdf_generator.create_financial_report(company_data, language)
            
            logger.info("Creating board report PDF")
            documents["board"] = self.pdf_generator.create_board_report(company_data, language)
            
            logger.info("Creating personnel report PDF")
            documents["personnel"] = self.pdf_generator.create_personnel_report(company_data, language)
            
            logger.info(f"Successfully generated all documents for {company_data.name}")
            return documents
            
        except Exception as e:
            logger.error(f"Failed to generate company documents: {e}")
            raise
    
    async def generate_multiple_companies(self, languages: List[str], companies_per_language: int = 1) -> Dict[str, List[Dict[str, str]]]:
        """Generate documents for multiple companies across different languages"""
        
        results = {}
        
        for language in languages:
            if language not in self.supported_languages:
                logger.warning(f"Skipping unsupported language: {language}")
                continue
                
            results[language] = []
            
            for i in range(companies_per_language):
                try:
                    company_type = self.company_types[i % len(self.company_types)]
                    logger.info(f"Generating company {i+1}/{companies_per_language} for {language}")
                    
                    documents = await self.generate_company_documents(language, company_type)
                    results[language].append(documents)
                    
                    # Add delay to avoid rate limiting
                    await asyncio.sleep(2)
                    
                except Exception as e:
                    logger.error(f"Failed to generate company {i+1} for {language}: {e}")
                    continue
        
        return results

async def main():
    """Main execution function"""
    
    # Configuration - these should be set as environment variables
    azure_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
    api_key = os.getenv("AZURE_OPENAI_API_KEY")
    
    if not azure_endpoint:
        logger.error("AZURE_OPENAI_ENDPOINT environment variable is required")
        return
        
    if not api_key:
        logger.error("AZURE_OPENAI_API_KEY environment variable is required")
        return
    
    try:
        # Initialize document generator
        generator = DocumentGenerator(azure_endpoint, api_key)
        
        # Example: Generate documents for one company in each language
        languages = ["spanish", "french", "chinese"]  # Start with a subset for testing
        
        logger.info("Starting document generation process")
        results = await generator.generate_multiple_companies(languages, companies_per_language=1)
        
        # Print summary
        print("\n" + "="*50)
        print("DOCUMENT GENERATION SUMMARY")
        print("="*50)
        
        for language, companies in results.items():
            print(f"\n{language.upper()}:")
            for i, documents in enumerate(companies, 1):
                print(f"  Company {i}:")
                for doc_type, filepath in documents.items():
                    print(f"    {doc_type}: {filepath}")
        
        print(f"\nTotal documents generated: {sum(len(companies) * 3 for companies in results.values())}")
        print("All documents saved in the 'output' directory")
        
    except Exception as e:
        logger.error(f"Application failed: {e}")
        raise

if __name__ == "__main__":
    # Run the async main function
    asyncio.run(main())
