
#!/usr/bin/env python3
"""
Government Contract Project Data Generator

This script generates comprehensive fictional data for government contract projects
including financial information, personnel, spend plans, actuals, and project details.
The generated data can be used to populate a RAG (Retrieval-Augmented Generation) engine
for testing and development of government contract financial analysis systems.
"""

import json
import random
import csv
from datetime import datetime, timedelta
from typing import Dict, List, Any
import os
from openai import OpenAI
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configuration
NUM_PROJECTS = 10  # Match the number of projects in the app
OUTPUT_DIR = "generated_project_data"
START_DATE = datetime(2022, 1, 1)
END_DATE = datetime(2026, 12, 31)

# Initialize OpenAI client
client = OpenAI(
    api_key=os.getenv("REACT_APP_OPENAI_API_KEY"),
    base_url=os.getenv("REACT_APP_OPENAI_ENDPOINT") + "/openai/deployments/" + os.getenv("REACT_APP_OPENAI_DEPLOYMENT"),
    default_headers={"api-key": os.getenv("REACT_APP_OPENAI_API_KEY")},
    default_query={"api-version": "2024-02-15-preview"}
)

# Project definitions from the app
APP_PROJECTS = [
    { 'id': 'PROJ-001', 'name': 'Defense Communications System', 'wbs': 'WBS-001' },
    { 'id': 'PROJ-002', 'name': 'Infrastructure Modernization', 'wbs': 'WBS-002' },
    { 'id': 'PROJ-003', 'name': 'Cybersecurity Enhancement', 'wbs': 'WBS-003' },
    { 'id': 'PROJ-004', 'name': 'Logistics Management System', 'wbs': 'WBS-004' },
    { 'id': 'PROJ-005', 'name': 'Training Platform Development', 'wbs': 'WBS-005' },
    { 'id': 'PROJ-006', 'name': 'Data Analytics Platform', 'wbs': 'WBS-006' },
    { 'id': 'PROJ-007', 'name': 'Emergency Response System', 'wbs': 'WBS-007' },
    { 'id': 'PROJ-008', 'name': 'Fleet Management Upgrade', 'wbs': 'WBS-008' },
    { 'id': 'PROJ-009', 'name': 'Facility Security Enhancement', 'wbs': 'WBS-009' },
    { 'id': 'PROJ-010', 'name': 'Network Infrastructure Upgrade', 'wbs': 'WBS-010' }
]

# Reference data for realistic generation
CONTRACT_TYPES = ["FFP", "CPFF", "CPIF", "T&M", "IDIQ", "GSA Schedule", "BPA"]

PROJECT_TYPES = [
    "IT Modernization", "Cybersecurity Enhancement", "Infrastructure Development",
    "Software Development", "Data Analytics Platform", "Cloud Migration",
    "Network Upgrade", "Training Program", "Research & Development",
    "Facility Maintenance", "Equipment Procurement", "Consulting Services"
]

LABOR_CATEGORIES = [
    {"name": "Project Manager", "rate": 165.50, "overhead": 0.45},
    {"name": "Senior Software Engineer", "rate": 142.75, "overhead": 0.42},
    {"name": "Software Engineer", "rate": 118.25, "overhead": 0.42},
    {"name": "Systems Analyst", "rate": 125.00, "overhead": 0.40},
    {"name": "Database Administrator", "rate": 135.50, "overhead": 0.41},
    {"name": "Security Specialist", "rate": 155.00, "overhead": 0.43},
    {"name": "Business Analyst", "rate": 110.75, "overhead": 0.38},
    {"name": "Quality Assurance", "rate": 95.25, "overhead": 0.35},
    {"name": "Technical Writer", "rate": 85.50, "overhead": 0.32},
    {"name": "DevOps Engineer", "rate": 148.00, "overhead": 0.44}
]

EXPENSE_CATEGORIES = [
    "Labor", "Materials", "Travel", "Equipment", "Software Licenses",
    "Training", "Facilities", "Overhead", "Subcontractor", "Other Direct Costs"
]

RISK_LEVELS = ["Low", "Medium", "High", "Critical"]

PERFORMANCE_METRICS = [
    "Schedule Performance Index", "Cost Performance Index", "Quality Metrics",
    "Customer Satisfaction", "Milestone Achievement", "Budget Utilization"
]

def generate_with_llm(prompt: str, max_tokens: int = 200) -> str:
    """Generate content using OpenAI API"""
    try:
        response = client.chat.completions.create(
            model=os.getenv("REACT_APP_OPENAI_DEPLOYMENT"),
            messages=[
                {"role": "system", "content": "You are a helpful assistant that generates realistic government contract project data."},
                {"role": "user", "content": prompt}
            ],
            max_tokens=max_tokens,
            temperature=0.7
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        print(f"LLM generation failed: {e}")
        return "Generated content not available"

def generate_realistic_names(count: int) -> List[str]:
    """Generate realistic person names using LLM"""
    prompt = f"Generate {count} realistic full names for government employees (mix of genders and ethnicities). Return only the names, one per line, no additional text."
    try:
        response = generate_with_llm(prompt, max_tokens=150)
        names = [name.strip() for name in response.split('\n') if name.strip()]
        # Fallback if LLM doesn't return enough names
        while len(names) < count:
            names.append(f"Employee_{len(names)+1:02d}")
        return names[:count]
    except:
        return [f"Employee_{i+1:02d}" for i in range(count)]

def generate_company_names(count: int) -> List[str]:
    """Generate realistic contractor company names using LLM"""
    prompt = f"Generate {count} realistic names for government contracting companies. Include a mix of technology, consulting, and defense contractors. Return only company names, one per line, no additional text."
    try:
        response = generate_with_llm(prompt, max_tokens=200)
        companies = [company.strip() for company in response.split('\n') if company.strip()]
        # Fallback if LLM doesn't return enough names
        while len(companies) < count:
            companies.append(f"Contractor_{len(companies)+1:02d} Technologies Inc.")
        return companies[:count]
    except:
        return [f"Contractor_{i+1:02d} Technologies Inc." for i in range(count)]

def generate_project_description(project_name: str) -> str:
    """Generate detailed project description using LLM"""
    prompt = f"Generate a detailed, realistic description for a government contract project called '{project_name}'. Include specific technical details, objectives, deliverables, and expected outcomes. Keep it professional and government-appropriate. Maximum 3 paragraphs."
    try:
        return generate_with_llm(prompt, max_tokens=300)
    except:
        return f"Government project for {project_name.lower()} to enhance operations and service delivery."

def generate_milestone_descriptions(project_name: str, count: int) -> List[str]:
    """Generate realistic milestone descriptions for a project"""
    prompt = f"Generate {count} realistic milestone descriptions for a government project called '{project_name}'. Each milestone should be specific and measurable. Return only the milestone names, one per line, no additional text."
    try:
        response = generate_with_llm(prompt, max_tokens=200)
        milestones = [milestone.strip() for milestone in response.split('\n') if milestone.strip()]
        # Fallback if LLM doesn't return enough milestones
        while len(milestones) < count:
            milestones.append(f"Milestone {len(milestones)+1}")
        return milestones[:count]
    except:
        return [f"Milestone {i+1}" for i in range(count)]

def generate_risk_explanations(project_name: str) -> Dict[str, str]:
    """Generate realistic risk explanations for a project"""
    prompt = f"For a government project called '{project_name}', generate brief explanations for schedule risk, budget risk, and technical risk. Format as 'Schedule Risk: explanation\\nBudget Risk: explanation\\nTechnical Risk: explanation'. Keep each explanation to 1-2 sentences."
    try:
        response = generate_with_llm(prompt, max_tokens=250)
        risks = {}
        for line in response.split('\n'):
            if ':' in line:
                risk_type, explanation = line.split(':', 1)
                risks[risk_type.strip().lower().replace(' ', '_')] = explanation.strip()
        return risks
    except:
        return {
            'schedule_risk': 'Standard project timeline considerations',
            'budget_risk': 'Normal budget variance expectations',
            'technical_risk': 'Standard technical implementation risks'
        }

# Cache for generated data to avoid repeated API calls
_generated_names_cache = []
_generated_companies_cache = []

def generate_project_id() -> str:
    """Generate a realistic government project ID"""
    # This function is no longer needed since we're using predefined IDs
    # but keeping it for backward compatibility
    agency_code = random.choice(["DOD", "DHS", "DOE", "DOC", "DOT", "VA", "GSA", "NASA", "EPA", "HHS"])
    year = random.randint(2022, 2025)
    sequence = random.randint(1000, 9999)
    return f"{agency_code}-{year}-{sequence}"

def generate_wbs_structure(project_name: str, wbs_code: str) -> List[Dict[str, Any]]:
    """Generate a Work Breakdown Structure for a specific project"""
    wbs_items = []
    
    # Define project-specific phases based on project type
    phase_mapping = {
        'Defense Communications System': [
            "Requirements Analysis", "System Design", "Hardware Procurement", 
            "Software Development", "Integration & Testing", "Deployment", "Training & Support"
        ],
        'Infrastructure Modernization': [
            "Assessment & Planning", "Design & Architecture", "Infrastructure Upgrade", 
            "System Migration", "Testing & Validation", "Cutover & Deployment"
        ],
        'Cybersecurity Enhancement': [
            "Security Assessment", "Threat Analysis", "Security Design", 
            "Implementation", "Testing & Validation", "Monitoring & Maintenance"
        ],
        'Logistics Management System': [
            "Business Analysis", "System Design", "Development", 
            "Integration", "Testing", "Deployment", "Training"
        ],
        'Training Platform Development': [
            "Learning Analysis", "Content Development", "Platform Development", 
            "Content Integration", "Testing", "Deployment", "User Training"
        ],
        'Data Analytics Platform': [
            "Data Assessment", "Platform Design", "Development", 
            "Data Integration", "Testing", "Deployment", "Analytics Training"
        ],
        'Emergency Response System': [
            "Requirements Analysis", "System Design", "Development", 
            "Integration", "Testing", "Deployment", "Emergency Training"
        ],
        'Fleet Management Upgrade': [
            "Fleet Assessment", "System Design", "Development", 
            "Vehicle Integration", "Testing", "Deployment", "Training"
        ],
        'Facility Security Enhancement': [
            "Security Assessment", "Design", "Equipment Procurement", 
            "Installation", "Testing", "Certification", "Training"
        ],
        'Network Infrastructure Upgrade': [
            "Network Assessment", "Design", "Equipment Procurement", 
            "Installation", "Testing", "Cutover", "Documentation"
        ]
    }
    
    phases = phase_mapping.get(project_name, [
        "Planning & Design", "Development", "Testing & Integration", 
        "Deployment", "Operations & Maintenance"
    ])
    
    for i, phase in enumerate(phases, 1):
        wbs_level1 = f"{wbs_code}.{i}"
        phase_budget = random.randint(100000, 800000)
        
        wbs_items.append({
            "wbs_code": wbs_level1,
            "title": phase,
            "level": 1,
            "budget_allocated": phase_budget,
            "budget_committed": phase_budget * random.uniform(0.7, 1.0),
            "budget_obligated": phase_budget * random.uniform(0.5, 0.8),
            "budget_expended": phase_budget * random.uniform(0.3, 0.7),
            "start_date": (START_DATE + timedelta(days=i*60)).strftime("%Y-%m-%d"),
            "end_date": (START_DATE + timedelta(days=(i+1)*60)).strftime("%Y-%m-%d"),
            "responsible_manager": f"Manager_{i}",
            "status": random.choice(["Not Started", "In Progress", "Completed", "On Hold"])
        })
        
        # Level 2 - Sub-tasks
        for j in range(1, 4):
            sub_wbs_code = f"{wbs_level1}.{j}"
            sub_budget = phase_budget // 3
            
            wbs_items.append({
                "wbs_code": sub_wbs_code,
                "title": f"{phase} - Task {j}",
                "level": 2,
                "budget_allocated": sub_budget,
                "budget_committed": sub_budget * random.uniform(0.6, 1.0),
                "budget_obligated": sub_budget * random.uniform(0.4, 0.8),
                "budget_expended": sub_budget * random.uniform(0.2, 0.6),
                "start_date": (START_DATE + timedelta(days=i*60 + j*10)).strftime("%Y-%m-%d"),
                "end_date": (START_DATE + timedelta(days=i*60 + (j+1)*10)).strftime("%Y-%m-%d"),
                "responsible_manager": f"Lead_{i}_{j}",
                "status": random.choice(["Not Started", "In Progress", "Completed"])
            })
    
    return wbs_items

def generate_personnel_assignments(project_id: str) -> List[Dict[str, Any]]:
    """Generate personnel assignments for a project"""
    global _generated_names_cache
    
    personnel = []
    team_size = random.randint(8, 20)
    
    # Generate realistic names if cache is empty or insufficient
    if len(_generated_names_cache) < team_size:
        new_names = generate_realistic_names(team_size * 2)  # Generate extra for cache
        _generated_names_cache.extend(new_names)
    
    for i in range(team_size):
        labor_cat = random.choice(LABOR_CATEGORIES)
        start_date = START_DATE + timedelta(days=random.randint(0, 180))
        
        # Use realistic name from cache
        name = _generated_names_cache.pop(0) if _generated_names_cache else f"Employee_{i+1:02d}"
        
        personnel.append({
            "project_id": project_id,
            "employee_id": f"EMP_{i+1000:04d}",
            "name": name,
            "labor_category": labor_cat["name"],
            "hourly_rate": labor_cat["rate"],
            "overhead_rate": labor_cat["overhead"],
            "security_clearance": random.choice(["Public Trust", "Secret", "Top Secret", "None"]),
            "start_date": start_date.strftime("%Y-%m-%d"),
            "end_date": (start_date + timedelta(days=random.randint(180, 720))).strftime("%Y-%m-%d"),
            "fte_percentage": random.choice([0.5, 0.75, 1.0]),
            "location": random.choice(["On-site", "Remote", "Hybrid"]),
            "department": random.choice(["Engineering", "Operations", "Security", "Administration"])
        })
    
    return personnel

def generate_spend_plan(project_id: str, total_budget: float) -> List[Dict[str, Any]]:
    """Generate monthly spend plan for a project"""
    spend_plan = []
    project_duration = random.randint(12, 36)  # months
    monthly_budget = total_budget / project_duration
    
    for month in range(project_duration):
        plan_date = START_DATE + timedelta(days=month * 30)
        
        # Add some variance to monthly spending
        monthly_variance = random.uniform(0.7, 1.3)
        planned_amount = monthly_budget * monthly_variance
        
        spend_plan.append({
            "project_id": project_id,
            "period": plan_date.strftime("%Y-%m"),
            "period_type": "Monthly",
            "category": "Total",
            "planned_amount": round(planned_amount, 2),
            "committed_amount": round(planned_amount * random.uniform(0.8, 1.0), 2),
            "obligated_amount": round(planned_amount * random.uniform(0.6, 0.9), 2),
            "forecasted_amount": round(planned_amount * random.uniform(0.9, 1.1), 2),
            "variance_explanation": random.choice([
                "Normal spending pattern", "Increased activity", "Resource constraints",
                "Seasonal adjustment", "Milestone-driven", "Risk mitigation"
            ])
        })
        
        # Add category-specific breakdowns
        for category in EXPENSE_CATEGORIES[:5]:  # Top 5 categories
            category_amount = planned_amount * random.uniform(0.05, 0.3)
            
            spend_plan.append({
                "project_id": project_id,
                "period": plan_date.strftime("%Y-%m"),
                "period_type": "Monthly",
                "category": category,
                "planned_amount": round(category_amount, 2),
                "committed_amount": round(category_amount * random.uniform(0.8, 1.0), 2),
                "obligated_amount": round(category_amount * random.uniform(0.6, 0.9), 2),
                "forecasted_amount": round(category_amount * random.uniform(0.9, 1.1), 2),
                "variance_explanation": f"{category} spending as planned"
            })
    
    return spend_plan

def generate_actuals(project_id: str, total_budget: float) -> List[Dict[str, Any]]:
    """Generate actual spending data for a project"""
    actuals = []
    months_elapsed = random.randint(6, 18)  # Project partially completed
    
    for month in range(months_elapsed):
        actual_date = START_DATE + timedelta(days=month * 30)
        
        # Generate actual spending with some variance from plan
        base_monthly = total_budget / 24  # Assume 24-month projects on average
        actual_amount = base_monthly * random.uniform(0.6, 1.4)
        
        actuals.append({
            "project_id": project_id,
            "period": actual_date.strftime("%Y-%m"),
            "transaction_date": actual_date.strftime("%Y-%m-%d"),
            "category": "Total",
            "actual_amount": round(actual_amount, 2),
            "invoice_number": f"INV-{project_id}-{month+1:03d}",
            "vendor": random.choice(["Prime Contractor", "Subcontractor A", "Subcontractor B", "Internal"]),
            "description": f"Monthly project costs for {actual_date.strftime('%B %Y')}",
            "approval_status": random.choice(["Approved", "Pending", "Reviewed"]),
            "payment_status": random.choice(["Paid", "Pending Payment", "In Process"])
        })
        
        # Add category breakdowns
        for category in EXPENSE_CATEGORIES[:6]:
            category_amount = actual_amount * random.uniform(0.05, 0.25)
            
            actuals.append({
                "project_id": project_id,
                "period": actual_date.strftime("%Y-%m"),
                "transaction_date": actual_date.strftime("%Y-%m-%d"),
                "category": category,
                "actual_amount": round(category_amount, 2),
                "invoice_number": f"INV-{project_id}-{month+1:03d}-{category[:3]}",
                "vendor": random.choice(["Prime Contractor", "Subcontractor A", "Subcontractor B"]),
                "description": f"{category} costs for {actual_date.strftime('%B %Y')}",
                "approval_status": "Approved",
                "payment_status": "Paid"
            })
    
    return actuals

def generate_project_info(project_data: Dict[str, str]) -> Dict[str, Any]:
    """Generate comprehensive project information based on app project data"""
    global _generated_companies_cache
    
    project_id = project_data['id']
    project_name = project_data['name']
    wbs_code = project_data['wbs']
    
    # Generate realistic company name
    if not _generated_companies_cache:
        _generated_companies_cache = generate_company_names(20)
    
    prime_contractor = _generated_companies_cache.pop(0) if _generated_companies_cache else f"Contractor_{random.randint(1, 20):02d} Technologies Inc."
    
    # Generate appropriate budget based on project type
    budget_mapping = {
        'Defense Communications System': (2000000, 8000000),
        'Infrastructure Modernization': (1500000, 6000000),
        'Cybersecurity Enhancement': (1000000, 4000000),
        'Logistics Management System': (1200000, 5000000),
        'Training Platform Development': (800000, 3000000),
        'Data Analytics Platform': (1000000, 4500000),
        'Emergency Response System': (1500000, 6000000),
        'Fleet Management Upgrade': (2000000, 7000000),
        'Facility Security Enhancement': (800000, 3500000),
        'Network Infrastructure Upgrade': (1800000, 7500000)
    }
    
    budget_range = budget_mapping.get(project_name, (500000, 3000000))
    total_budget = random.randint(budget_range[0], budget_range[1])
    
    start_date = START_DATE + timedelta(days=random.randint(0, 365))
    duration_days = random.randint(365, 1095)  # 1-3 years
    
    # Generate detailed project description using LLM
    project_description = generate_project_description(project_name)
    
    # Generate risk explanations using LLM
    risk_explanations = generate_risk_explanations(project_name)
    
    # Generate milestone descriptions using LLM
    milestone_count = random.randint(3, 8)
    milestone_descriptions = generate_milestone_descriptions(project_name, milestone_count)
    
    return {
        "project_id": project_id,
        "project_name": project_name,
        "wbs_code": wbs_code,
        "contract_type": random.choice(CONTRACT_TYPES),
        "contract_number": f"CONTRACT-{project_id}",
        "prime_contractor": prime_contractor,
        "contracting_officer": f"CO_{random.randint(100, 999)}",
        "program_manager": f"PM_{random.randint(100, 999)}",
        "project_description": project_description,
        "total_budget": total_budget,
        "budget_committed": total_budget * random.uniform(0.7, 1.0),
        "budget_obligated": total_budget * random.uniform(0.5, 0.8),
        "budget_expended": total_budget * random.uniform(0.3, 0.7),
        "start_date": start_date.strftime("%Y-%m-%d"),
        "end_date": (start_date + timedelta(days=duration_days)).strftime("%Y-%m-%d"),
        "current_phase": random.choice(["Planning", "Development", "Testing", "Deployment", "Operations"]),
        "status": random.choice(["Active", "On Hold", "Completed", "Cancelled"]),
        "priority": random.choice(["High", "Medium", "Low"]),
        "security_classification": random.choice(["Unclassified", "Confidential", "Secret"]),
        "location": random.choice(["Washington DC", "Virginia", "Maryland", "Remote", "Multiple Sites"]),
        "performance_metrics": {
            "schedule_performance_index": round(random.uniform(0.8, 1.2), 2),
            "cost_performance_index": round(random.uniform(0.85, 1.15), 2),
            "quality_score": round(random.uniform(3.5, 5.0), 1),
            "customer_satisfaction": round(random.uniform(3.0, 5.0), 1)
        },
        "risk_assessment": {
            "overall_risk": random.choice(RISK_LEVELS),
            "schedule_risk": random.choice(RISK_LEVELS),
            "budget_risk": random.choice(RISK_LEVELS),
            "technical_risk": random.choice(RISK_LEVELS),
            "schedule_risk_explanation": risk_explanations.get('schedule_risk', 'Standard project timeline considerations'),
            "budget_risk_explanation": risk_explanations.get('budget_risk', 'Normal budget variance expectations'),
            "technical_risk_explanation": risk_explanations.get('technical_risk', 'Standard technical implementation risks'),
            "last_updated": datetime.now().strftime("%Y-%m-%d")
        },
        "milestones": [
            {
                "milestone_id": f"M{i+1}",
                "name": milestone_descriptions[i] if i < len(milestone_descriptions) else f"Milestone {i+1}",
                "planned_date": (start_date + timedelta(days=i*100)).strftime("%Y-%m-%d"),
                "actual_date": (start_date + timedelta(days=i*100 + random.randint(-10, 10))).strftime("%Y-%m-%d"),
                "status": random.choice(["Completed", "In Progress", "Pending", "Delayed"])
            }
            for i in range(milestone_count)
        ]
    }

def generate_financial_analysis(project_id: str, project_info: Dict[str, Any]) -> Dict[str, Any]:
    """Generate financial analysis and recommendations"""
    burn_rate = project_info["budget_expended"] / 12  # Monthly burn rate
    remaining_budget = project_info["total_budget"] - project_info["budget_expended"]
    
    return {
        "project_id": project_id,
        "analysis_date": datetime.now().strftime("%Y-%m-%d"),
        "financial_summary": {
            "total_budget": project_info["total_budget"],
            "expended_to_date": project_info["budget_expended"],
            "remaining_budget": remaining_budget,
            "burn_rate_monthly": round(burn_rate, 2),
            "projected_completion_cost": round(project_info["budget_expended"] * 1.1, 2),
            "budget_variance": round(remaining_budget - (project_info["total_budget"] * 0.3), 2)
        },
        "trends": {
            "spending_trend": random.choice(["Increasing", "Stable", "Decreasing"]),
            "budget_utilization": round(project_info["budget_expended"] / project_info["total_budget"], 2),
            "forecast_accuracy": round(random.uniform(0.85, 0.98), 2)
        },
        "recommendations": [
            "Monitor spending patterns closely in Q4",
            "Consider resource reallocation for critical path activities",
            "Implement cost control measures for travel expenses",
            "Review contractor performance metrics",
            "Optimize resource utilization across work packages"
        ],
        "alerts": [
            {
                "type": "Budget",
                "severity": random.choice(["Low", "Medium", "High"]),
                "message": "Budget utilization is above planned trajectory",
                "action_required": "Review spending patterns and adjust forecast"
            },
            {
                "type": "Schedule",
                "severity": random.choice(["Low", "Medium"]),
                "message": "Milestone delivery dates may be at risk",
                "action_required": "Assess critical path and resource allocation"
            }
        ]
    }

def create_output_directory():
    """Create output directory structure"""
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
    
    subdirs = ["projects", "personnel", "financials", "wbs", "reports"]
    for subdir in subdirs:
        path = os.path.join(OUTPUT_DIR, subdir)
        if not os.path.exists(path):
            os.makedirs(path)

def save_data_as_json(data: Any, filename: str, subdir: str = ""):
    """Save data as JSON file"""
    if subdir:
        filepath = os.path.join(OUTPUT_DIR, subdir, filename)
    else:
        filepath = os.path.join(OUTPUT_DIR, filename)
    
    try:
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False, default=str)
    except Exception as e:
        print(f"Error saving {filepath}: {e}")
        # Try to save with string conversion for datetime objects
        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False, default=str)
        except Exception as e2:
            print(f"Failed to save {filepath} even with string conversion: {e2}")
            raise

def save_data_as_csv(data: List[Dict], filename: str, subdir: str = ""):
    """Save data as CSV file"""
    if not data:
        return
    
    if subdir:
        filepath = os.path.join(OUTPUT_DIR, subdir, filename)
    else:
        filepath = os.path.join(OUTPUT_DIR, filename)
    
    with open(filepath, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=data[0].keys())
        writer.writeheader()
        writer.writerows(data)

def generate_all_project_data():
    """Generate all project data and save to files"""
    print("Generating fictional government contract project data with LLM enhancement...")
    print("This may take a few minutes due to LLM API calls...")
    
    create_output_directory()
    
    # Pre-generate some content to improve efficiency
    print("Pre-generating realistic names and company names...")
    global _generated_names_cache, _generated_companies_cache
    _generated_names_cache = generate_realistic_names(200)  # Generate plenty for all projects
    _generated_companies_cache = generate_company_names(50)  # Generate company names
    
    all_projects = []
    all_personnel = []
    all_spend_plans = []
    all_actuals = []
    all_wbs = []
    all_analyses = []
    
    for i, project_data in enumerate(APP_PROJECTS):
        project_id = project_data['id']
        project_name = project_data['name']
        wbs_code = project_data['wbs']
        
        print(f"Generating data for project {i+1}/{len(APP_PROJECTS)}: {project_id} - {project_name}")
        print("  - Generating project details with LLM...")
        
        # Generate project info
        project_info = generate_project_info(project_data)
        all_projects.append(project_info)
        
        print("  - Generating WBS structure...")
        # Generate WBS with project-specific phases
        wbs_items = generate_wbs_structure(project_name, wbs_code)
        for item in wbs_items:
            item["project_id"] = project_id
        all_wbs.extend(wbs_items)
        
        print("  - Generating personnel assignments...")
        # Generate personnel
        personnel = generate_personnel_assignments(project_id)
        all_personnel.extend(personnel)
        
        print("  - Generating financial data...")
        # Generate spend plans
        spend_plan = generate_spend_plan(project_id, project_info["total_budget"])
        all_spend_plans.extend(spend_plan)
        
        # Generate actuals
        actuals = generate_actuals(project_id, project_info["total_budget"])
        all_actuals.extend(actuals)
        
        # Generate financial analysis
        analysis = generate_financial_analysis(project_id, project_info)
        all_analyses.append(analysis)
        
        print("  - Saving individual project files...")
        # Save individual project files
        save_data_as_json(project_info, f"{project_id}_info.json", "projects")
        save_data_as_json(wbs_items, f"{project_id}_wbs.json", "projects")
        save_data_as_json(personnel, f"{project_id}_personnel.json", "personnel")
        save_data_as_json(spend_plan, f"{project_id}_spend_plan.json", "financials")
        save_data_as_json(actuals, f"{project_id}_actuals.json", "financials")
        save_data_as_json(analysis, f"{project_id}_analysis.json", "reports")
        
        print(f"  ✓ Completed {project_id}")
    
    # Save consolidated files
    print("\nSaving consolidated data files...")
    save_data_as_json(all_projects, "all_projects.json")
    save_data_as_json(all_personnel, "all_personnel.json")
    save_data_as_json(all_spend_plans, "all_spend_plans.json")
    save_data_as_json(all_actuals, "all_actuals.json")
    save_data_as_json(all_wbs, "all_wbs.json")
    save_data_as_json(all_analyses, "all_analyses.json")
    
    # Save as CSV for easy import
    print("Saving CSV files...")
    save_data_as_csv(all_projects, "projects.csv")
    save_data_as_csv(all_personnel, "personnel.csv")
    save_data_as_csv(all_spend_plans, "spend_plans.csv")
    save_data_as_csv(all_actuals, "actuals.csv")
    save_data_as_csv(all_wbs, "wbs.csv")
    
    print(f"\n✓ Data generation complete!")
    print(f"Generated {len(all_projects)} projects with LLM-enhanced content")
    print(f"Generated {len(all_personnel)} personnel assignments with realistic names")
    print(f"Generated {len(all_spend_plans)} spend plan entries")
    print(f"Generated {len(all_actuals)} actual spending entries")
    print(f"Generated {len(all_wbs)} WBS items")
    print(f"Data saved to: {OUTPUT_DIR}/")
    
    # Print project summary
    print("\nProject Summary:")
    for project in all_projects:
        print(f"  {project['project_id']}: {project['project_name']}")
        print(f"    WBS Code: {project['wbs_code']}")
        print(f"    Budget: ${project['total_budget']:,}")
        print(f"    Contractor: {project['prime_contractor']}")
        print(f"    Status: {project['status']}")
        print()

if __name__ == "__main__":
    generate_all_project_data()
