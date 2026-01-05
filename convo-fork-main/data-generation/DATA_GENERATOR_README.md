# Government Contract Project Data Generator

This directory contains Python scripts to generate comprehensive fictional government contract project data for testing and development of RAG (Retrieval-Augmented Generation) systems.

## Scripts

### 1. `generate_project_data.py`
Generates comprehensive fictional government contract project data including:
- Project information and metadata
- Work Breakdown Structure (WBS) 
- Personnel assignments and labor categories
- Financial spend plans and actuals
- Performance metrics and risk assessments
- Financial analysis and recommendations

### 2. `format_for_rag.py`
Converts the generated project data into RAG-optimized documents suitable for indexing in Azure Cognitive Search. Creates searchable documents with:
- Project summaries
- Financial analysis documents
- WBS structure documents
- Personnel assignment documents
- Analysis and recommendations documents

## Usage

### Step 1: Generate Project Data
```bash
python generate_project_data.py
```

This creates a `generated_project_data/` directory with:
- Individual project files (JSON format)
- Consolidated data files (JSON and CSV formats)
- Organized subdirectories for different data types

### Step 2: Format for RAG
```bash
python format_for_rag.py
```

This creates a `rag_documents/` directory with:
- RAG-optimized documents in JSON format
- Individual document files
- Bulk import file (`rag_documents.json`)

### Step 3: Import to Azure Cognitive Search
Use the documents in `rag_documents/` to populate your Azure Cognitive Search index. The documents are structured with:
- `id`: Unique document identifier
- `project_id`: Project reference
- `document_type`: Type of document (project_summary, financial_analysis, etc.)
- `title`: Document title
- `content`: Full searchable text content
- `metadata`: Structured metadata for filtering
- `keywords`: Search keywords
- `last_updated`: Timestamp

## Generated Data Structure

### Projects (10 fictional projects)
- Aligned with React app project definitions
- Various contract types (FFP, CPFF, T&M, etc.)
- Budget ranges from $500K to $10M
- Multiple phases and statuses

### Financial Data
- Monthly/quarterly spend plans
- Actual expenditure records
- Budget allocations by category
- Variance analysis
- Burn rate calculations

### Personnel
- 8-20 team members per project
- Realistic labor categories and rates
- Security clearance levels
- FTE assignments

### WBS Structure
- Hierarchical work breakdown
- Budget allocation by work package
- Timeline and milestone tracking
- Responsible manager assignments

### Performance Metrics
- Schedule Performance Index (SPI)
- Cost Performance Index (CPI)
- Quality scores
- Risk assessments

## Configuration

Edit the configuration variables at the top of `generate_project_data.py`:
- `NUM_PROJECTS`: Number of projects to generate (default: 10)
- `OUTPUT_DIR`: Output directory name
- `START_DATE` / `END_DATE`: Date range for project timelines

## Data Quality

The generated data includes:
- Realistic government contract terminology
- Appropriate financial relationships (committed > obligated > expended)
- Logical timeline progressions
- Consistent project hierarchies
- Realistic variance patterns
- Project-specific WBS structures and descriptions

## File Formats

### JSON Files
- Structured data for programmatic access
- Nested objects for complex relationships
- Metadata for filtering and searching

### CSV Files
- Flat format for database import
- Excel-compatible for manual analysis
- Suitable for reporting tools

## Azure Cognitive Search Integration

The formatted RAG documents are optimized for:
- Full-text search across all content
- Metadata filtering by project, status, budget, etc.
- Keyword-based retrieval
- Semantic search capabilities

### Recommended Index Schema
```json
{
  "fields": [
    {"name": "id", "type": "Edm.String", "key": true},
    {"name": "project_id", "type": "Edm.String", "filterable": true},
    {"name": "document_type", "type": "Edm.String", "filterable": true},
    {"name": "title", "type": "Edm.String", "searchable": true},
    {"name": "content", "type": "Edm.String", "searchable": true},
    {"name": "keywords", "type": "Collection(Edm.String)", "searchable": true},
    {"name": "last_updated", "type": "Edm.DateTimeOffset", "filterable": true}
  ]
}
```

## Sample Queries

Once indexed, you can test queries like:
- "What is the budget status for project PROJ-001?"
- "Show me all projects with high schedule risk"
- "Find projects with budget variance over 10%"
- "List all personnel with Top Secret clearance"
- "What are the recommendations for cost optimization?"
- "Show me the WBS structure for the Data Analytics Platform"

## Dependencies

The scripts use:

### External Dependencies (install via pip):
- `openai` - OpenAI API client for LLM generation
- `python-dotenv` - Environment variable management

### Python Standard Library:
- `json` - JSON data handling
- `random` - Random data generation
- `csv` - CSV file operations
- `datetime` - Date/time handling
- `typing` - Type hints
- `os` - File system operations

Install external dependencies with: `pip install -r requirements.txt`
