#!/usr/bin/env python3
"""
RAG Data Formatter for Azure Cognitive Search

This script takes the generated project data and formats it into documents
suitable for indexing in Azure Cognitive Search for RAG (Retrieval-Augmented Generation).
Each document will be structured to provide comprehensive context for financial queries.
"""

import json
import os
from datetime import datetime
from typing import Dict, List, Any

INPUT_DIR = "generated_project_data"
OUTPUT_DIR = "rag_documents"

def create_project_summary_document(project_info: Dict[str, Any]) -> Dict[str, Any]:
    """Create a comprehensive project summary document for RAG indexing"""
    project_id = project_info["project_id"]
    
    # Create a searchable text summary
    summary_text = f"""
    PROJECT SUMMARY - {project_info['project_name']} ({project_id})
    
    WBS Code: {project_info['wbs_code']}
    Contract Type: {project_info['contract_type']}
    Contract Number: {project_info['contract_number']}
    Prime Contractor: {project_info['prime_contractor']}
    Contracting Officer: {project_info['contracting_officer']}
    Program Manager: {project_info['program_manager']}
    
    FINANCIAL OVERVIEW:
    Total Budget: ${project_info['total_budget']:,.2f}
    Budget Committed: ${project_info['budget_committed']:,.2f}
    Budget Obligated: ${project_info['budget_obligated']:,.2f}
    Budget Expended: ${project_info['budget_expended']:,.2f}
    Remaining Budget: ${project_info['total_budget'] - project_info['budget_expended']:,.2f}
    
    SCHEDULE:
    Start Date: {project_info['start_date']}
    End Date: {project_info['end_date']}
    Current Phase: {project_info['current_phase']}
    Status: {project_info['status']}
    Priority: {project_info['priority']}
    
    PERFORMANCE METRICS:
    Schedule Performance Index: {project_info['performance_metrics']['schedule_performance_index']}
    Cost Performance Index: {project_info['performance_metrics']['cost_performance_index']}
    Quality Score: {project_info['performance_metrics']['quality_score']}/5.0
    Customer Satisfaction: {project_info['performance_metrics']['customer_satisfaction']}/5.0
    
    RISK ASSESSMENT:
    Overall Risk: {project_info['risk_assessment']['overall_risk']}
    Schedule Risk: {project_info['risk_assessment']['schedule_risk']}
    Budget Risk: {project_info['risk_assessment']['budget_risk']}
    Technical Risk: {project_info['risk_assessment']['technical_risk']}
    
    DESCRIPTION:
    {project_info['project_description']}
    
    LOCATION: {project_info['location']}
    SECURITY CLASSIFICATION: {project_info['security_classification']}
    """
    
    return {
        "id": f"{project_id}_summary",
        "project_id": project_id,
        "document_type": "project_summary",
        "title": f"Project Summary - {project_info['project_name']}",
        "content": summary_text.strip(),
        "metadata": {
            "wbs_code": project_info["wbs_code"],
            "contract_type": project_info["contract_type"],
            "status": project_info["status"],
            "priority": project_info["priority"],
            "total_budget": project_info["total_budget"],
            "current_phase": project_info["current_phase"],
            "start_date": project_info["start_date"],
            "end_date": project_info["end_date"]
        },
        "keywords": [
            project_info["project_name"],
            project_info["wbs_code"],
            project_info["contract_type"],
            project_info["current_phase"],
            project_info["prime_contractor"],
            "budget", "financial", "contract", "project"
        ],
        "last_updated": datetime.now().isoformat()
    }

def create_financial_document(project_id: str, spend_plans: List[Dict], actuals: List[Dict]) -> Dict[str, Any]:
    """Create a financial analysis document combining spend plans and actuals"""
    
    # Calculate financial summaries
    total_planned = sum(item["planned_amount"] for item in spend_plans if item["category"] == "Total")
    total_actual = sum(item["actual_amount"] for item in actuals if item["category"] == "Total")
    
    # Group by category
    planned_by_category = {}
    actual_by_category = {}
    
    for item in spend_plans:
        if item["category"] != "Total":
            if item["category"] not in planned_by_category:
                planned_by_category[item["category"]] = 0
            planned_by_category[item["category"]] += item["planned_amount"]
    
    for item in actuals:
        if item["category"] != "Total":
            if item["category"] not in actual_by_category:
                actual_by_category[item["category"]] = 0
            actual_by_category[item["category"]] += item["actual_amount"]
    
    # Create financial analysis text
    financial_text = f"""
    FINANCIAL ANALYSIS - PROJECT {project_id}
    
    BUDGET SUMMARY:
    Total Planned: ${total_planned:,.2f}
    Total Actual: ${total_actual:,.2f}
    Variance: ${total_actual - total_planned:,.2f}
    Variance %: {((total_actual - total_planned) / total_planned * 100) if total_planned > 0 else 0:.1f}%
    
    SPENDING BY CATEGORY (PLANNED vs ACTUAL):
    """
    
    all_categories = set(planned_by_category.keys()) | set(actual_by_category.keys())
    for category in sorted(all_categories):
        planned = planned_by_category.get(category, 0)
        actual = actual_by_category.get(category, 0)
        variance = actual - planned
        financial_text += f"\n{category}:\n"
        financial_text += f"  Planned: ${planned:,.2f}\n"
        financial_text += f"  Actual: ${actual:,.2f}\n"
        financial_text += f"  Variance: ${variance:,.2f}\n"
    
    # Add recent spending patterns
    recent_actuals = sorted(actuals, key=lambda x: x["transaction_date"], reverse=True)[:10]
    if recent_actuals:
        financial_text += f"\nRECENT TRANSACTIONS:\n"
        for transaction in recent_actuals:
            financial_text += f"Date: {transaction['transaction_date']}, Amount: ${transaction['actual_amount']:,.2f}, Category: {transaction['category']}, Status: {transaction['payment_status']}\n"
    
    return {
        "id": f"{project_id}_financial",
        "project_id": project_id,
        "document_type": "financial_analysis",
        "title": f"Financial Analysis - {project_id}",
        "content": financial_text.strip(),
        "metadata": {
            "total_planned": total_planned,
            "total_actual": total_actual,
            "variance": total_actual - total_planned,
            "variance_percentage": ((total_actual - total_planned) / total_planned * 100) if total_planned > 0 else 0
        },
        "keywords": [
            "financial", "budget", "spending", "actuals", "variance", 
            "cost analysis", "expenses", "burn rate"
        ],
        "last_updated": datetime.now().isoformat()
    }

def create_wbs_document(project_id: str, wbs_items: List[Dict]) -> Dict[str, Any]:
    """Create a Work Breakdown Structure document"""
    
    wbs_text = f"""
    WORK BREAKDOWN STRUCTURE - PROJECT {project_id}
    
    WBS HIERARCHY AND FINANCIAL STATUS:
    """
    
    # Sort WBS items by code
    sorted_wbs = sorted(wbs_items, key=lambda x: x["wbs_code"])
    
    for item in sorted_wbs:
        indent = "  " * (item["level"] - 1)
        utilization = (item["budget_expended"] / item["budget_allocated"] * 100) if item["budget_allocated"] > 0 else 0
        
        wbs_text += f"""
{indent}{item['wbs_code']} - {item['title']}
{indent}  Budget Allocated: ${item['budget_allocated']:,.2f}
{indent}  Budget Committed: ${item['budget_committed']:,.2f}
{indent}  Budget Obligated: ${item['budget_obligated']:,.2f}
{indent}  Budget Expended: ${item['budget_expended']:,.2f}
{indent}  Utilization: {utilization:.1f}%
{indent}  Status: {item['status']}
{indent}  Start Date: {item['start_date']}
{indent}  End Date: {item['end_date']}
{indent}  Manager: {item['responsible_manager']}
        """
    
    return {
        "id": f"{project_id}_wbs",
        "project_id": project_id,
        "document_type": "wbs_structure",
        "title": f"Work Breakdown Structure - {project_id}",
        "content": wbs_text.strip(),
        "metadata": {
            "wbs_items_count": len(wbs_items),
            "total_wbs_budget": sum(item["budget_allocated"] for item in wbs_items if item["level"] == 1)
        },
        "keywords": [
            "wbs", "work breakdown structure", "tasks", "milestones", 
            "project structure", "deliverables", "work packages"
        ],
        "last_updated": datetime.now().isoformat()
    }

def create_personnel_document(project_id: str, personnel: List[Dict]) -> Dict[str, Any]:
    """Create a personnel assignment document"""
    
    personnel_text = f"""
    PERSONNEL ASSIGNMENTS - PROJECT {project_id}
    
    TEAM COMPOSITION:
    Total Team Members: {len(personnel)}
    
    PERSONNEL DETAILS:
    """
    
    # Group by labor category
    by_category = {}
    for person in personnel:
        category = person["labor_category"]
        if category not in by_category:
            by_category[category] = []
        by_category[category].append(person)
    
    total_cost = 0
    for category, members in by_category.items():
        personnel_text += f"\n{category} ({len(members)} members):\n"
        category_cost = 0
        
        for member in members:
            annual_cost = member["hourly_rate"] * 2080 * member["fte_percentage"]  # 2080 hours per year
            category_cost += annual_cost
            personnel_text += f"  {member['name']} - Rate: ${member['hourly_rate']:.2f}/hr, FTE: {member['fte_percentage']}, Clearance: {member['security_clearance']}\n"
        
        personnel_text += f"  Category Total Annual Cost: ${category_cost:,.2f}\n"
        total_cost += category_cost
    
    personnel_text += f"\nTOTAL ANNUAL PERSONNEL COST: ${total_cost:,.2f}\n"
    
    # Add security clearance summary
    clearance_counts = {}
    for person in personnel:
        clearance = person["security_clearance"]
        clearance_counts[clearance] = clearance_counts.get(clearance, 0) + 1
    
    personnel_text += f"\nSECURITY CLEARANCE DISTRIBUTION:\n"
    for clearance, count in clearance_counts.items():
        personnel_text += f"{clearance}: {count} personnel\n"
    
    return {
        "id": f"{project_id}_personnel",
        "project_id": project_id,
        "document_type": "personnel_assignments",
        "title": f"Personnel Assignments - {project_id}",
        "content": personnel_text.strip(),
        "metadata": {
            "total_personnel": len(personnel),
            "annual_personnel_cost": total_cost,
            "labor_categories": list(by_category.keys())
        },
        "keywords": [
            "personnel", "team", "staff", "labor", "resources", 
            "clearance", "assignments", "human resources"
        ],
        "last_updated": datetime.now().isoformat()
    }

def create_analysis_document(analysis: Dict[str, Any]) -> Dict[str, Any]:
    """Create a financial analysis and recommendations document"""
    
    project_id = analysis["project_id"]
    fs = analysis["financial_summary"]
    trends = analysis["trends"]
    
    analysis_text = f"""
    FINANCIAL ANALYSIS AND RECOMMENDATIONS - PROJECT {project_id}
    
    EXECUTIVE SUMMARY:
    Analysis Date: {analysis['analysis_date']}
    
    FINANCIAL HEALTH:
    Total Budget: ${fs['total_budget']:,.2f}
    Expended to Date: ${fs['expended_to_date']:,.2f}
    Remaining Budget: ${fs['remaining_budget']:,.2f}
    Monthly Burn Rate: ${fs['burn_rate_monthly']:,.2f}
    Projected Completion Cost: ${fs['projected_completion_cost']:,.2f}
    Budget Variance: ${fs['budget_variance']:,.2f}
    
    TRENDS:
    Spending Trend: {trends['spending_trend']}
    Budget Utilization: {trends['budget_utilization']:.1%}
    Forecast Accuracy: {trends['forecast_accuracy']:.1%}
    
    RECOMMENDATIONS:
    """
    
    for i, rec in enumerate(analysis["recommendations"], 1):
        analysis_text += f"{i}. {rec}\n"
    
    analysis_text += f"\nALERTS AND ACTION ITEMS:\n"
    for alert in analysis["alerts"]:
        analysis_text += f"[{alert['severity']}] {alert['type']}: {alert['message']}\n"
        analysis_text += f"Action Required: {alert['action_required']}\n\n"
    
    return {
        "id": f"{project_id}_analysis",
        "project_id": project_id,
        "document_type": "financial_analysis",
        "title": f"Financial Analysis and Recommendations - {project_id}",
        "content": analysis_text.strip(),
        "metadata": {
            "analysis_date": analysis["analysis_date"],
            "budget_utilization": trends["budget_utilization"],
            "spending_trend": trends["spending_trend"],
            "total_budget": fs["total_budget"],
            "remaining_budget": fs["remaining_budget"]
        },
        "keywords": [
            "analysis", "recommendations", "financial health", "trends", 
            "alerts", "performance", "forecast", "budget utilization"
        ],
        "last_updated": datetime.now().isoformat()
    }

def load_project_data():
    """Load all generated project data"""
    print("Loading generated project data...")
    
    # Load main data files
    with open(os.path.join(INPUT_DIR, "all_projects.json"), 'r') as f:
        projects = json.load(f)
    
    with open(os.path.join(INPUT_DIR, "all_spend_plans.json"), 'r') as f:
        spend_plans = json.load(f)
    
    with open(os.path.join(INPUT_DIR, "all_actuals.json"), 'r') as f:
        actuals = json.load(f)
    
    with open(os.path.join(INPUT_DIR, "all_wbs.json"), 'r') as f:
        wbs_items = json.load(f)
    
    with open(os.path.join(INPUT_DIR, "all_personnel.json"), 'r') as f:
        personnel = json.load(f)
    
    with open(os.path.join(INPUT_DIR, "all_analyses.json"), 'r') as f:
        analyses = json.load(f)
    
    return projects, spend_plans, actuals, wbs_items, personnel, analyses

def create_rag_documents():
    """Create RAG-optimized documents from generated data"""
    print("Creating RAG-optimized documents...")
    
    # Create output directory
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
    
    # Load data
    projects, spend_plans, actuals, wbs_items, personnel, analyses = load_project_data()
    
    all_documents = []
    
    # Group data by project
    spend_plans_by_project = {}
    actuals_by_project = {}
    wbs_by_project = {}
    personnel_by_project = {}
    analyses_by_project = {}
    
    for item in spend_plans:
        pid = item["project_id"]
        if pid not in spend_plans_by_project:
            spend_plans_by_project[pid] = []
        spend_plans_by_project[pid].append(item)
    
    for item in actuals:
        pid = item["project_id"]
        if pid not in actuals_by_project:
            actuals_by_project[pid] = []
        actuals_by_project[pid].append(item)
    
    for item in wbs_items:
        pid = item["project_id"]
        if pid not in wbs_by_project:
            wbs_by_project[pid] = []
        wbs_by_project[pid].append(item)
    
    for item in personnel:
        pid = item["project_id"]
        if pid not in personnel_by_project:
            personnel_by_project[pid] = []
        personnel_by_project[pid].append(item)
    
    for item in analyses:
        pid = item["project_id"]
        analyses_by_project[pid] = item
    
    # Create documents for each project
    for project in projects:
        project_id = project["project_id"]
        print(f"Creating RAG documents for {project_id}...")
        
        # Create project summary document
        summary_doc = create_project_summary_document(project)
        all_documents.append(summary_doc)
        
        # Create financial document
        if project_id in spend_plans_by_project and project_id in actuals_by_project:
            financial_doc = create_financial_document(
                project_id, 
                spend_plans_by_project[project_id], 
                actuals_by_project[project_id]
            )
            all_documents.append(financial_doc)
        
        # Create WBS document
        if project_id in wbs_by_project:
            wbs_doc = create_wbs_document(project_id, wbs_by_project[project_id])
            all_documents.append(wbs_doc)
        
        # Create personnel document
        if project_id in personnel_by_project:
            personnel_doc = create_personnel_document(project_id, personnel_by_project[project_id])
            all_documents.append(personnel_doc)
        
        # Create analysis document
        if project_id in analyses_by_project:
            analysis_doc = create_analysis_document(analyses_by_project[project_id])
            all_documents.append(analysis_doc)
    
    # Save all documents
    print(f"Saving {len(all_documents)} RAG documents...")
    
    # Save as one large JSON file for bulk import
    with open(os.path.join(OUTPUT_DIR, "rag_documents.json"), 'w') as f:
        json.dump(all_documents, f, indent=2)
    
    # Save individual documents
    for doc in all_documents:
        filename = f"{doc['id']}.json"
        with open(os.path.join(OUTPUT_DIR, filename), 'w') as f:
            json.dump(doc, f, indent=2)
    
    print(f"RAG documents created successfully!")
    print(f"Total documents: {len(all_documents)}")
    print(f"Documents saved to: {OUTPUT_DIR}/")
    
    # Create summary report
    doc_types = {}
    for doc in all_documents:
        doc_type = doc["document_type"]
        doc_types[doc_type] = doc_types.get(doc_type, 0) + 1
    
    print("\nDocument types created:")
    for doc_type, count in doc_types.items():
        print(f"  {doc_type}: {count}")

if __name__ == "__main__":
    if not os.path.exists(INPUT_DIR):
        print(f"Error: Input directory '{INPUT_DIR}' not found.")
        print("Please run generate_project_data.py first to create the project data.")
        exit(1)
    
    create_rag_documents()
